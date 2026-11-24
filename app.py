"""
Mirai Voice Studio - バックエンドサーバー
1. クローン音声によるテキスト読み上げ (TTS)
2. Gemini API を使った「人格コピーAI」との音声対話 (Chat + TTS)

起動:
  python app.py                 # http://127.0.0.1:5000 が自動で開きます
"""

import argparse
import base64
import os
import re
import threading
import time
import webbrowser
from pathlib import Path

import httpx
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory
from fishaudio import FishAudio
from fishaudio.exceptions import (
    APIError,
    AuthenticationError,
    FishAudioError,
    NotFoundError,
    RateLimitError,
)
from datetime import datetime
from fishaudio.types import TTSConfig

from voice_clone import BASE_DIR, DEFAULT_MODEL, load_voices, resolve_voice_id, save_voices
from persona_manager import (
    bind_line_user_to_persona,
    create_persona,
    delete_persona,
    find_persona_by_query,
    format_persona_list_for_line,
    get_default_line_persona_id,
    get_persona,
    get_persona_id_for_line_user,
    list_personas,
    load_line_user_persona_map,
    save_persona_text as pm_save_persona_text,
    set_default_line_persona_id,
)

load_dotenv(BASE_DIR / ".env")

WEB_DIR = BASE_DIR / "web"
VOICE_SAMPLES_DIR = BASE_DIR / "voice_samples"
VOICE_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
PERSONA_FILE = BASE_DIR / "persona.txt"
MAX_TEXT_LENGTH = 1000
SPEED_RANGE = (0.5, 2.0)

_voice_sample_cache: dict[str, bytes] = {}


def _save_voice_sample_wav(voice_name: str, raw_audio_bytes: bytes, input_ext: str = ".webm") -> str:
    """アップロードまたは録音された音声を Gemini ReplicatedVoice 用の 24kHz 16-bit PCM mono WAV (最大25秒) として保存"""
    import subprocess
    import imageio_ffmpeg
    safe_stem = re.sub(r'[\\/:*?"<>|]', "_", voice_name)
    out_filename = f"{safe_stem}.wav"
    out_path = VOICE_SAMPLES_DIR / out_filename
    tmp_in = VOICE_SAMPLES_DIR / f"tmp_{int(time.time() * 1000)}{input_ext or '.webm'}"
    try:
        tmp_in.write_bytes(raw_audio_bytes)
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run(
            [
                ffmpeg_exe,
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(tmp_in),
                "-t",
                "25",
                "-ar",
                "24000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                str(out_path),
            ],
            check=True,
        )
        _voice_sample_cache[voice_name] = out_path.read_bytes()
        return out_filename
    finally:
        if tmp_in.exists():
            try:
                tmp_in.unlink()
            except Exception:
                pass


def get_voice_sample_wav_bytes(voice_name: str) -> bytes | None:
    """指定された声のサンプルWAVバイト列を取得（キャッシュ付き・既存音声からの自動変換対応）"""
    if voice_name in _voice_sample_cache:
        return _voice_sample_cache[voice_name]

    voices = load_voices()
    v_info = voices.get(voice_name) or {}
    sample_wav = v_info.get("sample_wav", "")
    if sample_wav and (VOICE_SAMPLES_DIR / sample_wav).exists():
        b = (VOICE_SAMPLES_DIR / sample_wav).read_bytes()
        _voice_sample_cache[voice_name] = b
        return b

    safe_stem = re.sub(r'[\\/:*?"<>|]', "_", voice_name)
    candidate_wav = VOICE_SAMPLES_DIR / f"{safe_stem}.wav"
    if candidate_wav.exists():
        b = candidate_wav.read_bytes()
        _voice_sample_cache[voice_name] = b
        return b

    # 既存の source ファイル (例: test.mp3) が BASE_DIR にあれば自動変換
    src_name = v_info.get("source", "")
    if src_name and (BASE_DIR / src_name).exists():
        try:
            raw_b = (BASE_DIR / src_name).read_bytes()
            ext = Path(src_name).suffix.lower() or ".mp3"
            _save_voice_sample_wav(voice_name, raw_b, ext)
            return _voice_sample_cache.get(voice_name)
        except Exception as e:
            print(f"[WARN] サンプル音声変換失敗 ({voice_name}): {e}", flush=True)

    # すでに Fish Audio に登録済みの声でローカルWAVが未保存の場合は、1回だけサンプル音声を生成して保存
    fish_id = v_info.get("id", "")
    if fish_id and not fish_id.startswith("gemini_local:"):
        try:
            fish_client = get_fish_client()
            ref_audio = fish_client.tts.convert(
                text="こんにちは！今日は来てくれてありがとう。普段は好きなことをしたり、おいしいものを食べたりして過ごしてるよ。なんでも気軽に話しかけてね。",
                reference_id=fish_id,
                config=TTSConfig(format="mp3", latency="balanced"),
                model=DEFAULT_MODEL,
            )
            if not isinstance(ref_audio, bytes):
                ref_audio = b"".join(ref_audio)
            saved_wav = _save_voice_sample_wav(voice_name, ref_audio, ".mp3")
            v_info["sample_wav"] = saved_wav
            voices[voice_name] = v_info
            save_voices(voices)
            return _voice_sample_cache.get(voice_name)
        except Exception as e:
            print(f"[WARN] Fish Audio からのサンプル音声復元失敗 ({voice_name}): {e}", flush=True)
    return None

app = Flask(__name__)

_fish_client: FishAudio | None = None
_fish_lock = threading.Lock()
_gemini_client = None
_gemini_client_key: str | None = None
_gemini_lock = threading.Lock()


def get_fish_client() -> FishAudio:
    """FishAudio クライアントを取得"""
    global _fish_client
    with _fish_lock:
        if _fish_client is None:
            _fish_client = FishAudio()
        return _fish_client


def get_gemini_api_key() -> str | None:
    # 実行時に環境変数を再読み込み（.env および env の両方の変更を反映できるように）
    env_dot = BASE_DIR / ".env"
    env_plain = BASE_DIR / "env"
    if env_dot.exists() and env_plain.exists():
        # 新しく編集された方を優先して後から読み込む
        if env_plain.stat().st_mtime >= env_dot.stat().st_mtime:
            load_dotenv(env_dot, override=True)
            load_dotenv(env_plain, override=True)
        else:
            load_dotenv(env_plain, override=True)
            load_dotenv(env_dot, override=True)
    elif env_plain.exists():
        load_dotenv(env_plain, override=True)
    else:
        load_dotenv(env_dot, override=True)
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    return key if key else None


def get_gemini_client(api_key: str, force_vertexai: bool = False):
    """Gemini クライアントをシングルトンとして再利用（毎回のTLSハンドシェイク遅延を削減）"""
    global _gemini_client, _gemini_client_key
    cache_tag = f"{api_key}|v={force_vertexai}"
    with _gemini_lock:
        if _gemini_client is None or _gemini_client_key != cache_tag:
            from google import genai
            if force_vertexai:
                _gemini_client = genai.Client(vertexai=True, api_key=api_key)
            else:
                _gemini_client = genai.Client(api_key=api_key)
            _gemini_client_key = cache_tag
        return _gemini_client


def load_persona_text(person_id: str = "taku") -> str:
    p_data = get_persona(person_id)
    if p_data and p_data.get("content"):
        return p_data["content"]
    if PERSONA_FILE.exists():
        return PERSONA_FILE.read_text(encoding="utf-8")
    return (
        "あなたは親しい友人です。明るく親身に、自然なタメ口で短く（2〜3文で）話してください。\n"
        "音声合成で読み上げるため、絵文字やマークダウン記号は絶対に使わないでください。"
    )


def save_persona_text(text: str, person_id: str = "taku") -> None:
    pm_save_persona_text(person_id, text)


