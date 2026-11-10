"""Anam のアバターに、作成した声で喋らせるコマンド。

  python voice_clone.py avatar "こんにちは！" --voice tako     … 1回喋らせる
  python voice_clone.py avatar --voice tako -i                 … 打った文章を次々に喋らせる
  python voice_clone.py avatar --audio test.mp3                … 手元の音声ファイルを喋らせる（Fish Audio を使わない）
  python voice_clone.py avatar-create me.jpg --name tako        … 写真からアバター（顔）を作る
  python voice_clone.py avatar "こんにちは" --voice tako --face tako   … 作った顔と声で喋らせる
  python voice_clone.py avatar "こんにちは" --voice tako --image me.jpg … 写真から顔を作って、そのまま喋らせる
  python voice_clone.py avatar-list                             … 作った顔の一覧

文章は speak コマンドと同じ「喋り方の調整」を通してから読み上げる。
"""

import sys
from datetime import datetime
from pathlib import Path

from .. import audio_io, avatar, config, fish, registry
from ..speech_style import style_for_speech
from ..speech_style.accent import AccentError
from .speak import _add_style_options, _options


def _styled(text: str, args) -> str:
    opt = _options(args)
    try:
        sentences = style_for_speech(text, opt)
    except AccentError as e:
        sys.exit(f"[エラー] {e}")
    for line in opt.log:
        print(f"[注意] {line}")
    return " ".join(sentences)


def _synthesize_pcm(client, text: str, args) -> bytes:
    styled = _styled(text, args)
    if not styled:
        print("[注意] 読み上げる文章が空になりました。")
        return b""
    print(f"読み上げる文章: {styled}")
    print(f"音声を生成中...（model={args.model}）")
    mp3 = fish.synthesize(
        client,
        styled,
        registry.resolve_id(args.voice),
        model=args.model,
        fmt="mp3",
        speed=args.speed,
        temperature=args.temperature,
        normalize=args.normalize,
    )
    pcm = avatar.to_pcm16(mp3)
    print(f"アバターに送ります（{avatar.pcm_seconds(pcm):.1f}秒）")
    return pcm


def _first_text(args) -> str | None:
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    return args.text


def _confirm_face_consent(skip: bool) -> None:
    if skip:
        return
    ans = input("この写真は自分、または本人の同意を得た人の写真ですか？ [y/N]: ").strip().lower()
    if ans != "y":
        sys.exit("中止しました。")


def _create_face(image: str, name: str | None) -> str:
    """写真からアバターを作って avatars.json に保存し、avatar_id を返す。"""
    name = name or f"{Path(image).stem}_{datetime.now():%m%d_%H%M%S}"
    if avatar.list_avatars().get(name):
        sys.exit(f"[エラー] 顔の名前 '{name}' はすでにあります。別の名前にしてください。")
    print(f"写真からアバターを作成中...（{Path(image).name}、数十秒かかります）")
    info = avatar.create_avatar(image, name if len(name) >= 3 else f"{name}_face")
    avatar.save_avatar(name, info["id"], Path(image).name)
    print(f"完了: name={name}  avatar_id={info['id']}")
    return info["id"]


def cmd_avatar_create(args) -> None:
    _confirm_face_consent(args.yes)
    try:
        _create_face(args.image, args.name)
    except avatar.AvatarError as e:
        sys.exit(f"[エラー] {e}")
    print(f'次はこれで試せます → python voice_clone.py avatar --audio test.mp3 --face {args.name}')


def cmd_avatar_list(args) -> None:
    faces = avatar.list_avatars()
    if not faces:
        print("まだ顔がありません。avatar-create で作成してください。")
        return
    for name, v in faces.items():
        print(f"- {name:15} avatar_id={v['id']}  元の写真={v.get('source', '')}")


