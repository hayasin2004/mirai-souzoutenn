"""
簡易音声クローン プロトタイプ（Fish Audio API 使用）

使い方:
  python voice_clone.py clone  sample.wav --name myvoice      # 声のモデルを作成して保存
  python voice_clone.py say    "こんにちは" --voice myvoice    # クローン音声で読み上げ
  python voice_clone.py instant sample.wav "こんにちは"        # モデルを作らず1回だけクローン
  python voice_clone.py list                                   # 作成済みの声一覧
  python voice_clone.py delete myvoice                         # 声を削除

自分の声、または本人の同意を得た声だけを使ってください。
"""

import argparse
import json
import sys
import os           # ← 追加
import subprocess   # ← 追加
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fishaudio import FishAudio
from fishaudio.core import RequestOptions
from fishaudio.exceptions import (
    APIError,
    AuthenticationError,
    FishAudioError,
    NotFoundError,
    RateLimitError,
)
from fishaudio.types import ReferenceAudio, TTSConfig
from fishaudio.utils import save

# s2.1-pro-free: 無料のテスト用モデル（品質は s2.1-pro と同等、速度保証なし）
# 本番では "s2.1-pro" に変更（有料: $15 / 100万バイト）
DEFAULT_MODEL = "s2.1-pro-free"

BASE_DIR = Path(__file__).resolve().parent
VOICES_FILE = BASE_DIR / "voices.json"
OUTPUT_DIR = BASE_DIR / "output"

SUPPORTED_EXT = {".wav", ".mp3", ".m4a", ".opus"}


# ---------- voices.json（名前 → voice_id の対応表） ----------

def load_voices() -> dict:
    if VOICES_FILE.exists():
        return json.loads(VOICES_FILE.read_text(encoding="utf-8"))
    return {}


