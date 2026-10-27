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
PERSONA_FILE = BASE_DIR / "persona.txt"
MAX_TEXT_LENGTH = 1000
SPEED_RANGE = (0.5, 2.0)

app = Flask(__name__)

_fish_client: FishAudio | None = None
_fish_lock = threading.Lock()


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
        res_list.append({
            "name": name,
            "id": v.get("id"),
            "source": v.get("source", "-"),
            "created_at": v.get("created_at", "-"),
        })
    return jsonify(
        voices=res_list,
        model=DEFAULT_MODEL,
        max_length=MAX_TEXT_LENGTH,
    )


@app.post("/api/voices")
def api_create_voice():
    """新しい声の追加（ID直接指定、または音声ファイルアップロードでのクローン生成）"""
    voices = load_voices()

    # 1. 音声ファイルアップロードの場合 (multipart/form-data)
    if "audio" in request.files:
        audio_file = request.files["audio"]
        name = request.form.get("name", "").strip()
        ref_text = request.form.get("ref_text", "").strip()
        if not name:
            return error("声の名前を入力してください。", 400)
        if name in voices:
            return error(f"声の名前 '{name}' は既に使用されています。", 400)
        if not audio_file or not audio_file.filename:
            return error("音声ファイルを選択してください。", 400)

        audio_bytes = audio_file.read()
        if not audio_bytes:
            return error("音声ファイルが空です。", 400)

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
            voices[name] = {
                "id": voice_id,
                "source": audio_file.filename,
                "created_at": datetime.now().isoformat(timespec="seconds"),
            }
            save_voices(voices)
            return jsonify(status="ok", name=name, id=voice_id)
        except Exception as e:
            return error(f"音声クローン作成に失敗しました: {str(e)}", 502)

    # 2. JSON で Reference ID 直接登録の場合
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    voice_id = str(data.get("id", "")).strip()

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
    }
    save_voices(voices)
    return jsonify(status="ok", name=name, id=voice_id)


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
    test_text = str(data.get("text", "")).strip() or "こんにちは。これはクローン音声のテスト発声です。"
    if not voice:
        return error("声を選択してください。", 400)

    try:
        fish_client = get_fish_client()
        audio = fish_client.tts.convert(
            text=test_text,
            reference_id=resolve_voice_id(voice),
            config=TTSConfig(format="mp3", latency="balanced"),
            model=DEFAULT_MODEL,
        )
        if not isinstance(audio, bytes):
            audio = b"".join(audio)
        return Response(audio, mimetype="audio/mpeg", headers={"Cache-Control": "no-store"})
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
    person_id = str(data.get("person_id", "taku")).strip()
    system_prompt = custom_persona if custom_persona else load_persona_text(person_id)

    def generate_sse():
        import json
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