def cmd_avatar(args) -> None:
    # 写真チェックの回数（無料は1日10回）を無駄にしないよう、先に引数を確かめる
    if not args.audio:
        if not args.voice:
            sys.exit("[エラー] --voice（clone でつけた名前）か --audio を指定してください。")
        if not _first_text(args) and not args.interactive:
            sys.exit("[エラー] 喋らせる文章を指定するか、-i で対話モードにしてください。")

    face = args.face
    if args.image:  # 写真から顔を作ってから喋らせる（展示では撮った写真をここに渡す想定）
        _confirm_face_consent(args.yes)
        try:
            face = _create_face(args.image, args.face_name)
        except avatar.AvatarError as e:
            sys.exit(f"[エラー] {e}")

    # 1) 手元の音声ファイルをそのまま喋らせる（Anam だけの動作確認用）
    if args.audio:
        pcm = avatar.to_pcm16(audio_io.read_audio_bytes(args.audio))
        queue = [pcm]
        next_pcm = lambda: queue.pop(0) if queue else None  # noqa: E731
    else:
        client = fish.get_client()
        first = _first_text(args)

        # 接続前に1つ目の音声を作っておく（Fish Audio で失敗したときに Anam の時間を無駄にしない）
        pending = [_synthesize_pcm(client, first, args)] if first else []

        def next_pcm() -> bytes | None:
            if pending:
                return pending.pop(0)
            if not args.interactive:
                return None
            try:
                text = input("\n喋らせる文章（空 Enter か q で終了）> ").strip()
            except EOFError:
                return None
            if not text or text.lower() == "q":
                return None
            return _synthesize_pcm(client, text, args)

    try:
        avatar.run(next_pcm, avatar_id=face)
    except avatar.AvatarError as e:
        sys.exit(f"[エラー] {e}")
    print("終了しました。")


def register(sub) -> None:
    sp = sub.add_parser("avatar", help="Anam のアバターに、作成した声で喋らせる")
    _add_style_options(sp)
    sp.add_argument("--voice", help="clone でつけた名前、または voice_id")
    sp.add_argument("--audio", help="Fish Audio を使わず、この音声ファイルを喋らせる（動作確認用）")
    sp.add_argument("-i", "--interactive", action="store_true", help="打った文章を次々に喋らせる")
    sp.add_argument("--face", "--avatar-id", dest="face",
                    help="avatar-create でつけた名前、または Anam のアバター ID（省略時は .env の ANAM_AVATAR_ID）")
    sp.add_argument("--image", help="この写真から顔を作ってから喋らせる（JPEG / PNG / WebP）")
    sp.add_argument("--face-name", help="--image で作る顔につける名前（省略時は写真の名前＋日時）")
    sp.add_argument("-y", "--yes", action="store_true", help="同意確認をスキップ")
    sp.add_argument("--model", default=config.DEFAULT_MODEL,
                    help=f"TTSモデル（既定: {config.DEFAULT_MODEL}）")
    sp.add_argument("--speed", type=float, default=None, help="話す速さ 0.5〜2.0")
    sp.add_argument("--temperature", type=float, default=config.DEFAULT_TEMPERATURE,
                    help=f"抑揚のばらつき（既定{config.DEFAULT_TEMPERATURE}）")
    sp.add_argument("--no-normalize", dest="normalize", action="store_false",
                    help="Fish Audio の文章正規化をオフにする")
    sp.set_defaults(func=cmd_avatar)

    sp = sub.add_parser("avatar-create", help="写真1枚から Anam のアバター（顔）を作る")
    sp.add_argument("image", help="顔写真（JPEG / PNG / WebP。それ以外や 4.5MB 超は自動で変換）")
    sp.add_argument("--name", required=True, help="この顔につける名前（3文字以上）")
    sp.add_argument("-y", "--yes", action="store_true", help="同意確認をスキップ")
    sp.set_defaults(func=cmd_avatar_create)

    sp = sub.add_parser("avatar-list", help="作った顔の一覧")
    sp.set_defaults(func=cmd_avatar_list)