def clean_tts_text(text: str) -> str:
    """TTSで変な読み上げ（アスタリスクなど）にならないようクリーンアップ"""
    # マークダウン記号やコードブロックの除去
    t = re.sub(r"```[\s\S]*?```", "", text)
    t = re.sub(r"[*#_`~>\[\]]", "", t)
    # 絵文字等のサロゲートペアや特殊文字を簡易除去
    t = re.sub(r"[\U00010000-\U0010ffff]", "", t)
    # 連続する空白・改行を整理
    t = re.sub(r"\n+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def error(message: str, status: int):
    return jsonify(error=message), status


# ---------- ルーティング ----------

@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/api/config")
def api_config():
    gemini_key = get_gemini_api_key()
    fish_key = os.environ.get("FISH_API_KEY", "").strip()
    return jsonify(
        has_gemini_key=bool(gemini_key),
        has_fish_key=bool(fish_key),
        model=DEFAULT_MODEL,
        max_length=MAX_TEXT_LENGTH,
    )


@app.get("/api/voices")
def api_voices():
    voices = load_voices()
    res_list = []
    for name, v in voices.items():
        avatar_name = v.get("avatar", "")
        idle_url = get_idle_video_url_for_source(avatar_name, trigger_if_missing=False) if avatar_name else None
        res_list.append({
            "name": name,
            "id": v.get("id"),
            "source": v.get("source", "-"),
            "created_at": v.get("created_at", "-"),
            "avatar": avatar_name,
            "avatar_url": f"/avatars/{avatar_name}" if avatar_name and (AVATARS_DIR / avatar_name).exists() else None,
            "idle_video_url": idle_url,
        })
    return jsonify(
        voices=res_list,
        model=DEFAULT_MODEL,
        max_length=MAX_TEXT_LENGTH,
    )


def _resolve_uploaded_or_selected_avatar() -> str:
    """フォームまたはJSONからアバター画像ファイル名を解決（アップロード時は保存も行う）"""
    if "avatar_file" in request.files:
        f = request.files["avatar_file"]
        if f and f.filename:
            ext = Path(f.filename).suffix.lower()
            if ext not in {".png", ".jpg", ".jpeg", ".webp", ".mp4"}:
                raise ValueError("アバター画像の対応形式は png / jpg / jpeg / webp / mp4 です。")
            safe_name = re.sub(r'[\\/:*?"<>|]', "_", Path(f.filename).name)
            save_path = AVATARS_DIR / safe_name
            f.save(str(save_path))
            return safe_name
    avatar_name = (request.form.get("avatar") or "").strip()
    if avatar_name and (AVATARS_DIR / avatar_name).exists():
        return avatar_name
    return ""


def _trigger_idle_generation_for_avatar(avatar_name: str) -> str | None:
    """指定アバターの待機映像が未生成ならバックグラウンドで生成を開始し、既存ならURLを返す"""
    if not avatar_name:
        return None
    src_path = AVATARS_DIR / avatar_name
    if not src_path.exists():
        return None
    return get_idle_video_url_for_source(avatar_name, trigger_if_missing=True)


@app.post("/api/voices")
def api_create_voice():
    """新しい声の追加（ID直接指定、または音声ファイルアップロードでのクローン生成）＋紐付け画像の待機映像生成"""
    voices = load_voices()

    # 1. multipart/form-data（音声ファイルアップロードでクローン、または画像付きID登録）
    if request.content_type and "multipart/form-data" in request.content_type:
        name = request.form.get("name", "").strip()
        if not name:
            return error("声の名前を入力してください。", 400)
        if name in voices:
            return error(f"声の名前 '{name}' は既に使用されています。", 400)

        try:
            avatar_name = _resolve_uploaded_or_selected_avatar()
        except ValueError as ve:
            return error(str(ve), 400)

        # タブ1: 音声ファイルからクローン作成
        if "audio" in request.files and request.files["audio"].filename:
            audio_file = request.files["audio"]
            ref_text = request.form.get("ref_text", "").strip()
            audio_bytes = audio_file.read()
            if not audio_bytes:
                return error("音声ファイルが空です。", 400)

            try:
                sample_wav_name = _save_voice_sample_wav(
                    name,
                    audio_bytes,
                    Path(audio_file.filename).suffix.lower() or ".mp3",
                )
            except Exception as se:
                print(f"[WARN] Gemini用サンプルWAV保存失敗: {se}", flush=True)
                sample_wav_name = ""

            voice_id = f"gemini_local:{sample_wav_name}" if sample_wav_name else ""
            try:
                fish_client = get_fish_client()
                voice_obj = fish_client.voices.create(
                    title=name,
                    voices=[audio_bytes],
                    texts=[ref_text] if ref_text else None,
                    visibility="private",
                    enhance_audio_quality=True,
                )
                voice_id = voice_obj.id
            except Exception as e:
                if not sample_wav_name:
                    return error(f"音声クローン作成に失敗しました: {str(e)}", 502)
                print(f"[WARN] Fish Audio 登録スキップ (Gemini TTS用ローカルWAVで登録): {e}", flush=True)

            voices[name] = {
                "id": voice_id,
                "source": audio_file.filename,
                "sample_wav": sample_wav_name,
                "created_at": datetime.now().isoformat(timespec="seconds"),
                "avatar": avatar_name,
            }
            save_voices(voices)
            idle_url = _trigger_idle_generation_for_avatar(avatar_name)
            return jsonify(
                status="ok",
                name=name,
                id=voice_id,
                avatar=avatar_name,
                idle_video_url=idle_url,
            )

        # タブ2: モデルID直接登録（multipart）
        voice_id = request.form.get("id", "").strip()
        if not voice_id:
            return error("音声ファイルまたは Fish Audio Reference ID を入力してください。", 400)

        voices[name] = {
            "id": voice_id,
            "source": "manual_id",
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "avatar": avatar_name,
        }
        save_voices(voices)
        idle_url = _trigger_idle_generation_for_avatar(avatar_name)
        return jsonify(
            status="ok",
            name=name,
            id=voice_id,
            avatar=avatar_name,
            idle_video_url=idle_url,
        )

    # 2. JSON で Reference ID 直接登録の場合
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    voice_id = str(data.get("id", "")).strip()
    avatar_name = str(data.get("avatar", "")).strip()
    if avatar_name and not (AVATARS_DIR / avatar_name).exists():
        avatar_name = ""

    if not name:
        return error("声の名前を入力してください。", 400)
    if not voice_id:
        return error("Fish Audio の Reference ID (モデルID) を入力してください。", 400)
    if name in voices:
        return error(f"声の名前 '{name}' は既に使用されています。", 400)

    voices[name] = {
        "id": voice_id,
        "source": "manual_id",
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "avatar": avatar_name,
    }
    save_voices(voices)
    idle_url = _trigger_idle_generation_for_avatar(avatar_name)
    return jsonify(
        status="ok",
        name=name,
        id=voice_id,
        avatar=avatar_name,
        idle_video_url=idle_url,
    )


@app.post("/api/voices/<name>/avatar")
def api_bind_voice_avatar(name):
    """既存の声にアバター画像を紐付け、待機映像を生成する"""
    voices = load_voices()
    if name not in voices:
        return error(f"声 '{name}' は見つかりません。", 404)

    if request.content_type and "multipart/form-data" in request.content_type:
        try:
            avatar_name = _resolve_uploaded_or_selected_avatar()
        except ValueError as ve:
            return error(str(ve), 400)
    else:
        data = request.get_json(silent=True) or {}
        avatar_name = str(data.get("avatar", "")).strip()
        if avatar_name and not (AVATARS_DIR / avatar_name).exists():
            return error("指定されたアバター画像が見つかりません。", 404)

    voices[name]["avatar"] = avatar_name
    save_voices(voices)
    idle_url = _trigger_idle_generation_for_avatar(avatar_name)
    return jsonify(
        status="ok",
        name=name,
        avatar=avatar_name,
        idle_video_url=idle_url,
    )


@app.post("/api/wizard/create")
def api_wizard_create():
    """写真撮影・音声録音・人格アンケートから分身AIを一気通貫で作成する"""
    name = (request.form.get("name") or "").strip()
    if not name:
        return error("お名前を入力してください。", 400)

    nickname = (request.form.get("nickname") or "").strip() or name
    first_person = (request.form.get("first_person") or "私").strip()
    tone = (request.form.get("tone") or "フレンドリーなタメ口").strip()
    personality = (request.form.get("personality") or "").strip()
    favorites = (request.form.get("favorites") or "").strip()
    catchphrase = (request.form.get("catchphrase") or "").strip()
    holiday = (request.form.get("holiday") or "").strip()
    ref_text = (request.form.get("ref_text") or "").strip()

    ts = int(time.time())
    person_id = f"user_{ts}"
    voice_name = f"{person_id}_voice"

    # 1. 顔写真の保存
    avatar_filename = ""
    if "photo" in request.files and request.files["photo"].filename:
        pf = request.files["photo"]
        ext = Path(pf.filename).suffix.lower() or ".png"
        if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
            ext = ".png"
        avatar_filename = f"face_{ts}{ext}"
        pf.save(str(AVATARS_DIR / avatar_filename))
    else:
        sel = (request.form.get("avatar") or "").strip()
        if sel and (AVATARS_DIR / sel).exists():
            avatar_filename = sel

    if not avatar_filename:
        return error("顔写真を撮影するか、画像を選択してください。", 400)

    # 2. 録音音声をWAVへ正規化して Fish Audio で音声クローン作成
    if "audio" not in request.files or not request.files["audio"].filename:
        return error("音声を録音（またはファイル選択）してください。", 400)

    audio_file = request.files["audio"]
    raw_audio = audio_file.read()
    if not raw_audio or len(raw_audio) < 1000:
        return error("録音データが短すぎるか空です。もう一度録音してください。", 400)

    raw_ext = Path(audio_file.filename).suffix.lower() or ".webm"
    try:
        sample_wav_name = _save_voice_sample_wav(voice_name, raw_audio, raw_ext)
        wav_bytes = (VOICE_SAMPLES_DIR / sample_wav_name).read_bytes()
    except Exception as e:
        return error(f"録音音声の変換に失敗しました: {e}", 400)

    voice_id = f"gemini_local:{sample_wav_name}"
    try:
        fish_client = get_fish_client()
        voice_obj = fish_client.voices.create(
            title=f"{name}_{ts}",
            voices=[wav_bytes],
            texts=[ref_text] if ref_text else None,
            visibility="private",
            enhance_audio_quality=True,
        )
        voice_id = voice_obj.id
    except Exception as e:
        print(f"[WARN] ウィザード Fish Audio 登録スキップ (Gemini TTS用ローカルWAVで続行): {e}", flush=True)

    voices = load_voices()
    voices[voice_name] = {
        "id": voice_id,
        "source": f"wizard_{ts}.wav",
        "sample_wav": sample_wav_name,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "avatar": avatar_filename,
    }
    save_voices(voices)

    # 3. アンケート内容から人格プロンプトを生成してペルソナ登録
    persona_lines = [
        f"あなたは「{name}」（呼び名：{nickname}）本人として会話してください。",
        "",
        "## 基本プロフィール・口調",
        f"- 一人称: 「{first_person}」",
        f"- 話し方・口調: {tone}",
    ]
    if personality:
        persona_lines.append(f"- 性格・特徴: {personality}")
    if favorites:
        persona_lines.append(f"- 好きなこと・趣味・食べ物: {favorites}")
    if catchphrase:
        persona_lines.append(f"- よく使う口癖・語尾: {catchphrase}")
    if holiday:
        persona_lines.append(f"- 休日の過ごし方・マイブーム: {holiday}")
    persona_lines.extend([
        "",
        "## 会話のルール",
        "- AIやアシスタントとしてではなく、必ず本人になりきって自然な日本語で返答してください。",
        "- 相手の話に共感したり、自分の好みやエピソードを自然に交えて短くテンポよく返してください。",
    ])
    initial_content = "\n".join(persona_lines)

    try:
        persona = create_persona(
            person_id=person_id,
            name=name,
            nickname=nickname,
            attribute=f"口調: {tone}",
            personality=personality,
            favorites=favorites,
            first_person=first_person,
            voice_name=voice_name,
            initial_content=initial_content,
        )
    except Exception as pe:
        return error(f"人格の作成に失敗しました: {pe}", 500)

    # 4. アバター状態の更新＆3パターンの待機映像をバックグラウンド生成
    st = update_avatar_state(source_filename=avatar_filename, persona_name=name)
    _trigger_idle_generation_for_avatar(avatar_filename)
    idle_urls = get_idle_video_urls_for_source(avatar_filename, trigger_if_missing=False)
    st["idle_video_url"] = idle_urls[0] if idle_urls else None
    st["idle_video_urls"] = idle_urls

    return jsonify(
        status="ok",
        persona=persona,
        voice_name=voice_name,
        avatar=avatar_filename,
        state=st,
    )


@app.delete("/api/voices/<name>")
def api_delete_voice(name):
    """登録されている声を削除"""
    voices = load_voices()
    if name not in voices:
        return error(f"声 '{name}' は見つかりません。", 404)
    del voices[name]
    save_voices(voices)
    return jsonify(status="ok", deleted=name)


@app.post("/api/voices/test")
def api_test_voice():
    """指定した声でテスト音声を生成・再生"""
    data = request.get_json(silent=True) or {}
    voice = str(data.get("voice", "")).strip()
    tts_provider = str(data.get("tts_provider", "fish")).strip().lower()
    test_text = str(data.get("text", "")).strip() or "こんにちは。これはクローン音声のテスト発声です。"
    if not voice:
        return error("声を選択してください。", 400)

    try:
        audio = synthesize_speech_segment(test_text, voice, tts_provider=tts_provider)
        mime = "audio/wav" if audio[:4] == b"RIFF" else "audio/mpeg"
        return Response(audio, mimetype=mime, headers={"Cache-Control": "no-store"})
    except Exception as e:
        return error(f"試聴音声の生成に失敗しました: {str(e)}", 502)


@app.get("/api/persona")
def api_get_persona():
    return jsonify(prompt=load_persona_text())


@app.post("/api/persona")
def api_save_persona():
    data = request.get_json(silent=True) or {}
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return error("人格プロンプトが空です。", 400)
    save_persona_text(prompt)
    return jsonify(status="ok")


@app.post("/api/stt")
def api_stt():
    """音声ファイルをGemini（またはローカルWindows音声認識）で日本語文字起こしする"""
    if "audio" not in request.files:
        return error("音声ファイルがありません。", 400)
    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()
    if not audio_bytes:
        return error("音声データが空です。", 400)

    mime_type = (audio_file.mimetype or "audio/webm").split(";")[0].strip()
    if mime_type == "video/webm":
        mime_type = "audio/webm"

    gemini_key = get_gemini_api_key()
    if gemini_key:
        try:
            from google.genai import types
            gemini_client = get_gemini_client(gemini_key)
            candidate_models = ["gemini-3.5-flash-lite", "gemini-flash-latest"]
            for model_name in candidate_models:
                try:
                    resp = gemini_client.models.generate_content(
                        model=model_name,
                        contents=[
                            types.Part.from_bytes(data=audio_bytes, mime_type=mime_type),
                            types.Part.from_text(
                                text="この音声の内容を日本語で正確に文字起こししてください。無音や聞き取れない場合は空文字を返してください。文字起こし結果のテキストのみを出力し、説明や前置きは一切書かないでください。"
                            ),
                        ],
                    )
                    text = (resp.text or "").strip()
                    return jsonify(status="ok", text=text)
                except Exception:
                    continue
        except Exception:
            pass

    # オフライン・ローカル音声認識フォールバック (Windows SpeechRecognitionEngine ja-JP)
    tmp_in = VOICE_SAMPLES_DIR / f"stt_in_{int(time.time() * 1000)}.webm"
    tmp_wav = VOICE_SAMPLES_DIR / f"stt_wav_{int(time.time() * 1000)}.wav"
    try:
        import subprocess
        import imageio_ffmpeg
        from local_tts_engine import transcribe_audio_local_sapi
        tmp_in.write_bytes(audio_bytes)
        ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run(
            [ffmpeg_exe, "-loglevel", "error", "-y", "-i", str(tmp_in), "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le", str(tmp_wav)],
            check=True,
        )
        text = transcribe_audio_local_sapi(tmp_wav)
        return jsonify(status="ok", text=text)
    except Exception as e:
        return error(f"ローカル音声認識に失敗しました: {e}", 500)
    finally:
        for p in (tmp_in, tmp_wav):
            if p.exists():
                try:
                    p.unlink()
                except Exception:
                    pass


@app.post("/api/tts")
def api_tts():
    """テキストを直接読み上げ（Fish Audio / Gemini 3.8 TTS 選択対応）"""
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    voice = str(data.get("voice", "")).strip()
    tts_provider = str(data.get("tts_provider", "fish")).strip().lower()

    if not text:
        return error("読み上げる文章を入力してください。", 400)
    if len(text) > MAX_TEXT_LENGTH:
        return error(f"文章は {MAX_TEXT_LENGTH} 文字以内にしてください。", 400)
    if not voice:
        return error("声を選択してください。", 400)

    speed = data.get("speed")
    if speed is not None:
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            return error("速さの値が不正です。", 400)
        if not SPEED_RANGE[0] <= speed <= SPEED_RANGE[1]:
            return error(f"速さは {SPEED_RANGE[0]}〜{SPEED_RANGE[1]} の範囲で指定してください。", 400)

    try:
        audio = synthesize_speech_segment(text, voice, speed=speed, tts_provider=tts_provider)
    except AuthenticationError:
        return error("APIキーが無効です。.env の FISH_API_KEY を確認してください。", 401)
    except RateLimitError:
        return error("同時リクエスト上限です。少し待ってから再実行してください。", 429)
    except NotFoundError:
        return error("指定した声が見つかりません。", 404)
    except Exception as e:
        return error(f"音声合成エラー: {e}", 502)

    mime = "audio/wav" if audio[:4] == b"RIFF" else "audio/mpeg"
    return Response(audio, mimetype=mime, headers={"Cache-Control": "no-store"})


def _synthesize_gemini_tts(text: str, voice: str, tts_provider: str = "gemini-lite") -> bytes:
    """Gemini 3.8 Flash TTS (ReplicatedVoiceConfig) で音声クローン合成"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        raise ValueError("GEMINI_API_KEY が設定されていません。")
    from google.genai import types
    gemini_client = get_gemini_client(gemini_key)
    sample_bytes = get_voice_sample_wav_bytes(voice)

    if sample_bytes:
        voice_cfg = types.VoiceConfig(
            replicated_voice_config=types.ReplicatedVoiceConfig(
                voice_sample_audio=sample_bytes,
                mime_type="audio/wav",
            )
        )
    else:
        voice_cfg = types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
        )

    primary = "gemini-3.8-flash-tts" if tts_provider == "gemini-flash" else "gemini-3.8-flash-lite-tts"
    fallback = "gemini-3.8-flash-lite-tts" if primary == "gemini-3.8-flash-tts" else "gemini-3.8-flash-tts"
    last_err = None
    for model_name in (primary, fallback):
        try:
            resp = gemini_client.models.generate_content(
                model=model_name,
                contents=text,
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(voice_config=voice_cfg),
                ),
            )
            for cand in (resp.candidates or []):
                for part in (cand.content.parts if cand.content else []):
                    if part.inline_data and part.inline_data.data:
                        return part.inline_data.data
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"Gemini TTS 合成失敗: {last_err}")


def synthesize_speech_segment(
    text: str,
    voice: str,
    speed: float | None = None,
    tts_provider: str = "fish",
) -> bytes:
    if tts_provider == "local":
        from local_tts_engine import synthesize_local_cloned_tts
        sample_b = get_voice_sample_wav_bytes(voice)
        return synthesize_local_cloned_tts(text, voice, sample_wav_bytes=sample_b, speed=speed)

    if tts_provider and tts_provider.startswith("gemini"):
        return _synthesize_gemini_tts(text, voice, tts_provider=tts_provider)

    ref_id = resolve_voice_id(voice)
    if ref_id.startswith("gemini_local:"):
        return _synthesize_gemini_tts(text, voice, tts_provider="gemini-lite")

    fish_client = get_fish_client()
    audio = fish_client.tts.convert(
        text=text,
        reference_id=ref_id,
        speed=speed,
        config=TTSConfig(format="mp3", latency="balanced"),
        model=DEFAULT_MODEL,
    )
    if not isinstance(audio, bytes):
        audio = b"".join(audio)
    return audio


OLLAMA_BASE_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma3:12b")


def _ensure_ollama_running() -> bool:
    """Ollama サーバーが未起動ならバックグラウンドで起動する"""
    try:
        r = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=1.5)
        if r.status_code == 200:
            return True
    except Exception:
        pass
    ollama_exe = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
    if ollama_exe.exists():
        try:
            import subprocess
            subprocess.Popen(
                [str(ollama_exe), "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
            )
            time.sleep(1.5)
            return True
        except Exception as e:
            print(f"[WARN] Ollama 自動起動失敗: {e}", flush=True)
    return False


@app.get("/api/llm/status")
def api_llm_status():
    """ローカルLLM (Ollama) の稼働状態と利用可能モデル一覧を返す"""
    _ensure_ollama_running()
    try:
        resp = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=2.0)
        if resp.status_code == 200:
            data = resp.json()
            models = [m.get("name") for m in data.get("models", []) if m.get("name")]
            return jsonify(
                ollama_running=True,
                ollama_url=OLLAMA_BASE_URL,
                models=models,
                default_local_model=DEFAULT_OLLAMA_MODEL if DEFAULT_OLLAMA_MODEL in models else (models[0] if models else DEFAULT_OLLAMA_MODEL),
            )
    except Exception:
        pass
    return jsonify(
        ollama_running=False,
        ollama_url=OLLAMA_BASE_URL,
        models=[],
        default_local_model=DEFAULT_OLLAMA_MODEL,
    )


def _iter_ollama_text_chunks(system_prompt: str, history: list, message: str, model_name: str):
    """Ollama /api/chat からテキストチャンクをストリーミング取得する"""
    import json
    messages = [{"role": "system", "content": system_prompt}]
    for h in history[-6:]:
        role = "user" if h.get("role") == "user" else "assistant"
        text_val = str(h.get("text", "")).strip()
        if text_val:
            messages.append({"role": role, "content": text_val})
    messages.append({"role": "user", "content": message})

    payload = {
        "model": model_name or DEFAULT_OLLAMA_MODEL,
        "messages": messages,
        "stream": True,
        "keep_alive": "30m",
        "options": {
            "temperature": 0.7,
            "num_predict": 80,
            "num_ctx": 1536,
        },
    }
    with httpx.Client(timeout=httpx.Timeout(90.0, connect=3.0)) as client:
        with client.stream("POST", f"{OLLAMA_BASE_URL}/api/chat", json=payload) as resp:
            if resp.status_code != 200:
                body = resp.read().decode("utf-8", errors="ignore")
                raise RuntimeError(f"Ollama HTTP {resp.status_code}: {body[:200]}")
            for line in resp.iter_lines():
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("error"):
                    raise RuntimeError(f"Ollama error: {obj['error']}")
                msg = obj.get("message") or {}
                content = msg.get("content") or ""
                if content:
                    yield content
                if obj.get("done"):
                    break


@app.post("/api/chat/stream")
def api_chat_stream():
    """Gemini または ローカルLLM (Ollama) の回答テキストと Fish Audio / Gemini TTS 音声合成を文単位でストリーミングするSSEエンドポイント"""
    data = request.get_json(silent=True) or {}
    llm_provider = str(data.get("llm_provider", "gemini")).strip().lower()
    llm_model = str(data.get("llm_model", "")).strip()
    tts_provider = str(data.get("tts_provider", "fish")).strip().lower()

    gemini_key = get_gemini_api_key()
    if (llm_provider != "ollama" or tts_provider.startswith("gemini")) and not gemini_key:
        return error(
            "Gemini API キーが設定されていません。.env ファイルの GEMINI_API_KEY にキーを記載してください。",
            400,
        )

    message = str(data.get("message", "")).strip()
    voice = str(data.get("voice", "")).strip()
    history = data.get("history", [])
    custom_persona = data.get("persona")
    enable_tts = bool(data.get("enable_tts", False))
    avatar_mode = bool(data.get("avatar_mode", True))

    if not message:
        return error("メッセージを入力してください。", 400)
    if not voice:
        return error("声を選択してください。", 400)

    speed = data.get("speed")
    if speed is not None:
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            speed = None

    t_start = time.time()
    person_id = str(data.get("person_id", "taku")).strip()
    system_prompt = custom_persona if custom_persona else load_persona_text(person_id)

    def generate_sse():
        import json
        from google.genai import types

        t_first_audio = None
        full_reply_chunks = []
        sentence_buffer = ""
        delimiters = set("。！？!?\n")
        segment_index = 0
        total_tts_time = 0.0

        try:
            speed_instruction = f"{system_prompt}\n\n【最重要ルール】音声合成と映像生成を高速化するため、必ず1文（35文字以内）のテンポの良い短文で、自然な日本語のみで返答してください（英語・絵文字は使わないこと）。"
            t_gemini_start = time.time()
            provider_label = "gemini"

            if llm_provider == "ollama":
                used_model = llm_model or DEFAULT_OLLAMA_MODEL
                provider_label = f"ollama:{used_model}"
                text_chunk_iter = _iter_ollama_text_chunks(speed_instruction, history, message, used_model)
            else:
                contents = []
                for h in history[-6:]:
                    role = "user" if h.get("role") == "user" else "model"
                    text_val = str(h.get("text", "")).strip()
                    if text_val:
                        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text_val)]))

                contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))

                # 最新モデル gemini-3.5-flash-lite / gemini-flash-latest を使用
                candidate_models = ["gemini-3.5-flash-lite", "gemini-flash-latest"]

                stream_iter = None
                first_chunk = None
                last_err_msg = ""

                vertex_modes = [False, True] if gemini_key.startswith("AQ.") else [False]
                for try_vertex in vertex_modes:
                    gemini_client = get_gemini_client(gemini_key, force_vertexai=try_vertex)
                    for model_name in candidate_models:
                        try:
                            s_resp = gemini_client.models.generate_content_stream(
                                model=model_name,
                                contents=contents,
                                config=types.GenerateContentConfig(
                                    system_instruction=speed_instruction,
                                    temperature=0.7,
                                    max_output_tokens=60,
                                ),
                            )
                            s_iter = iter(s_resp)
                            first_chunk = next(s_iter)
                            stream_iter = s_iter
                            provider_label = f"gemini:{model_name}"
                            break
                        except Exception as m_err:
                            last_err_msg = str(m_err)
                            print(f"[DEBUG] モデル {model_name} (vertexai={try_vertex}) 呼び出し失敗: {m_err}", flush=True)
                            continue
                    if first_chunk is not None or stream_iter is not None:
                        break

                if first_chunk is None and stream_iter is None:
                    detail = f" ({last_err_msg[:180]})" if last_err_msg else ""
                    yield f"data: {json.dumps({'type': 'error', 'message': f'Gemini API からの応答を取得できませんでした{detail}'}, ensure_ascii=False)}\n\n"
                    return

                import itertools
                text_chunk_iter = (
                    (c.text or "") for c in itertools.chain([first_chunk], stream_iter)
                )

            t_gemini_first = None
            raw_audio_segments: list[bytes] = []
            avatar_task_ids: list[str] = []

            p_obj = get_persona(person_id) or {}
            p_name_str = p_obj.get("name", "市川 拓")
            v_obj = load_voices().get(voice, {})
            v_avatar = v_obj.get("avatar", "") if isinstance(v_obj, dict) else ""
            if v_avatar and not (AVATARS_DIR / v_avatar).exists():
                v_avatar = ""

            def process_sentence(sentence_text: str):
                nonlocal segment_index, total_tts_time, t_first_audio
                clean_s = clean_tts_text(sentence_text)
                if not clean_s or len(clean_s.strip()) < 1:
                    return None

                if enable_tts:
                    t_tts_s = time.time()
                    try:
                        audio_bytes = synthesize_speech_segment(clean_s, voice, speed, tts_provider=tts_provider)
                        tts_elapsed = time.time() - t_tts_s
                        total_tts_time += tts_elapsed
                        raw_audio_segments.append(audio_bytes)
                        b64 = base64.b64encode(audio_bytes).decode("ascii")
                        audio_mime = "audio/wav" if audio_bytes[:4] == b"RIFF" else "audio/mpeg"
                        now_since_start = round(time.time() - t_start, 2)
                        if t_first_audio is None:
                            t_first_audio = now_since_start

                        seg_task_id = None
                        if avatar_mode:
                            seg_task_id = start_avatar_task_async(
                                [audio_bytes],
                                clean_s,
                                p_name_str,
                                req_source=v_avatar,
                            )
                            avatar_task_ids.append(seg_task_id)

                        event_data = {
                            "type": "audio_segment",
                            "index": segment_index,
                            "text": clean_s,
                            "audio_base64": b64,
                            "audio_mime": audio_mime,
                            "latency_sec": now_since_start,
                            "avatar_task_id": seg_task_id,
                        }
                        segment_index += 1
                        return f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"
                    except Exception as tts_err:
                        print(f"[DEBUG] セグメントTTS失敗: {tts_err}", flush=True)
                        return None
                return None

            min_split_len = 8 if avatar_mode else 12
            for chunk_text in text_chunk_iter:
                if not chunk_text:
                    continue

                if t_gemini_first is None:
                    t_gemini_first = round(time.time() - t_gemini_start, 2)

                full_reply_chunks.append(chunk_text)
                sentence_buffer += chunk_text

                # テキストチャンクを即時送信（チャット画面に最速で全文表示）
                yield f"data: {json.dumps({'type': 'text_chunk', 'text': chunk_text}, ensure_ascii=False)}\n\n"

                # 1文が完成した瞬間に先行TTS＆（アバターモード時は）先行動画生成を起動するパイプライン
                while True:
                    split_idx = -1
                    for i, ch in enumerate(sentence_buffer):
                        if ch in delimiters and i >= min_split_len:
                            split_idx = i + 1
                            break
                    if split_idx != -1:
                        target_sent = sentence_buffer[:split_idx]
                        sentence_buffer = sentence_buffer[split_idx:]
                        audio_event = process_sentence(target_sent)
                        if audio_event:
                            yield audio_event
                    else:
                        break

            # 残りのテキスト
            if sentence_buffer.strip():
                audio_event = process_sentence(sentence_buffer)
                if audio_event:
                    yield audio_event

            full_reply = "".join(full_reply_chunks)
            total_sec = round(time.time() - t_start, 2)
            gemini_total = round(time.time() - t_gemini_start, 2)

            print(f"\n[DEBUG] ========================================", flush=True)
            print(f"[DEBUG] [STREAM] LLM       : {provider_label}", flush=True)
            print(f"[DEBUG] [STREAM] メッセージ: \"{message}\"", flush=True)
            print(f"[DEBUG] [STREAM] TTS設定   : {'ON' if enable_tts else 'OFF'}", flush=True)
            print(f"[DEBUG] [LLM初速]          : {t_gemini_first} 秒 (全完了: {gemini_total}秒)", flush=True)
            if enable_tts:
                print(f"[DEBUG] [音声初声]         : {t_first_audio} 秒", flush=True)
                print(f"[DEBUG] [全体完了時間]     : {total_sec} 秒", flush=True)
            else:
                print(f"[DEBUG] [全体完了時間]     : {total_sec} 秒", flush=True)
            print(f"[DEBUG] 返答内容           : \"{full_reply}\"", flush=True)
            print(f"[DEBUG] ========================================\n", flush=True)

            timing_info = {
                "llm_provider": provider_label,
                "gemini_first_sec": t_gemini_first or 0,
                "gemini_total_sec": gemini_total,
                "first_audio_sec": t_first_audio,
                "tts_total_sec": round(total_tts_time, 2),
                "total_sec": total_sec,
                "enable_tts": enable_tts,
            }

            append_perf_log(
                f"[CHAT+TTS] llm={provider_label} total={total_sec:.2f}s "
                f"(llm_first={t_gemini_first or 0:.2f}s, llm_total={gemini_total:.2f}s, "
                f"tts_total={total_tts_time:.2f}s) | msg=\"{message}\" -> reply=\"{full_reply}\""
            )

            # すでに文単位で先行開始済みのタスクがあればそれを使用し、なければここで起動
            avatar_task_id = avatar_task_ids[0] if avatar_task_ids else None
            if avatar_mode and raw_audio_segments and not avatar_task_ids:
                avatar_task_id = start_avatar_task_async(raw_audio_segments, full_reply, p_name_str, req_source=v_avatar)
                avatar_task_ids.append(avatar_task_id)

            yield f"data: {json.dumps({'type': 'done', 'reply': full_reply, 'voice': voice, 'timing': timing_info, 'avatar_task_id': avatar_task_id, 'avatar_task_ids': avatar_task_ids}, ensure_ascii=False)}\n\n"

        except Exception as e:
            print(f"[DEBUG] ストリーミング処理エラー: {e}", flush=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    from flask import Response, stream_with_context
    return Response(stream_with_context(generate_sse()), mimetype="text/event-stream")


@app.post("/api/chat")
def api_chat():
    """AI対話（Geminiで返答生成 ＋ オプションでFish Audioで音声合成）"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error(
            "Gemini API キーが設定されていません。.env ファイルの GEMINI_API_KEY にキーを記載してください。\n"
            "※キーは https://aistudio.google.com/app/apikey から無料で発行できます。",
            400,
        )

    data = request.get_json(silent=True) or {}
    message = str(data.get("message", "")).strip()
    voice = str(data.get("voice", "")).strip()
    history = data.get("history", [])  # [{"role": "user"|"model", "text": "..."}]
    custom_persona = data.get("persona")
    enable_tts = bool(data.get("enable_tts", False))  # デフォルトは音声なし（超高速テキスト対話）

    if not message:
        return error("メッセージを入力してください。", 400)
    if not voice:
        return error("声を選択してください。", 400)

    speed = data.get("speed")
    if speed is not None:
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            speed = None

    t_start = time.time()
    person_id = str(data.get("person_id", "taku")).strip()

    # 人格プロンプト
    system_prompt = custom_persona if custom_persona else load_persona_text(person_id)

    # 1. Gemini で回答を生成
    t_gemini_start = time.time()
    try:
        from google.genai import types

        gemini_client = get_gemini_client(gemini_key)

        # チャット履歴をフォーマット
        contents = []
        for h in history[-6:]:  # 直近6往復程度に制限してトークン節約＆コンテキスト保持
            role = "user" if h.get("role") == "user" else "model"
            text_val = str(h.get("text", "")).strip()
            if text_val:
                contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text_val)]))

        # 今回のユーザー発言を追加
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))

        # 高速応答のため短文指定を追加
        speed_instruction = f"{system_prompt}\n\n【最重要ルール】音声合成と映像生成を高速化するため、必ず1文（35文字以内）のテンポの良い短文で返答してください。"

        # 最新モデル gemini-3.5-flash-lite / gemini-flash-latest を使用
        candidate_models = ["gemini-3.5-flash-lite", "gemini-flash-latest"]
        response = None
        last_exc = None
        vertex_modes = [False, True] if gemini_key.startswith("AQ.") else [False]
        for try_vertex in vertex_modes:
            gemini_client = get_gemini_client(gemini_key, force_vertexai=try_vertex)
            for model_name in candidate_models:
                try:
                    response = gemini_client.models.generate_content(
                        model=model_name,
                        contents=contents,
                        config=types.GenerateContentConfig(
                            system_instruction=speed_instruction,
                            temperature=0.7,
                            max_output_tokens=60,
                        ),
                    )
                    if response and response.text:
                        break
                except Exception as err:
                    last_exc = err
                    continue
            if response and response.text:
                break

        if not response or not response.text:
            raise last_exc if last_exc else Exception("Geminiからの返答が取得できませんでした")

        reply_raw = response.text or ""
    except Exception as e:
        return error(f"Gemini API エラー: {str(e)}", 502)

    gemini_sec = round(time.time() - t_gemini_start, 2)
    clean_reply = clean_tts_text(reply_raw)
    if not clean_reply:
        clean_reply = "うまく答えられなかったよ。もう一度聞いてみて！"

    # 音声合成がOFFの場合はここで即座にテキストのみを返す
    if not enable_tts:
        total_sec = round(time.time() - t_start, 2)
        print(f"\n[DEBUG] ========================================", flush=True)
        print(f"[DEBUG] メッセージ         : \"{message}\"", flush=True)
        print(f"[DEBUG] 音声合成(TTS)      : OFF（テキストのみ対話）", flush=True)
        print(f"[DEBUG] [Gemini返答時間]   : {gemini_sec:.2f} 秒", flush=True)
        print(f"[DEBUG] [合計所要時間]     : {total_sec:.2f} 秒", flush=True)
        print(f"[DEBUG] 返答内容           : \"{clean_reply}\"", flush=True)
        print(f"[DEBUG] ========================================\n", flush=True)
        return jsonify(
            reply=clean_reply,
            raw_reply=reply_raw,
            audio_base64=None,
            voice=voice,
            timing={
                "gemini_sec": gemini_sec,
                "tts_sec": 0,
                "total_sec": total_sec,
                "enable_tts": False,
            },
        )

    # 2. Fish Audio で音声合成（balanced で高速化）
    t_tts_start = time.time()
    try:
        fish_client = get_fish_client()
        audio = fish_client.tts.convert(
            text=clean_reply,
            reference_id=resolve_voice_id(voice),
            speed=speed,
            config=TTSConfig(format="mp3", latency="balanced"),
            model=DEFAULT_MODEL,
        )
        if not isinstance(audio, bytes):
            audio = b"".join(audio)
    except Exception as e:
        tts_sec = round(time.time() - t_tts_start, 2)
        total_sec = round(time.time() - t_start, 2)
        print(f"[DEBUG] TTS生成失敗 ({tts_sec:.2f}秒): {e}", flush=True)
        return jsonify(
            reply=clean_reply,
            raw_reply=reply_raw,
            audio_base64=None,
            voice=voice,
            tts_error=f"音声の生成に失敗しました: {str(e)}",
            timing={
                "gemini_sec": gemini_sec,
                "tts_sec": tts_sec,
                "total_sec": total_sec,
                "enable_tts": True,
            },
        )

    tts_sec = round(time.time() - t_tts_start, 2)
    total_sec = round(time.time() - t_start, 2)

    print(f"\n[DEBUG] ========================================", flush=True)
    print(f"[DEBUG] メッセージ          : \"{message}\"", flush=True)
    print(f"[DEBUG] 音声合成(TTS)       : ON（音声あり）", flush=True)
    print(f"[DEBUG] [Gemini返答時間]    : {gemini_sec:.2f} 秒", flush=True)
    print(f"[DEBUG] [FishAudio返答時間] : {tts_sec:.2f} 秒", flush=True)
    print(f"[DEBUG] [合計所要時間]      : {total_sec:.2f} 秒", flush=True)
    print(f"[DEBUG] 返答内容            : \"{clean_reply}\"", flush=True)
    print(f"[DEBUG] ========================================\n", flush=True)

    b64_audio = base64.b64encode(audio).decode("ascii")
    return jsonify(
        reply=clean_reply,
        raw_reply=reply_raw,
        audio_base64=b64_audio,
        voice=voice,
        timing={
            "gemini_sec": gemini_sec,
            "tts_sec": tts_sec,
            "total_sec": total_sec,
            "enable_tts": True,
        },
    )