def save_voices(voices: dict) -> None:
    VOICES_FILE.write_text(json.dumps(voices, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_voice_id(name_or_id: str) -> str:
    voices = load_voices()
    if name_or_id in voices:
        return voices[name_or_id]["id"]
    return name_or_id  # 名前が見つからなければ voice_id として扱う


# ---------- 共通処理 ----------

def read_audio(path_str: str) -> bytes:
    path = Path(path_str)
    if not path.exists():
        sys.exit(f"[エラー] ファイルが見つかりません: {path}")
    if path.suffix.lower() not in SUPPORTED_EXT:
        sys.exit(f"[エラー] 対応形式は {', '.join(sorted(SUPPORTED_EXT))} です: {path.name}")
    data = path.read_bytes()
    if len(data) > 20 * 1024 * 1024:
        print("[注意] ファイルが大きいです。30秒〜2分程度に切り出すと安定します。")
    return data


def transcribe(client: FishAudio, audio: bytes, language: str) -> str:
    """参考音声を文字起こしする（クローン精度・発音が良くなる）。約$0.36/時間なので30秒なら0.3円程度。"""
    print("参考音声を文字起こし中...")
    result = client.asr.transcribe(
        audio=audio,
        language=language,
        request_options=RequestOptions(additional_headers={"model": "transcribe-1-pro"}),
    )
    duration = result.segments[-1].end if result.segments else 0
    print(f"  文字起こし: {result.text}")
    if duration:
        print(f"  音声の長さ: 約{duration:.0f}秒")
        if duration < 10:
            print("  [注意] 10秒未満だと似にくいです。15〜30秒以上を推奨します。")
    return result.text


def confirm_consent(skip: bool) -> None:
    if skip:
        return
    ans = input("この音声は自分の声、または本人の同意を得た声ですか？ [y/N]: ").strip().lower()
    if ans != "y":
        sys.exit("中止しました。")

def play_file(path: Path, enabled: bool) -> None:
    """保存した音声をOS標準のプレーヤーで再生する。"""
    if not enabled:
        return
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # Windows: 既定のアプリ（メディアプレーヤー等）で開く
        elif sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
        print("再生中...")
    except OSError as e:
        print(f"[注意] 自動再生できませんでした（{e}）。ファイルを直接開いてください。")


def output_path(out: str | None, fmt: str) -> Path:
    if out:
        return Path(out)
    OUTPUT_DIR.mkdir(exist_ok=True)
    return OUTPUT_DIR / f"tts_{datetime.now():%Y%m%d_%H%M%S}.{fmt}"


# ---------- サブコマンド ----------

def cmd_clone(client: FishAudio, args) -> None:
    confirm_consent(args.yes)
    audio = read_audio(args.audio)

    texts = None
    if args.text:
        texts = [args.text]
    elif not args.no_transcribe:
        texts = [transcribe(client, audio, args.lang)]

    voices = load_voices()
    if args.name in voices:
        sys.exit(f"[エラー] '{args.name}' はすでにあります。別の名前にするか delete してください。")

    print("声のモデルを作成中...")
    voice = client.voices.create(
        title=args.name,
        voices=[audio],
        texts=texts,
        visibility="private",          # 自分だけが使える
        enhance_audio_quality=True,    # ノイズ除去・音量調整
    )

    voices[args.name] = {
        "id": voice.id,
        "source": str(Path(args.audio).name),
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    save_voices(voices)
    print(f"完了: name={args.name}  voice_id={voice.id}  state={voice.state}")
    print(f'次はこれで試せます → python voice_clone.py say "こんにちは" --voice {args.name}')


def cmd_say(client: FishAudio, args) -> None:
    voice_id = resolve_voice_id(args.voice)
    config = TTSConfig(format=args.format, latency="normal")
    print(f"音声を生成中...（model={args.model}）")
    audio = client.tts.convert(
        text=args.text,
        reference_id=voice_id,
        speed=args.speed,
        config=config,
        model=args.model,
    )
    path = output_path(args.out, args.format)
    save(audio, str(path))
    print(f"保存しました: {path}")
    play_file(path, not args.no_play)


def cmd_instant(client: FishAudio, args) -> None:
    confirm_consent(args.yes)
    audio = read_audio(args.audio)
    ref_text = args.ref_text or transcribe(client, audio, args.lang)

    print(f"音声を生成中...（model={args.model}）")
    result = client.tts.convert(
        text=args.text,
        references=[ReferenceAudio(audio=audio, text=ref_text)],
        speed=args.speed,
        config=TTSConfig(format=args.format, latency="normal"),
        model=args.model,
    )
    path = output_path(args.out, args.format)
    save(result, str(path))
    print(f"保存しました: {path}")
    play_file(path, not args.no_play)

def cmd_list(client: FishAudio, args) -> None:
    voices = load_voices()
    if not voices:
        print("まだ声がありません。clone で作成してください。")
        return
    for name, v in voices.items():
        try:
            state = client.voices.get(v["id"]).state
        except NotFoundError:
            state = "（サーバー上に見つかりません）"
        print(f"- {name:15} id={v['id']}  state={state}  元音声={v.get('source', '')}")


def cmd_delete(client: FishAudio, args) -> None:
    voices = load_voices()
    voice_id = resolve_voice_id(args.voice)
    try:
        client.voices.delete(voice_id)
    except NotFoundError:
        print("サーバー上にはすでにありませんでした。")
    voices.pop(args.voice, None)
    save_voices(voices)
    print(f"削除しました: {args.voice}")


# ---------- エントリポイント ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Fish Audio を使った簡易音声クローン")
    sub = p.add_subparsers(dest="command", required=True)

    def add_tts_options(sp):
        sp.add_argument("--model", default=DEFAULT_MODEL, help=f"TTSモデル（既定: {DEFAULT_MODEL}）")
        sp.add_argument("--format", default="mp3", choices=["mp3", "wav", "opus"])
        sp.add_argument("--speed", type=float, default=None, help="話す速さ 0.5〜2.0")
        sp.add_argument("-o", "--out", help="保存先（省略時は output/ に日時名で保存）")
        sp.add_argument("--no-play", action="store_true", help="生成後に自動再生しない")

    sp = sub.add_parser("clone", help="参考音声から声のモデルを作る")
    sp.add_argument("audio", help="参考音声（wav/mp3/m4a/opus、15〜30秒以上推奨）")
    sp.add_argument("--name", required=True, help="この声につける名前")
    sp.add_argument("--text", help="参考音声で話している内容（省略時は自動で文字起こし）")
    sp.add_argument("--no-transcribe", action="store_true", help="文字起こしをしない")
    sp.add_argument("--lang", default="ja", help="文字起こしの言語（既定: ja）")
    sp.add_argument("-y", "--yes", action="store_true", help="同意確認をスキップ")
    sp.set_defaults(func=cmd_clone)

    sp = sub.add_parser("say", help="作成した声で読み上げる")
    sp.add_argument("text", help="読み上げる文章")
    sp.add_argument("--voice", required=True, help="clone でつけた名前、または voice_id")
    add_tts_options(sp)
    sp.set_defaults(func=cmd_say)

    sp = sub.add_parser("instant", help="モデルを作らず、その場でクローンして1回読み上げる")
    sp.add_argument("audio", help="参考音声")
    sp.add_argument("text", help="読み上げる文章")
    sp.add_argument("--ref-text", help="参考音声で話している内容（省略時は自動で文字起こし）")
    sp.add_argument("--lang", default="ja")
    sp.add_argument("-y", "--yes", action="store_true")
    add_tts_options(sp)
    sp.set_defaults(func=cmd_instant)

    sp = sub.add_parser("list", help="作成済みの声を一覧表示")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("delete", help="声を削除")
    sp.add_argument("voice", help="名前または voice_id")
    sp.set_defaults(func=cmd_delete)
    return p


def main() -> None:
    load_dotenv(BASE_DIR / ".env")
    args = build_parser().parse_args()
    try:
        client = FishAudio()  # 環境変数 FISH_API_KEY を読む
        args.func(client, args)
    except AuthenticationError:
        sys.exit("[エラー] APIキーが無効です。.env の FISH_API_KEY を確認してください。")
    except RateLimitError:
        sys.exit("[エラー] 同時リクエスト上限です。少し待ってから再実行してください。")
    except NotFoundError:
        sys.exit("[エラー] 指定した声が見つかりません。list で確認してください。")
    except APIError as e:
        sys.exit(f"[APIエラー {e.status}] {e.message}")
    except FishAudioError as e:
        sys.exit(f"[エラー] {e}")
    except httpx.HTTPError as e:
        sys.exit(f"[通信エラー] Fish Audio に接続できません: {e}")


if __name__ == "__main__":
    main()
