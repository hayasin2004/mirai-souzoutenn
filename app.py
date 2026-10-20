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
from fishaudio.types import TTSConfig

from voice_clone import BASE_DIR, DEFAULT_MODEL, load_voices, resolve_voice_id

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
            config=TTSConfig(format="mp3", latency="normal"),
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


@app.post("/api/chat")
def api_chat():
    """Gemini API で人格に沿った回答を生成し、その声で音声合成して返す"""
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

    # 人格プロンプト
    system_prompt = custom_persona if custom_persona else load_persona_text()

    # 1. Gemini で回答を生成
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

        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=0.8,
                max_output_tokens=300,
            ),
        )
        reply_raw = response.text or ""
    except Exception as e:
        return error(f"Gemini API エラー: {str(e)}", 502)

    clean_reply = clean_tts_text(reply_raw)
    if not clean_reply:
        clean_reply = "うまく答えられなかったよ。もう一度聞いてみて！"

    # 2. Fish Audio で音声合成
    try:
        fish_client = get_fish_client()
        audio = fish_client.tts.convert(
            text=clean_reply,
            reference_id=resolve_voice_id(voice),
            speed=speed,
            config=TTSConfig(format="mp3", latency="normal"),
            model=DEFAULT_MODEL,
        )
        if not isinstance(audio, bytes):
            audio = b"".join(audio)
    except Exception as e:
        # 音声合成が失敗してもテキストは返す
        return jsonify(
            reply=clean_reply,
            raw_reply=reply_raw,
            audio_base64=None,
            voice=voice,
            tts_error=f"音声の生成に失敗しました: {str(e)}",
        )

    b64_audio = base64.b64encode(audio).decode("ascii")
    return jsonify(
        reply=clean_reply,
        raw_reply=reply_raw,
        audio_base64=b64_audio,
        voice=voice,
    )


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