# ---------- LINE Bot 連携エンドポイント ----------

from line_bot import (
    get_line_credentials,
    verify_line_signature,
    load_line_logs,
    save_line_log,
    save_line_user,
    get_active_line_users,
    reply_line_message,
    generate_interview_reply,
    update_persona_from_logs,
    send_proactive_question_to_users,
    start_proactive_scheduler,
    import_line_chat_history,
    get_topic_categories,
)


@app.get("/api/line/topics")
def api_line_topics():
    """利用可能なインタビュー話題カテゴリ一覧を返す"""
    return jsonify(topics=get_topic_categories())


# ---------- ペルソナ管理API ----------

@app.get("/api/personas")
def api_get_personas():
    """登録されているペルソナ一覧を返す"""
    return jsonify(personas=list_personas())


@app.post("/api/personas")
def api_create_persona():
    """新しい人物のペルソナを作成"""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    nickname = str(data.get("nickname", "")).strip() or name
    person_id = str(data.get("id", "")).strip()
    attribute = str(data.get("attribute", "")).strip()
    personality = str(data.get("personality", "")).strip()
    favorites = str(data.get("favorites", "")).strip()
    dislikes = str(data.get("dislikes", "")).strip()
    first_person = str(data.get("first_person", "私")).strip()
    voice_name = str(data.get("voice_name", "")).strip()
    initial_content = data.get("content")

    if not name:
        return error("お名前を入力してください。", 400)
    if not person_id:
        person_id = f"person_{int(time.time())}"

    try:
        new_p = create_persona(
            person_id=person_id,
            name=name,
            nickname=nickname,
            attribute=attribute,
            personality=personality,
            favorites=favorites,
            dislikes=dislikes,
            first_person=first_person,
            voice_name=voice_name,
            initial_content=initial_content,
        )
        return jsonify(success=True, persona=new_p)
    except Exception as e:
        return error(str(e), 400)


