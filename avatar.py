"""
自分の分身アバター プロトタイプ（fal.ai の Kling AI Avatar v2 使用）

顔写真 1 枚と音声から、その声に合わせて口・表情・頭が動く動画（mp4）を作る。

使い方:
  python avatar.py register face.jpg --name tako               # 顔写真をアバターとして登録
  python avatar.py speak test.mp3 --avatar tako                # 音声に合わせてしゃべる動画を作る
  python avatar.py speak test.mp3 --avatar tako --emotion 嬉しい
  python avatar.py say "[嬉しい]こんにちは" --voice tako --avatar tako  # 声のクローン → 動画まで一気に
  python avatar.py list                                        # 登録済みのアバター一覧
  python avatar.py delete tako                                 # アバターを削除

自分の顔、または本人の同意を得た顔だけを使ってください。
"""

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

import fal_client
import httpx
from dotenv import load_dotenv

# standard: $0.0562/秒、pro: $0.115/秒（調査日: 2026-11-02）
MODELS = {
    "standard": ("fal-ai/kling-video/ai-avatar/v2/standard", 0.0562),
    "pro": ("fal-ai/kling-video/ai-avatar/v2/pro", 0.115),
}

BASE_DIR = Path(__file__).resolve().parent
AVATARS_FILE = BASE_DIR / "avatars.json"
AVATARS_DIR = BASE_DIR / "avatars"
OUTPUT_DIR = BASE_DIR / "output"

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".ogg", ".aac"}

# 声の感情タグ（[嬉しい] など）→ 表情の指示。英語の方が効きやすい
EMOTION_PROMPTS = {
    "普通": "A person talking naturally to the camera with a calm, friendly expression.",
    "嬉しい": "A person talking to the camera with a bright smile and a happy, cheerful expression.",
    "怒る": "A person talking to the camera with an angry expression, frowning.",
    "悲しい": "A person talking to the camera with a sad, downcast expression.",
}
EMOTION_TAG = re.compile(r"^\s*\[([^\]]+)\]")


# ---------- avatars.json（名前 → 顔写真の対応表） ----------

def load_avatars() -> dict:
    if AVATARS_FILE.exists():
        return json.loads(AVATARS_FILE.read_text(encoding="utf-8"))
    return {}


