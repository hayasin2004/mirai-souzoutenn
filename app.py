"""
Mirai Voice Studio - バックエンドサーバー
1. クローン音声によるテキスト読み上げ (TTS)
2. Gemini API を使った「人格コピーAI」との音声対話 (Chat + TTS)
3. 顔写真からのリアル2.5Dアバター管理 (Face Mirror)

起動:
  python app.py                 # http://127.0.0.1:5000 が自動で開きます
"""

import argparse
import base64
import json
import os
import re
import shutil
import threading
import time
import uuid
import webbrowser
from datetime import datetime
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
from fishaudio.types import TTSConfig

from voice_clone import BASE_DIR, DEFAULT_MODEL, load_voices, resolve_voice_id

load_dotenv(BASE_DIR / ".env")

WEB_DIR = BASE_DIR / "web"
AVATARS_DIR = BASE_DIR / "avatars"
AVATARS_INDEX_FILE = AVATARS_DIR / "avatars.json"
PERSONA_FILE = BASE_DIR / "persona.txt"
MAX_TEXT_LENGTH = 1000
SPEED_RANGE = (0.5, 2.0)

AVATARS_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 写真複数枚アップロード用に50MB上限

_fish_client: FishAudio | None = None
_fish_lock = threading.Lock()
_avatar_lock = threading.Lock()


def get_fish_client() -> FishAudio:
    """FishAudio クライアントを取得"""
    global _fish_client
    with _fish_lock:
        if _fish_client is None:
            _fish_client = FishAudio()
        return _fish_client


def get_gemini_api_key() -> str | None:
    # 実行時に環境変数を再読み込み（.envの変更を反映できるように）
    load_dotenv(BASE_DIR / ".env", override=True)
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    return key if key else None


def load_persona_text() -> str:
    if PERSONA_FILE.exists():
        return PERSONA_FILE.read_text(encoding="utf-8")
    return (
        "あなたは親しい友人です。明るく親身に、自然なタメ口で短く（2〜3文で）話してください。\n"
        "音声合成で読み上げるため、絵文字やマークダウン記号は絶対に使わないでください。"
    )


def save_persona_text(text: str) -> None:
    PERSONA_FILE.write_text(text, encoding="utf-8")


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


# ---------- アバター管理ヘルパー ----------