@app.get("/api/personas/<person_id>")
def api_get_persona_detail(person_id: str):
    """指定されたペルソナの詳細・本文テキストを返す"""
    p = get_persona(person_id)
    if not p:
        return error(f"ペルソナ '{person_id}' が見つかりません。", 404)
    return jsonify(p)


@app.post("/api/personas/<person_id>")
def api_update_persona(person_id: str):
    """指定されたペルソナのpersona.txtを更新"""
    data = request.get_json(silent=True) or {}
    content = data.get("content")
    if content is None:
        return error("content が空です。", 400)
    save_persona_text(content, person_id=person_id)
    return jsonify(success=True, message=f"{person_id} の人格設定を保存しました。")


@app.delete("/api/personas/<person_id>")
def api_delete_persona(person_id: str):
    """指定されたペルソナを削除"""
    try:
        ok = delete_persona(person_id)
        if not ok:
            return error("ペルソナが見つかりません。", 404)
        return jsonify(success=True, message=f"ペルソナ '{person_id}' を削除しました。")
    except Exception as e:
        return error(str(e), 400)


@app.post("/api/personas/<person_id>/bind_line")
def api_bind_line_user(person_id: str):
    """LINEユーザーIDと指定ペルソナを紐付け"""
    data = request.get_json(silent=True) or {}
    user_id = str(data.get("user_id", "")).strip()
    if not user_id:
        return error("user_id が必要です。", 400)
    bind_line_user_to_persona(user_id, person_id)
    return jsonify(success=True, message=f"LINEユーザー {user_id} を {person_id} に紐付けました。")