def save_avatars(avatars: dict) -> None:
    AVATARS_FILE.write_text(json.dumps(avatars, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_avatar(name: str) -> Path:
    avatars = load_avatars()
    if name not in avatars:
        sys.exit(f"[エラー] アバター '{name}' がありません。list で確認するか register してください。")
    path = BASE_DIR / avatars[name]["image"]
    if not path.exists():
        sys.exit(f"[エラー] 顔写真が見つかりません: {path}")
    return path


# ---------- 共通処理 ----------

def check_file(path_str: str, allowed: set[str], kind: str) -> Path:
    path = Path(path_str)
    if not path.exists():
        sys.exit(f"[エラー] ファイルが見つかりません: {path}")
    if path.suffix.lower() not in allowed:
        sys.exit(f"[エラー] {kind}の対応形式は {', '.join(sorted(allowed))} です: {path.name}")
    return path


def confirm_consent(skip: bool) -> None:
    if skip:
        return
    ans = input("この写真は自分の顔、または本人の同意を得た顔ですか？ [y/N]: ").strip().lower()
    if ans != "y":
        sys.exit("中止しました。")


def emotion_prompt(emotion: str | None, prompt: str | None) -> str:
    if prompt:
        return prompt
    if emotion and emotion not in EMOTION_PROMPTS:
        print(f"[注意] 感情 '{emotion}' は未対応なので普通の表情にします（対応: {', '.join(EMOTION_PROMPTS)}）")
    return EMOTION_PROMPTS.get(emotion or "普通", EMOTION_PROMPTS["普通"])


def output_path(out: str | None) -> Path:
    if out:
        return Path(out)
    OUTPUT_DIR.mkdir(exist_ok=True)
    return OUTPUT_DIR / f"avatar_{datetime.now():%Y%m%d_%H%M%S}.mp4"


def play_file(path: Path, enabled: bool) -> None:
    from voice_clone import play_file as _play

    _play(path, enabled)


def render(image: Path, audio: Path, prompt: str, quality: str, out: Path) -> Path:
    """顔写真と音声を fal.ai に送り、しゃべる動画を保存する。"""
    endpoint, price = MODELS[quality]
    print("顔写真と音声をアップロード中...")
    image_url = fal_client.upload_file(str(image))
    audio_url = fal_client.upload_file(str(audio))

    print(f"動画を生成中...（{quality}。1 分ほどかかります）")

    def on_update(update):
        if isinstance(update, fal_client.InProgress):
            for log in update.logs or []:
                print(f"  {log['message']}")

    result = fal_client.subscribe(
        endpoint,
        arguments={"image_url": image_url, "audio_url": audio_url, "prompt": prompt},
        with_logs=True,
        on_queue_update=on_update,
    )
    video_url = result["video"]["url"]
    duration = float(result.get("duration") or 0)

    out.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", video_url, timeout=120, follow_redirects=True) as res:
        res.raise_for_status()
        with out.open("wb") as f:
            for chunk in res.iter_bytes():
                f.write(chunk)
    if duration:
        print(f"  動画の長さ: {duration:.1f}秒（料金の目安: 約${duration * price:.2f}）")
    print(f"保存しました: {out}")
    return out


# ---------- サブコマンド ----------

def cmd_register(args) -> None:
    confirm_consent(args.yes)
    src = check_file(args.image, IMAGE_EXT, "顔写真")
    avatars = load_avatars()
    if args.name in avatars:
        sys.exit(f"[エラー] '{args.name}' はすでにあります。別の名前にするか delete してください。")

    AVATARS_DIR.mkdir(exist_ok=True)
    dst = AVATARS_DIR / f"{args.name}{src.suffix.lower()}"
    shutil.copyfile(src, dst)
    avatars[args.name] = {
        "image": dst.relative_to(BASE_DIR).as_posix(),
        "source": src.name,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    save_avatars(avatars)
    print(f"登録しました: name={args.name}  image={dst.name}")
    print(f"次はこれで試せます → python avatar.py speak test.mp3 --avatar {args.name}")


def cmd_speak(args) -> None:
    image = resolve_avatar(args.avatar)
    audio = check_file(args.audio, AUDIO_EXT, "音声")
    out = render(image, audio, emotion_prompt(args.emotion, args.prompt), args.quality, output_path(args.out))
    play_file(out, not args.no_play)


def cmd_say(args) -> None:
    """voice_clone.py の声で読み上げ、その音声でアバターをしゃべらせる。"""
    from fishaudio import FishAudio
    from fishaudio.types import TTSConfig
    from fishaudio.utils import save

    from voice_clone import DEFAULT_MODEL, resolve_voice_id

    image = resolve_avatar(args.avatar)
    # 文頭の感情タグ（[嬉しい] など）は声にも表情にも使う
    m = EMOTION_TAG.match(args.text)
    emotion = args.emotion or (m.group(1) if m else None)

    print(f"音声を生成中...（model={DEFAULT_MODEL}）")
    audio = FishAudio().tts.convert(
        text=args.text,
        reference_id=resolve_voice_id(args.voice),
        config=TTSConfig(format="mp3", latency="normal"),
        model=DEFAULT_MODEL,
    )
    out = output_path(args.out)
    audio_path = out.with_suffix(".mp3")
    audio_path.parent.mkdir(parents=True, exist_ok=True)
    save(audio, str(audio_path))
    print(f"音声を保存しました: {audio_path}")

    render(image, audio_path, emotion_prompt(emotion, args.prompt), args.quality, out)
    play_file(out, not args.no_play)


def cmd_list(args) -> None:
    avatars = load_avatars()
    if not avatars:
        print("まだアバターがありません。register で登録してください。")
        return
    for name, a in avatars.items():
        print(f"- {name:15} image={a['image']}  元写真={a.get('source', '')}  登録={a.get('created_at', '')}")


def cmd_delete(args) -> None:
    avatars = load_avatars()
    a = avatars.pop(args.avatar, None)
    if not a:
        sys.exit(f"[エラー] アバター '{args.avatar}' はありません。")
    (BASE_DIR / a["image"]).unlink(missing_ok=True)
    save_avatars(avatars)
    print(f"削除しました: {args.avatar}")


# ---------- エントリポイント ----------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="fal.ai を使った自分の分身アバター")
    sub = p.add_subparsers(dest="command", required=True)

    def add_render_options(sp):
        sp.add_argument("--avatar", required=True, help="register でつけた名前")
        sp.add_argument("--emotion", help=f"表情（{' / '.join(EMOTION_PROMPTS)}）")
        sp.add_argument("--prompt", help="表情・動きの指示を直接書く（--emotion より優先）")
        sp.add_argument("--quality", default="standard", choices=list(MODELS), help="既定: standard（pro は約 2 倍の料金）")
        sp.add_argument("-o", "--out", help="保存先 mp4（省略時は output/ に日時名で保存）")
        sp.add_argument("--no-play", action="store_true", help="生成後に自動再生しない")

    sp = sub.add_parser("register", help="顔写真をアバターとして登録する")
    sp.add_argument("image", help="正面の顔写真（jpg/png/webp）")
    sp.add_argument("--name", required=True, help="このアバターにつける名前")
    sp.add_argument("-y", "--yes", action="store_true", help="同意確認をスキップ")
    sp.set_defaults(func=cmd_register)

    sp = sub.add_parser("speak", help="音声に合わせてしゃべる動画を作る")
    sp.add_argument("audio", help="しゃべらせる音声（wav/mp3/m4a など）")
    add_render_options(sp)
    sp.set_defaults(func=cmd_speak)

    sp = sub.add_parser("say", help="クローンした声で読み上げ、そのまま動画にする")
    sp.add_argument("text", help="しゃべらせる文章。文頭の [嬉しい] などは表情にも使う")
    sp.add_argument("--voice", required=True, help="voice_clone.py の clone でつけた名前、または voice_id")
    add_render_options(sp)
    sp.set_defaults(func=cmd_say)

    sp = sub.add_parser("list", help="登録済みのアバターを一覧表示")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("delete", help="アバターを削除")
    sp.add_argument("avatar", help="名前")
    sp.set_defaults(func=cmd_delete)
    return p


def main() -> None:
    load_dotenv(BASE_DIR / ".env")
    args = build_parser().parse_args()
    if args.command in ("speak", "say") and not os.environ.get("FAL_KEY"):
        sys.exit("[エラー] .env に FAL_KEY がありません。https://fal.ai/dashboard/keys で発行して貼り付けてください。")
    try:
        args.func(args)
    except fal_client.FalClientError as e:
        sys.exit(f"[fal.ai エラー] {e}（.env の FAL_KEY と残高を確認してください）")
    except httpx.HTTPStatusError as e:
        if e.response.status_code in (401, 403):
            sys.exit("[エラー] fal.ai の API キーが無効です。.env の FAL_KEY を確認してください。")
        sys.exit(f"[通信エラー {e.response.status_code}] {e}")
    except httpx.HTTPError as e:
        sys.exit(f"[通信エラー] fal.ai に接続できません: {e}")


if __name__ == "__main__":
    main()
