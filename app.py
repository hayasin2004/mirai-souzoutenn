"""
ブラウザで文字を入力して、クローンした声でその場で読み上げる Web アプリ。

起動:
  python app.py                 # http://127.0.0.1:5000 がブラウザで自動的に開きます
  python app.py --port 8000     # ポートを変更
  python app.py --no-browser    # ブラウザを自動で開かない

声の登録は従来どおり CLI で行います:
  python voice_clone.py clone my_voice.wav --name tako

生成した音声はファイルに保存せず、そのままブラウザへ返して再生します。
"""

import argparse
import threading
import webbrowser

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
MAX_TEXT_LENGTH = 1000
SPEED_RANGE = (0.5, 2.0)

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="")

_client: FishAudio | None = None
_client_lock = threading.Lock()


def get_client() -> FishAudio:
    """FishAudio クライアントを初回アクセス時に1つだけ作る（APIキー未設定でもサーバー自体は起動できるように）。"""
    global _client
    with _client_lock:
        if _client is None:
            _client = FishAudio()  # 環境変数 FISH_API_KEY を読む
        return _client


def error(message: str, status: int):
    return jsonify(error=message), status


# ---------- ルーティング ----------

@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/api/voices")
def api_voices():
    voices = load_voices()
    return jsonify(
        voices=[{"name": name, "id": v["id"]} for name, v in voices.items()],
        model=DEFAULT_MODEL,
        max_length=MAX_TEXT_LENGTH,
    )


@app.post("/api/tts")
def api_tts():
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
        client = get_client()
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


# ---------- エントリポイント ----------

def main() -> None:
    parser = argparse.ArgumentParser(description="クローン音声の読み上げ Web アプリ")
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