@app.post("/api/personas/<person_id>/set_line_default")
def api_set_line_default_persona(person_id: str):
    """LINEの全体デフォルトペルソナを設定し、現在接続中のユーザーも一括連動"""
    ok = set_default_line_persona_id(person_id)
    if not ok:
        return error("ペルソナが見つかりません。", 404)

    # 既に会話したことのあるLINEユーザーたちもこのペルソナに紐付け
    active_users = get_active_line_users()
    for uid in active_users:
        bind_line_user_to_persona(uid, person_id)

    p_data = get_persona(person_id) or {}
    name = p_data.get("name", person_id)
    nick = p_data.get("nickname", name)
    return jsonify(
        success=True,
        message=f"LINEの会話・学習対象を「{name} ({nick})」に切り替えました！",
        person_id=person_id,
        person_name=name,
    )


@app.get("/api/persona")
def api_get_default_persona():
    """互換性用: 現在のアクティブペルソナテキストを返す"""
    person_id = request.args.get("person_id", "taku")
    text = load_persona_text(person_id)
    return jsonify(content=text, person_id=person_id)


# ---------- LINE連携エンドポイント ----------

@app.get("/api/line/status")
def api_line_status():
    """LINE連携の状態と蓄積ログのサマリーを返す"""
    secret, token = get_line_credentials()
    logs = load_line_logs()
    users = get_active_line_users()
    person_id = request.args.get("person_id")

    default_pid = get_default_line_persona_id()
    default_p = get_persona(default_pid) or {}
    default_p_name = default_p.get("name", "市川 拓")

    if person_id:
        target_logs = [l for l in logs if l.get("person_id", "taku") == person_id]
    else:
        target_logs = [l for l in logs if l.get("person_id", "taku") == default_pid]

    unlearned_count = sum(1 for l in target_logs if not l.get("learned", False))
    return jsonify(
        configured=bool(secret and token),
        total_logs=len(target_logs),
        unlearned_logs=unlearned_count,
        users_count=len(users),
        recent_logs=target_logs[-15:],
        default_persona_id=default_pid,
        default_persona_name=default_p_name,
        user_persona_map=load_line_user_persona_map(),
    )