def load_avatars_index() -> list[dict]:
    if not AVATARS_INDEX_FILE.exists():
        return []
    try:
        data = json.loads(AVATARS_INDEX_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_avatars_index(items: list[dict]) -> None:
    AVATARS_DIR.mkdir(exist_ok=True)
    AVATARS_INDEX_FILE.write_text(
        json.dumps(items, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def decode_data_url_image(data_url: str) -> tuple[bytes, str]:
    """data:image/png;base64,... 形式の文字列をデコードして (bytes, ext) を返す"""
    m = re.match(r"^data:image/([a-zA-Z0-9+.-]+);base64,(.+)$", data_url, re.DOTALL)
    if not m:
        raw = base64.b64decode(data_url)
        return raw, "png"
    fmt = m.group(1).lower()
    ext = "jpg" if fmt in ("jpeg", "jpg") else ("webp" if fmt == "webp" else "png")
    raw = base64.b64decode(m.group(2))
    return raw, ext


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
    return jsonify(
        voices=[{"name": name, "id": v["id"]} for name, v in voices.items()],
        model=DEFAULT_MODEL,
        max_length=MAX_TEXT_LENGTH,
    )


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


# ---------- Face Mirror アバター API ----------

@app.get("/api/avatars")
def api_list_avatars():
    """登録済みアバター一覧を取得"""
    with _avatar_lock:
        avatars = load_avatars_index()
    return jsonify(avatars=avatars)


@app.post("/api/avatars")
def api_create_avatar():
    """
    1枚または複数枚の顔写真からリアルアバターを登録する
    JSON Body:
      {
        "name": "拓（リアルアバター）",
        "photos": {
          "base": "data:image/png;base64,...",
          "open": "data:image/png;base64,...",   # 任意（口を開けた顔）
          "smile": "data:image/png;base64,...",  # 任意（笑顔）
          "extra": ["data:image/png;base64,..."] # 任意（追加アングル・表情）
        },
        "landmarks": { ... },
        "settings": { ... }
      }
    """
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip() or "マイアバター"
    photos = data.get("photos") or {}
    landmarks = data.get("landmarks") or {}
    settings = data.get("settings") or {}

    base_b64 = photos.get("base")
    if not base_b64:
        return error("ベースとなる正面の顔写真（少なくとも1枚）をアップロードしてください。", 400)

    avatar_id = uuid.uuid4().hex[:12]
    avatar_folder = AVATARS_DIR / avatar_id
    avatar_folder.mkdir(parents=True, exist_ok=True)

    saved_urls: dict[str, str | list[str]] = {}
    photo_count = 0

    try:
        for role_key in ("base", "open", "smile", "vtuber", "vtuber_open", "vtuber_smile", "vtuber_blink"):
            b64_str = photos.get(role_key)
            if b64_str and isinstance(b64_str, str):
                img_bytes, ext = decode_data_url_image(b64_str)
                fname = f"{role_key}.{ext}"
                (avatar_folder / fname).write_bytes(img_bytes)
                saved_urls[role_key] = f"/avatars/{avatar_id}/{fname}"
                photo_count += 1

        extra_list = photos.get("extra")
        if isinstance(extra_list, list):
            extra_urls = []
            for idx, b64_str in enumerate(extra_list[:6]):
                if b64_str and isinstance(b64_str, str):
                    img_bytes, ext = decode_data_url_image(b64_str)
                    fname = f"extra_{idx}.{ext}"
                    (avatar_folder / fname).write_bytes(img_bytes)
                    extra_urls.append(f"/avatars/{avatar_id}/{fname}")
                    photo_count += 1
            if extra_urls:
                saved_urls["extra"] = extra_urls

        avatar_entry = {
            "id": avatar_id,
            "name": name,
            "photos": saved_urls,
            "photo_count": photo_count,
            "landmarks": landmarks,
            "settings": settings,
            "created_at": datetime.now().isoformat(timespec="seconds"),
        }

        with _avatar_lock:
            avatars = load_avatars_index()
            avatars.insert(0, avatar_entry)
            save_avatars_index(avatars)

        return jsonify(status="ok", avatar=avatar_entry)
    except Exception as e:
        shutil.rmtree(avatar_folder, ignore_errors=True)
        return error(f"アバター画像の保存に失敗しました: {e}", 500)


@app.put("/api/avatars/<avatar_id>")
def api_update_avatar(avatar_id: str):
    """アバターの設定やランドマーク微調整、追加写真を更新する"""
    data = request.get_json(silent=True) or {}
    with _avatar_lock:
        avatars = load_avatars_index()
        target = next((a for a in avatars if a.get("id") == avatar_id), None)
        if not target:
            return error("指定されたアバターが見つかりません。", 404)

        if "name" in data and str(data["name"]).strip():
            target["name"] = str(data["name"]).strip()
        if "landmarks" in data and isinstance(data["landmarks"], dict):
            target["landmarks"] = data["landmarks"]
        if "settings" in data and isinstance(data["settings"], dict):
            target["settings"] = data["settings"]

        new_photos = data.get("photos")
        if isinstance(new_photos, dict):
            avatar_folder = AVATARS_DIR / avatar_id
            avatar_folder.mkdir(parents=True, exist_ok=True)
            saved_urls = dict(target.get("photos") or {})
            for role_key in ("base", "open", "smile", "vtuber", "vtuber_open", "vtuber_smile", "vtuber_blink"):
                b64_str = new_photos.get(role_key)
                if b64_str and isinstance(b64_str, str) and b64_str.startswith("data:"):
                    img_bytes, ext = decode_data_url_image(b64_str)
                    fname = f"{role_key}.{ext}"
                    (avatar_folder / fname).write_bytes(img_bytes)
                    saved_urls[role_key] = f"/avatars/{avatar_id}/{fname}"
            target["photos"] = saved_urls
            target["photo_count"] = sum(
                1 for k in ("base", "open", "smile") if saved_urls.get(k)
            ) + len(saved_urls.get("extra", []))

        save_avatars_index(avatars)
        return jsonify(status="ok", avatar=target)


@app.delete("/api/avatars/<avatar_id>")
def api_delete_avatar(avatar_id: str):
    """アバターを削除"""
    with _avatar_lock:
        avatars = load_avatars_index()
        new_avatars = [a for a in avatars if a.get("id") != avatar_id]
        if len(new_avatars) == len(avatars):
            return error("アバターが見つかりません。", 404)
        save_avatars_index(new_avatars)

    avatar_folder = AVATARS_DIR / avatar_id
    if avatar_folder.exists() and avatar_folder.is_dir():
        shutil.rmtree(avatar_folder, ignore_errors=True)

    return jsonify(status="ok")


@app.post("/api/avatars/generate-ai")
def api_generate_ai_avatar():
    """
    顔写真を Gemini Vision AI で詳細解析し、写真そのものを貼り付けるのではなく
    本人の特徴（輪郭・髪型・前髪の分け目・目元・眉・鼻・口・メガネ・ヒゲ・肌色・髪色）を忠実に反映した
    「完全新規の首から上デジタルアバター（アルターエゴ風）」を構築するための設計データ (avatar_spec) を生成する。
    """
    data = request.get_json(silent=True) or {}
    photo_b64 = data.get("photo", "")
    if not photo_b64:
        return error("ベースとなる顔写真データがありません。", 400)

    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return jsonify(
            status="local_only",
            message="Gemini APIキーが未設定のため、ローカル画像解析で新規アバターを生成しました。",
        )

    try:
        from google import genai
        from google.genai import types

        img_bytes, ext = decode_data_url_image(photo_b64)
        mime_type = "image/jpeg" if ext == "jpg" else f"image/{ext}"

        gclient = genai.Client(api_key=gemini_key)

        analysis_prompt = """
あなたは人物の顔写真から「本人そっくりの2.5Dデジタルアバター（首から上だけ）」を新規描画するための特徴解析AIです。
添付された人物写真の顔立ち・髪型・特徴を細かく観察し、以下のJSON形式のみを出力してください（マークダウンのコードブロックは不要、純粋なJSONのみ）：

{
  "gender_vibe": "male" | "female" | "neutral",
  "face_shape": "oval" | "round" | "sharp" | "square" | "long",
  "jaw_taper": 0.75〜1.25の数値（0.8=シャープな顎、1.0=標準、1.2=しっかりしたエラ）,
  "skin_hex": "#f0c4a8のような明るい自然な肌色HEX",
  "skin_shadow_hex": "#c9967aのような肌の影色HEX",
  "hair_style": "short_crop" | "short_spiky" | "short_neat" | "medium_parted" | "bob" | "long_straight" | "long_wavy" | "curly" | "updo",
  "bangs_style": "parted_center" | "parted_left" | "parted_right" | "full_down" | "swept_side" | "forehead_open",
  "hair_volume": 0.8〜1.35の数値,
  "hair_hex": "#1c1b24のような髪色HEX",
  "hair_highlight_hex": "#3a384aのような髪のハイライト色HEX",
  "eyebrow_style": "straight" | "arched" | "thick" | "thin" | "sharp" | "gentle",
  "eyebrow_thickness": 0.7〜1.5の数値,
  "eyebrow_tilt": -0.25〜0.25の数値（プラスがつり眉、マイナスが下がり眉）,
  "eye_shape": "almond" | "round" | "narrow" | "monolid" | "double_eyelid" | "droopy" | "sharp",
  "eye_size": 0.8〜1.25の数値,
  "eye_slant": -0.25〜0.25の数値（プラスがつり目、マイナスがたれ目）,
  "double_eyelid": true | false,
  "eye_bags": true | false,
  "iris_hex": "#261a14のような瞳の色HEX",
  "nose_style": "straight" | "small" | "rounded" | "sharp",
  "mouth_width_scale": 0.85〜1.2の数値,
  "lip_thickness": 0.7〜1.3の数値,
  "lip_hex": "#cc7a74のような自然な唇色HEX",
  "glasses": "none" | "round" | "square" | "boston" | "half_rim",
  "glasses_hex": "#1e1e24のようなメガネフレーム色HEX",
  "facial_hair": "none" | "stubble" | "mustache" | "goatee" | "beard",
  "mole": "none" | "left_cheek" | "right_cheek" | "under_left_eye" | "under_right_eye" | "mouth_left" | "mouth_right"
}
""".strip()

        candidate_models = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"]
        raw_json_text = ""
        for model_name in candidate_models:
            try:
                res = gclient.models.generate_content(
                    model=model_name,
                    contents=[
                        types.Part.from_bytes(data=img_bytes, mime_type=mime_type),
                        analysis_prompt,
                    ],
                    config=types.GenerateContentConfig(
                        temperature=0.2,
                        max_output_tokens=800,
                    ),
                )
                if res and res.text:
                    raw_json_text = res.text.strip()
                    break
            except Exception as inner_e:
                print(f"[WARN] Gemini Vision ({model_name}) 試行エラー: {inner_e}", flush=True)
                continue

        if raw_json_text:
            cleaned = re.sub(r"^```(?:json)?s*", "", raw_json_text)
            cleaned = re.sub(r"s*```$", "", cleaned).strip()
            m = re.search(r"{[sS]*}", cleaned)
            if m:
                spec = json.loads(m.group(0))
                print(f"[DEBUG] Gemini Vision アバター特徴解析完了: {spec}", flush=True)
                return jsonify(
                    status="ok",
                    provider="gemini_vision",
                    avatar_spec=spec,
                    message="✨ Gemini AIが写真の顔立ち・髪型・特徴を解析し、完全新規アバターを生成しました！",
                )
    except Exception as e:
        print(f"[WARN] Gemini Vision アバター解析エラー: {e}", flush=True)

    return jsonify(
        status="local_only",
        provider="local_analyzer",
        message="✨ 写真のランドマークと色彩・髪型シルエットを解析し、完全新規アバターを生成しました！",
    )


@app.get("/avatars/<path:filename>")
def serve_avatar_file(filename: str):
    return send_from_directory(AVATARS_DIR, filename)


# ---------- TTS & AI対話エンドポイント ----------

@app.post("/api/tts")
def api_tts():
    """テキストを直接読み上げ"""
    data = request.get_json(silent=True) or {}
    text = str(data.get("text", "")).strip()
    voice = str(data.get("voice", "")).strip()

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
        client = get_fish_client()
    except ValueError:
        return error("APIキーが設定されていません。.env の FISH_API_KEY を確認してください。", 500)

    try:
        audio = client.tts.convert(
            text=text,
            reference_id=resolve_voice_id(voice),
            speed=speed,
            config=TTSConfig(format="mp3", latency="balanced"),
            model=DEFAULT_MODEL,
        )
    except AuthenticationError:
        return error("APIキーが無効です。.env の FISH_API_KEY を確認してください。", 401)
    except RateLimitError:
        return error("同時リクエスト上限です。少し待ってから再実行してください。", 429)
    except NotFoundError:
        return error("指定した声が見つかりません。voice_clone.py list で確認してください。", 404)
    except APIError as e:
        return error(f"APIエラー {e.status}: {e.message}", 502)
    except FishAudioError as e:
        return error(f"エラー: {e}", 500)
    except httpx.HTTPError as e:
        return error(f"Fish Audio に接続できません: {e}", 502)

    if not isinstance(audio, bytes):
        audio = b"".join(audio)

    return Response(audio, mimetype="audio/mpeg", headers={"Cache-Control": "no-store"})


def synthesize_speech_segment(text: str, voice: str, speed: float | None = None) -> bytes:
    fish_client = get_fish_client()
    audio = fish_client.tts.convert(
        text=text,
        reference_id=resolve_voice_id(voice),
        speed=speed,
        config=TTSConfig(format="mp3", latency="balanced"),
        model=DEFAULT_MODEL,
    )
    if not isinstance(audio, bytes):
        audio = b"".join(audio)
    return audio


@app.post("/api/chat/stream")
def api_chat_stream():
    """Geminiの回答テキストとFish Audio音声合成を文単位でストリーミングするSSEエンドポイント"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error(
            "Gemini API キーが設定されていません。.env ファイルの GEMINI_API_KEY にキーを記載してください。",
            400,
        )

    data = request.get_json(silent=True) or {}
    message = str(data.get("message", "")).strip()
    voice = str(data.get("voice", "")).strip()
    history = data.get("history", [])
    custom_persona = data.get("persona")
    enable_tts = bool(data.get("enable_tts", False))

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
    system_prompt = custom_persona if custom_persona else load_persona_text()

    def generate_sse():
        from google import genai
        from google.genai import types

        t_first_audio = None
        full_reply_chunks = []
        sentence_buffer = ""
        delimiters = set("。！？!?\n")
        segment_index = 0
        total_tts_time = 0.0

        try:
            gemini_client = genai.Client(api_key=gemini_key)
            contents = []
            for h in history[-8:]:
                role = "user" if h.get("role") == "user" else "model"
                text_val = str(h.get("text", "")).strip()
                if text_val:
                    contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text_val)]))

            contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))
            speed_instruction = f"{system_prompt}\n\n【最重要ルール】音声合成のため、必ず1文または2文（50文字以内）の超短文で返答してください。"

            # Gemini ストリーミング呼び出し（503混雑時フォールバック対応）
            candidate_models = ["gemini-3.5-flash-lite", "gemini-flash-latest"]
            stream_iter = None
            first_chunk = None

            for model_name in candidate_models:
                try:
                    s_resp = gemini_client.models.generate_content_stream(
                        model=model_name,
                        contents=contents,
                        config=types.GenerateContentConfig(
                            system_instruction=speed_instruction,
                            temperature=0.7,
                            max_output_tokens=100,
                        ),
                    )
                    s_iter = iter(s_resp)
                    first_chunk = next(s_iter)
                    stream_iter = s_iter
                    break
                except Exception as m_err:
                    print(f"[DEBUG] モデル {model_name} 呼び出し失敗 (フォールバック試行): {m_err}", flush=True)
                    continue

            if first_chunk is None and stream_iter is None:
                yield f"data: {json.dumps({'type': 'error', 'message': 'Gemini API からの応答を取得できませんでした'})}\n\n"
                return

            t_gemini_start = time.time()
            t_gemini_first = None

            def process_sentence(sentence_text: str):
                nonlocal segment_index, total_tts_time, t_first_audio
                clean_s = clean_tts_text(sentence_text)
                if not clean_s or len(clean_s.strip()) < 1:
                    return None

                if enable_tts:
                    t_tts_s = time.time()
                    try:
                        audio_bytes = synthesize_speech_segment(clean_s, voice, speed)
                        tts_elapsed = time.time() - t_tts_s
                        total_tts_time += tts_elapsed
                        b64 = base64.b64encode(audio_bytes).decode("ascii")
                        now_since_start = round(time.time() - t_start, 2)
                        if t_first_audio is None:
                            t_first_audio = now_since_start

                        event_data = {
                            "type": "audio_segment",
                            "index": segment_index,
                            "text": clean_s,
                            "audio_base64": b64,
                            "latency_sec": now_since_start,
                        }
                        segment_index += 1
                        return f"data: {json.dumps(event_data, ensure_ascii=False)}\n\n"
                    except Exception as tts_err:
                        print(f"[DEBUG] セグメントTTS失敗: {tts_err}", flush=True)
                        return None
                return None

            import itertools
            for chunk in itertools.chain([first_chunk], stream_iter):
                chunk_text = chunk.text or ""
                if not chunk_text:
                    continue

                if t_gemini_first is None:
                    t_gemini_first = round(time.time() - t_gemini_start, 2)

                full_reply_chunks.append(chunk_text)
                sentence_buffer += chunk_text

                # テキストチャンクを即時送信（タイピング表示用）
                yield f"data: {json.dumps({'type': 'text_chunk', 'text': chunk_text}, ensure_ascii=False)}\n\n"

                # 文区切りの検査
                while True:
                    split_idx = -1
                    for i, ch in enumerate(sentence_buffer):
                        if ch in delimiters:
                            split_idx = i + 1
                            break
                        elif i >= 25 and ch in "、, ":
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

            # 残りの未処理テキスト
            if sentence_buffer.strip():
                audio_event = process_sentence(sentence_buffer)
                if audio_event:
                    yield audio_event

            full_reply = "".join(full_reply_chunks)
            total_sec = round(time.time() - t_start, 2)
            gemini_total = round(time.time() - t_gemini_start, 2)

            print(f"\n[DEBUG] ========================================", flush=True)
            print(f"[DEBUG] [STREAM] メッセージ: \"{message}\"", flush=True)
            print(f"[DEBUG] [STREAM] TTS設定   : {'ON' if enable_tts else 'OFF'}", flush=True)
            print(f"[DEBUG] [GEMINI初速]       : {t_gemini_first} 秒 (全完了: {gemini_total}秒)", flush=True)
            if enable_tts:
                print(f"[DEBUG] [音声初声]         : {t_first_audio} 秒", flush=True)
                print(f"[DEBUG] [全体完了時間]     : {total_sec} 秒", flush=True)
            else:
                print(f"[DEBUG] [全体完了時間]     : {total_sec} 秒", flush=True)
            print(f"[DEBUG] 返答内容           : \"{full_reply}\"", flush=True)
            print(f"[DEBUG] ========================================\n", flush=True)

            timing_info = {
                "gemini_first_sec": t_gemini_first or 0,
                "gemini_total_sec": gemini_total,
                "first_audio_sec": t_first_audio,
                "tts_total_sec": round(total_tts_time, 2),
                "total_sec": total_sec,
                "enable_tts": enable_tts,
            }

            yield f"data: {json.dumps({'type': 'done', 'reply': full_reply, 'voice': voice, 'timing': timing_info}, ensure_ascii=False)}\n\n"

        except Exception as e:
            print(f"[DEBUG] ストリーミング処理エラー: {e}", flush=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    from flask import stream_with_context
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

    # 人格プロンプト
    system_prompt = custom_persona if custom_persona else load_persona_text()

    # 1. Gemini で回答を生成
    t_gemini_start = time.time()
    try:
        from google import genai
        from google.genai import types

        gemini_client = genai.Client(api_key=gemini_key)

        # チャット履歴をフォーマット
        contents = []
        for h in history[-8:]:  # 直近8往復程度に制限してトークン節約＆コンテキスト保持
            role = "user" if h.get("role") == "user" else "model"
            text_val = str(h.get("text", "")).strip()
            if text_val:
                contents.append(types.Content(role=role, parts=[types.Part.from_text(text=text_val)]))

        # 今回のユーザー発言を追加
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=message)]))

        # 高速応答のため短文指定を追加
        speed_instruction = f"{system_prompt}\n\n【最重要ルール】音声合成のため、必ず1文または2文（50文字以内）の超短文で返答してください。"

        # 最速・低遅延の flash-lite モデルを使用（混雑時フォールバック付き）
        candidate_models = ["gemini-3.5-flash-lite", "gemini-flash-latest"]
        response = None
        last_exc = None
        for model_name in candidate_models:
            try:
                response = gemini_client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=speed_instruction,
                        temperature=0.7,
                        max_output_tokens=100,
                    ),
                )
                if response and response.text:
                    break
            except Exception as err:
                last_exc = err
                continue

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
    reply_line_message,
    generate_interview_reply,
    update_persona_from_logs,
)


@app.get("/api/line/status")
def api_line_status():
    """LINE連携の状態と蓄積ログのサマリーを返す"""
    secret, token = get_line_credentials()
    logs = load_line_logs()
    unlearned_count = sum(1 for l in logs if not l.get("learned", False))
    return jsonify(
        configured=bool(secret and token),
        total_logs=len(logs),
        unlearned_logs=unlearned_count,
        recent_logs=logs[-10:],
    )


@app.post("/api/line/webhook")
def api_line_webhook():
    """LINE Messaging API からの Webhook を処理"""
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
        if ev_type == "message":
            msg_obj = event.get("message", {})
            if msg_obj.get("type") == "text":
                user_text = msg_obj.get("text", "").strip()
                reply_token = event.get("replyToken")
                user_id = event.get("source", {}).get("userId", "unknown_user")

                if not user_text or not reply_token:
                    continue

                print(f"\n[LINE受信] 拓さん: \"{user_text}\"", flush=True)

                # Gemini でインタビュー返信を生成
                ai_reply = generate_interview_reply(user_text, user_id, gemini_key)
                print(f"[LINE返信] AI: \"{ai_reply}\"", flush=True)

                # LINEに返信
                reply_line_message(reply_token, ai_reply, token)

                # 会話ログを保存
                save_line_log(user_id, user_text, ai_reply)

    return "OK", 200


@app.post("/api/line/learn")
def api_line_learn():
    """蓄積されたLINE会話ログから persona.txt を自動学習・更新"""
    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return error("Gemini API キーが設定されていません", 400)

    result = update_persona_from_logs(gemini_key)
    if not result.get("success"):
        return error(result.get("message", "学習に失敗しました"), 400)

    return jsonify(result)


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(WEB_DIR, path)


# ---------- エントリポイント ----------

def main() -> None:
    parser = argparse.ArgumentParser(description="クローン音声の読み上げ & AI対話 Web アプリ")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--no-browser", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    url = f"http://{args.host}:{args.port}"
    print(f"起動しました → {url}  （終了は Ctrl+C）")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()

    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