@app.post("/api/line/webhook")
def api_line_webhook():
    """LINE Messaging API からの Webhook を処理（ペルソナ自動判定＆LINE内切り替え対応）"""
    secret, token = get_line_credentials()
    if not secret or not token:
        return "LINE credentials not configured", 500

    signature = request.headers.get("X-Line-Signature", "")
    body_bytes = request.get_data()

    if not verify_line_signature(body_bytes, signature, secret):
        print("[WARN] LINE Webhook 署名検証に失敗しました")
        return "Invalid signature", 400

    gemini_key = get_gemini_api_key()
    if not gemini_key:
        print("[WARN] Gemini APIキーが設定されていません")
        return "Gemini API key missing", 500

    data = request.get_json(silent=True) or {}
    events = data.get("events", [])

    for event in events:
        ev_type = event.get("type")
        user_id = event.get("source", {}).get("userId", "unknown_user")

        # ユーザーIDを記憶
        if user_id and user_id != "unknown_user":
            save_line_user(user_id)

        if ev_type == "message":
            msg_obj = event.get("message", {})
            if msg_obj.get("type") == "text":
                user_text = msg_obj.get("text", "").strip()
                reply_token = event.get("replyToken")

                if not user_text or not reply_token:
                    continue

                target_pid = get_persona_id_for_line_user(user_id)

                # --- LINE内でのペルソナ切り替え / 一覧コマンド判定 ---
                clean_cmd = user_text.strip()
                if clean_cmd in ["一覧", "ペルソナ", "キャラ", "切り替え", "ヘルプ", "設定", "誰", "だれ"]:
                    reply_msg = format_persona_list_for_line(target_pid)
                    reply_line_message(reply_token, reply_msg, token)
                    continue

                if clean_cmd.startswith("切り替え") or clean_cmd.startswith("変更") or clean_cmd.startswith("ペルソナ"):
                    parts = re.split(r"[\s:：]+", clean_cmd, maxsplit=1)
                    if len(parts) > 1 and parts[1].strip():
                        target_query = parts[1].strip()
                        found = find_persona_by_query(target_query)
                        if found:
                            bind_line_user_to_persona(user_id, found["id"])
                            set_default_line_persona_id(found["id"])
                            name = found["name"]
                            nick = found.get("nickname", name)
                            reply_msg = f"【切り替え完了】\nこれからは「{name} ({nick})」のAIとして会話＆学習します！\nたくさんお話ししてね！"
                            reply_line_message(reply_token, reply_msg, token)
                            continue
                        else:
                            reply_msg = f"「{target_query}」に一致するペルソナが見つかりませんでした。「一覧」と送ると登録済みリストを確認できます。"
                            reply_line_message(reply_token, reply_msg, token)
                            continue

                # 現在のペルソナ情報取得
                p_data = get_persona(target_pid) or {}
                p_nick = p_data.get("nickname", p_data.get("name", "本人"))
                print(f"\n[LINE受信 (対象: {p_nick})] {user_text}", flush=True)

                # Gemini でインタビュー返信を生成
                ai_reply = generate_interview_reply(user_text, user_id, gemini_key)
                print(f"[LINE返信] AI: \"{ai_reply}\"", flush=True)

                # LINEに返信
                reply_line_message(reply_token, ai_reply, token)

                # 会話ログを対象ペルソナIDと紐付けて保存
                save_line_log(user_id, user_text, ai_reply, person_id=target_pid)

    return "OK", 200


@app.post("/api/line/proactive")
def api_line_proactive():
    """Geminiが多彩な話題カテゴリから自発的にLINEで質問を送信"""
    secret, token = get_line_credentials()
    if not secret or not token:
        return error("LINE のクレデンシャルが設定されていません", 400)

    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error("Gemini API キーが設定されていません", 400)

    data = request.get_json(silent=True) or {}
    category_id = data.get("category_id")
    person_id = data.get("person_id")

    result = send_proactive_question_to_users(
        gemini_key, token, category_id=category_id, person_id=person_id
    )
    if not result.get("success"):
        return error(result.get("message", "自発質問の送信に失敗しました"), 400)

    return jsonify(result)


@app.post("/api/line/learn")
def api_line_learn():
    """蓄積されたLINE会話ログから該当人物の persona.txt を自動学習・更新"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error("Gemini API キーが設定されていません", 400)

    data = request.get_json(silent=True) or {}
    person_id = str(data.get("person_id", "taku")).strip()

    result = update_persona_from_logs(gemini_key, person_id=person_id)
    if not result.get("success"):
        return error(result.get("message", "学習に失敗しました"), 400)

    return jsonify(result)


@app.post("/api/line/import")
def api_line_import():
    """LINE公式アカウント管理画面のチャット欄テキスト等を解析し、会話ログ復元＆学習"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error("Gemini API キーが設定されていません", 400)

    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    auto_learn = bool(data.get("auto_learn", True))
    person_id = str(data.get("person_id", "taku")).strip()

    if not text:
        return error("チャット履歴のテキストを入力してください。", 400)

    try:
        result = import_line_chat_history(text, gemini_key, auto_learn=auto_learn, person_id=person_id)
    except Exception as e:
        print(f"[ERROR] LINE履歴インポート例外: {e}")
        return error(f"インポート処理中にエラーが発生しました: {e}", 500)
    if not result.get("success"):
        return error(result.get("message", "チャット履歴の取り込みに失敗しました"), 400)

    return jsonify(result)



# ---------- アバター映像 (Ditto TalkingHead) 連携エンドポイント ----------

AVATARS_DIR = WEB_DIR / "avatars"
VIDEOS_DIR = WEB_DIR / "videos"
PERF_LOG_DIR = BASE_DIR / "logs"
PERF_LOG_FILE = PERF_LOG_DIR / "performance.log"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
PERF_LOG_DIR.mkdir(parents=True, exist_ok=True)


def append_perf_log(entry_text: str) -> None:
    """会話・音声合成・映像生成の速度計測ログをファイルとコンソールに残す"""
    ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts_str}] {entry_text}\n"
    try:
        with open(PERF_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        print(f"[WARN] ログ書き込み失敗: {e}", flush=True)

_avatar_state_lock = threading.Lock()
_avatar_state = {
    "source_filename": "AbeHiroshi.jpg" if (AVATARS_DIR / "AbeHiroshi.jpg").exists() else "default.png",
    "status": "idle",       # "idle" | "generating" | "ready" | "error"
    "status_text": "待機中",
    "video_id": 0,
    "video_url": None,
    "reply_text": "",
    "persona_name": "市川 拓",
    "updated_at": time.time(),
}


_idle_generating_set: set[str] = set()


def get_idle_video_urls_for_source(source_filename: str, trigger_if_missing: bool = True) -> list[str]:
    """指定された顔画像に対応する待機用ループ動画URL一覧（最大3パターン）を返す（不足があれば裏で生成開始）"""
    if not source_filename:
        return []
    src_path = AVATARS_DIR / source_filename
    if not src_path.exists():
        return []
    if src_path.suffix.lower() == ".mp4":
        return [f"/avatars/{source_filename}"]

    safe_stem = "".join(c if c.isalnum() or c in "._-" else "_" for c in src_path.stem)
    suffixes = ["", "_v2", "_v3"]
    urls: list[str] = []
    missing_any = False

    for suf in suffixes:
        idle_name = f"idle_{safe_stem}{suf}.mp4"
        idle_path = VIDEOS_DIR / idle_name
        if idle_path.exists() and idle_path.stat().st_size > 1000:
            idle_mtime = idle_path.stat().st_mtime
            if idle_mtime >= src_path.stat().st_mtime:
                urls.append(f"/videos/{idle_name}?v={int(idle_mtime)}")
                continue
        missing_any = True

    if missing_any and trigger_if_missing and source_filename not in _idle_generating_set:
        _idle_generating_set.add(source_filename)
        from ditto_engine import warmup_ditto_Async

        def _on_done(_p):
            _idle_generating_set.discard(source_filename)

        warmup_ditto_Async(src_path, VIDEOS_DIR, on_idle_ready=_on_done)
    return urls


def get_idle_video_url_for_source(source_filename: str, trigger_if_missing: bool = True) -> str | None:
    """指定された顔画像に対応する待機用ループ動画URL（先頭1件）を返す"""
    urls = get_idle_video_urls_for_source(source_filename, trigger_if_missing=trigger_if_missing)
    return urls[0] if urls else None


def update_avatar_state(**kwargs):
    with _avatar_state_lock:
        _avatar_state.update(kwargs)
        _avatar_state["updated_at"] = time.time()
        return dict(_avatar_state)


@app.get("/avatar")
def avatar_view_page():
    """映像専用ウィンドウ（アバター画面）"""
    return send_from_directory(WEB_DIR, "avatar.html")


@app.get("/chat")
def chat_view_page():
    """チャット専用ページ（クエリ ?mode=chat 相当）"""
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/api/avatar/sources")
def api_get_avatar_sources():
    """利用可能なアバター顔画像一覧と現在選択中のソースを返す"""
    files = []
    for p in sorted(AVATARS_DIR.iterdir()):
        if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".mp4"}:
            files.append({
                "filename": p.name,
                "url": f"/avatars/{p.name}",
                "idle_video_url": get_idle_video_url_for_source(p.name, trigger_if_missing=False),
            })
    with _avatar_state_lock:
        current = _avatar_state.get("source_filename", "")
        if current and not (AVATARS_DIR / current).exists() and files:
            current = files[0]["filename"]
            _avatar_state["source_filename"] = current
    idle_urls = get_idle_video_urls_for_source(current, trigger_if_missing=True) if current else []
    return jsonify(
        sources=files,
        current_source=current,
        current_url=f"/avatars/{current}" if current else None,
        idle_video_url=idle_urls[0] if idle_urls else None,
        idle_video_urls=idle_urls,
    )


@app.post("/api/avatar/sources")
def api_set_or_upload_avatar_source():
    """アバター顔画像のアップロードまたは選択切り替え"""
    from ditto_engine import warmup_ditto_Async
    if "file" in request.files:
        f = request.files["file"]
        if not f or not f.filename:
            return error("画像ファイルを選択してください。", 400)
        ext = Path(f.filename).suffix.lower()
        if ext not in {".png", ".jpg", ".jpeg", ".webp", ".mp4"}:
            return error("対応形式は png / jpg / jpeg / webp / mp4 です。", 400)
        safe_name = re.sub(r'[\\/:*?"<>|]', "_", Path(f.filename).name)
        save_path = AVATARS_DIR / safe_name
        f.save(str(save_path))
        st = update_avatar_state(source_filename=safe_name)
        warmup_ditto_Async(save_path, VIDEOS_DIR)
        idle_urls = get_idle_video_urls_for_source(safe_name, trigger_if_missing=False)
        st["idle_video_url"] = idle_urls[0] if idle_urls else None
        st["idle_video_urls"] = idle_urls
        return jsonify(
            status="ok",
            current_source=safe_name,
            current_url=f"/avatars/{safe_name}",
            idle_video_url=st["idle_video_url"],
            idle_video_urls=idle_urls,
            state=st,
        )

    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()
    if not filename or not (AVATARS_DIR / filename).exists():
        return error("指定されたアバター画像が見つかりません。", 404)
    st = update_avatar_state(source_filename=filename)
    warmup_ditto_Async(AVATARS_DIR / filename, VIDEOS_DIR)
    idle_urls = get_idle_video_urls_for_source(filename, trigger_if_missing=False)
    st["idle_video_url"] = idle_urls[0] if idle_urls else None
    st["idle_video_urls"] = idle_urls
    return jsonify(
        status="ok",
        current_source=filename,
        current_url=f"/avatars/{filename}",
        idle_video_url=st["idle_video_url"],
        idle_video_urls=idle_urls,
        state=st,
    )


@app.get("/api/avatar/state")
def api_get_avatar_state():
    """現在のアバター映像状態（別画面・別タブ同期用）"""
    with _avatar_state_lock:
        st = dict(_avatar_state)
    src = st.get("source_filename", "")
    st["source_url"] = f"/avatars/{src}" if src else None
    idle_urls = get_idle_video_urls_for_source(src, trigger_if_missing=True) if src else []
    st["idle_video_url"] = idle_urls[0] if idle_urls else None
    st["idle_video_urls"] = idle_urls
    return jsonify(st)


_avatar_tasks_lock = threading.Lock()
_avatar_tasks: dict[str, dict] = {}


def run_avatar_generation_from_bytes(
    raw_audio_list: list[bytes],
    reply_text: str,
    persona_name: str = "AI",
    req_source: str = "",
) -> dict:
    """サーバー上の音声バイト列から直接リップシンク映像を生成し、結果辞書を返す"""
    with _avatar_state_lock:
        source_filename = req_source if req_source else _avatar_state.get("source_filename", "")

    source_path = AVATARS_DIR / source_filename
    if not source_filename or not source_path.exists():
        candidates = list(AVATARS_DIR.glob("*.*"))
        if not candidates:
            raise ValueError("アバター用の顔画像が登録されていません。")
        source_path = candidates[0]
        source_filename = source_path.name

    update_avatar_state(
        source_filename=source_filename,
        status="generating",
        status_text="映像を生成中...",
        reply_text=reply_text,
        persona_name=persona_name,
    )

    import subprocess
    import uuid
    import imageio_ffmpeg
    from ditto_engine import generate_talking_video

    t_req_start = time.time()
    ts = f"{int(t_req_start * 1000)}_{uuid.uuid4().hex[:4]}"
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()

    t_prep_start = time.time()
    seg_files = []
    for idx, raw_bytes in enumerate(raw_audio_list):
        seg_path = VIDEOS_DIR / f"seg_{ts}_{idx}.mp3"
        seg_path.write_bytes(raw_bytes)
        seg_files.append(seg_path)

    merged_wav_path = VIDEOS_DIR / f"audio_{ts}.wav"
    if len(seg_files) == 1:
        subprocess.run(
            [ffmpeg_exe, "-loglevel", "error", "-y", "-i", str(seg_files[0]), "-ar", "16000", "-ac", "1", str(merged_wav_path)],
            check=True,
        )
    else:
        concat_list_path = VIDEOS_DIR / f"concat_{ts}.txt"
        lines = [f"file '{p.name}'" for p in seg_files]
        concat_list_path.write_text("\n".join(lines), encoding="utf-8")
        subprocess.run(
            [ffmpeg_exe, "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list_path), "-ar", "16000", "-ac", "1", str(merged_wav_path)],
            check=True,
        )
        if concat_list_path.exists():
            concat_list_path.unlink()

    for p in seg_files:
        if p.exists():
            try:
                p.unlink()
            except Exception:
                pass
    audio_prep_sec = round(time.time() - t_prep_start, 2)

    out_video_name = f"talk_{ts}.mp4"
    out_video_path = VIDEOS_DIR / out_video_name

    _, ditto_timing = generate_talking_video(
        audio_path=merged_wav_path,
        source_path=source_path,
        output_path=out_video_path,
        sampling_timesteps=10,
        frame_stride=3,
        max_size=512,
    )

    if merged_wav_path.exists():
        try:
            merged_wav_path.unlink()
        except Exception:
            pass

    # 古い一時発話動画（60秒以上前）を掃除（待機用 idle_*.mp4 は残す）
    now_ts = time.time()
    for old_p in VIDEOS_DIR.glob("talk_*.mp4"):
        if old_p == out_video_path:
            continue
        try:
            if now_ts - old_p.stat().st_mtime > 60:
                old_p.unlink()
        except Exception:
            pass

    total_video_sec = round(time.time() - t_req_start, 2)
    video_timing = {
        **ditto_timing,
        "audio_prep_sec": audio_prep_sec,
        "total_video_sec": total_video_sec,
    }

    log_msg = (
        f"[AVATAR_VIDEO] total={total_video_sec:.2f}s "
        f"(audio_prep={audio_prep_sec:.2f}s, ditto_gpu={ditto_timing['ditto_gen_sec']:.2f}s, "
        f"sdk_load={ditto_timing['sdk_load_sec']:.2f}s) | "
        f"audio_len={ditto_timing['audio_duration_sec']}s, frames={ditto_timing['frames']}, "
        f"speed={ditto_timing['effective_fps']}fps, stride={ditto_timing['frame_stride']}, source={source_filename} | text=\"{reply_text}\""
    )
    print(f"\n[SPEED LOG] {log_msg}\n", flush=True)
    append_perf_log(log_msg)

    video_url = f"/videos/{out_video_name}"
    with _avatar_state_lock:
        new_vid = _avatar_state["video_id"] + 1
    st = update_avatar_state(
        status="ready",
        status_text=f"再生中 (生成 {total_video_sec:.1f}s)",
        video_id=new_vid,
        video_url=video_url,
        reply_text=reply_text,
        persona_name=persona_name,
    )
    return {
        "status": "ok",
        "video_id": new_vid,
        "video_url": video_url,
        "timing": video_timing,
        "state": st,
    }


_pending_delete_lock = threading.Lock()
_pending_delete_set: set[str] = set()


def cleanup_talk_videos() -> None:
    """待機映像 (idle_*.mp4) 以外の一時発話動画・中間ファイルをすべて削除する"""
    if not VIDEOS_DIR.exists():
        return
    for pattern in ("talk_*.mp4", "*.tmp.mp4", "seg_*.mp3", "audio_*.wav", "concat_*.txt", "silent_idle_*.wav"):
        for p in VIDEOS_DIR.glob(pattern):
            try:
                p.unlink()
            except Exception:
                pass


def schedule_delete_talk_video(filename: str, delay_sec: float = 2.5) -> None:
    """再生終了後に発話動画 (talk_*.mp4) を削除する（別画面との再生ズレ吸収のため短い猶予後に削除）"""
    if not filename or not filename.startswith("talk_") or not filename.endswith(".mp4"):
        return
    safe_name = Path(filename).name
    target = VIDEOS_DIR / safe_name
    if not target.exists():
        return
    with _pending_delete_lock:
        if safe_name in _pending_delete_set:
            return
        _pending_delete_set.add(safe_name)

    def _do_delete():
        try:
            if target.exists():
                target.unlink()
                print(f"[VideoCleanup] Deleted played talking video: {safe_name}", flush=True)
        except Exception as e:
            print(f"[VideoCleanup] Failed to delete {safe_name}: {e}", flush=True)
        finally:
            with _pending_delete_lock:
                _pending_delete_set.discard(safe_name)

    t = threading.Timer(delay_sec, _do_delete)
    t.daemon = True
    t.start()


@app.post("/api/avatar/video_played")
def api_avatar_video_played():
    """ブラウザ側で発話映像の再生が完了した通知を受け、待機状態へ戻しつつ動画を削除する"""
    data = request.get_json(silent=True) or {}
    video_url = str(data.get("video_url", "")).strip()
    filename = str(data.get("filename", "")).strip()
    if not filename and video_url:
        # /videos/talk_12345.mp4?t=... -> talk_12345.mp4
        clean_path = video_url.split("?", 1)[0]
        filename = Path(clean_path).name

    if filename:
        schedule_delete_talk_video(filename, delay_sec=2.5)

    with _avatar_state_lock:
        cur_url = _avatar_state.get("video_url") or ""
        if filename and cur_url.endswith(f"/{filename}"):
            _avatar_state["status"] = "idle"
            _avatar_state["status_text"] = "待機中"
            _avatar_state["updated_at"] = time.time()

    return jsonify(status="ok", scheduled_delete=filename)


def start_avatar_task_async(
    raw_audio_list: list[bytes],
    reply_text: str,
    persona_name: str,
    req_source: str = "",
) -> str:
    """TTS完了直後にバックグラウンドで動画生成を即時スタートし、task_idを返す"""
    import uuid
    task_id = f"av_{int(time.time() * 1000)}_{uuid.uuid4().hex[:4]}"
    ev = threading.Event()
    task_entry = {"event": ev, "result": None, "error": None, "created_at": time.time()}
    with _avatar_tasks_lock:
        # 古いタスクキャッシュを掃除
        now = time.time()
        for k in list(_avatar_tasks.keys()):
            if now - _avatar_tasks[k]["created_at"] > 120:
                del _avatar_tasks[k]
        _avatar_tasks[task_id] = task_entry

    def _worker():
        try:
            res = run_avatar_generation_from_bytes(raw_audio_list, reply_text, persona_name, req_source=req_source)
            task_entry["result"] = res
        except Exception as e:
            import traceback
            traceback.print_exc()
            update_avatar_state(status="error", status_text=f"映像生成エラー: {e}")
            task_entry["error"] = str(e)
        finally:
            ev.set()

    threading.Thread(target=_worker, daemon=True).start()
    return task_id


@app.post("/api/avatar/generate")
def api_generate_avatar_video():
    """
    先行開始された task_id の完了待ち、または音声データ (base64) から
    Ditto TalkingHead でリップシンク映像を生成し、完了後にアバター画面へ通知する。
    """
    data = request.get_json(silent=True) or {}
    task_id = str(data.get("task_id", "")).strip()
    if task_id:
        with _avatar_tasks_lock:
            task_entry = _avatar_tasks.get(task_id)
        if task_entry:
            task_entry["event"].wait(timeout=60)
            if task_entry["error"]:
                return error(f"映像生成に失敗しました: {task_entry['error']}", 500)
            if task_entry["result"]:
                return jsonify(task_entry["result"])

    audio_b64_list = data.get("audio_base64_list") or []
    single_b64 = data.get("audio_base64")
    if single_b64 and not audio_b64_list:
        audio_b64_list = [single_b64]

    if not audio_b64_list:
        return error("音声データがありません。", 400)

    reply_text = str(data.get("text", "")).strip()
    persona_name = str(data.get("persona_name", "AI")).strip()
    req_source = str(data.get("source_filename", "")).strip()

    try:
        raw_audio_list = []
        for b64_str in audio_b64_list:
            if "," in b64_str:
                _, b64_str = b64_str.split(",", 1)
            raw_audio_list.append(base64.b64decode(b64_str))
        res_dict = run_avatar_generation_from_bytes(raw_audio_list, reply_text, persona_name, req_source)
        return jsonify(res_dict)
    except Exception as e:
        import traceback
        traceback.print_exc()
        update_avatar_state(
            status="error",
            status_text=f"映像生成エラー: {e}",
        )
        return error(f"映像生成に失敗しました: {e}", 500)


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(WEB_DIR, path)


# ---------- エントリポイント ----------

def main() -> None:
    default_port = int(os.getenv("PORT", 5000))
    default_host = "0.0.0.0" if os.getenv("PORT") else "127.0.0.1"
    parser = argparse.ArgumentParser(description="クローン音声の読み上げ & AI対話 Web アプリ")
    parser.add_argument("--host", default=default_host)
    parser.add_argument("--port", type=int, default=default_port)
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}"
    print(f"起動しました → {url}  （終了は Ctrl+C）")

    # 起動時に古い一時発話動画を削除し、待機映像 (idle_*.mp4) だけを残す
    cleanup_talk_videos()
    _ensure_ollama_running()

    # 起動時にバックグラウンドで Ditto モデル＆デフォルト顔画像＆待機ループ動画をGPUメモリへプリロード
    try:
        from ditto_engine import warmup_ditto_Async
        default_src = AVATARS_DIR / _avatar_state.get("source_filename", "")
        warmup_ditto_Async(default_src if default_src.exists() else None, VIDEOS_DIR)
    except Exception as w_err:
        print(f"[WARN] Ditto 事前ウォームアップ失敗: {w_err}", flush=True)

    # LINE自発インタビュー定期スケジューラーを起動
    g_key = get_gemini_api_key()
    _, l_token = get_line_credentials()
    if g_key and l_token:
        start_proactive_scheduler(g_key, l_token)

    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
