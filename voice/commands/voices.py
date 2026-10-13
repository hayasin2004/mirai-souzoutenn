"""声の作成・読み上げ・一覧・削除のコマンド。

  clone   … 参考音声から声のモデルを作る
  say     … 作った声で読み上げる
  instant … モデルを作らずに、その場でクローンして読み上げる
  list    … 作った声の一覧
  delete  … 声を削除
"""

import sys
from pathlib import Path

from fishaudio.exceptions import NotFoundError
from fishaudio.utils import save

from .. import audio_io, config, fish, registry


def confirm_consent(skip: bool) -> None:
    if skip:
        return
    ans = input("この音声は自分の声、または本人の同意を得た声ですか？ [y/N]: ").strip().lower()
    if ans != "y":
        sys.exit("中止しました。")


def transcribe_with_log(client, audio: bytes, language: str) -> str:
    print("参考音声を文字起こし中...")
    t = fish.transcribe(client, audio, language)
    print(f"  文字起こし: {t.text}")
    if t.duration:
        print(f"  音声の長さ: 約{t.duration:.0f}秒")
        if t.duration < 10:
            print("  [注意] 10秒未満だと似にくいです。15〜30秒以上を推奨します。")
    return t.text


def cmd_clone(args) -> None:
    confirm_consent(args.yes)
    audio = audio_io.read_audio_bytes(args.audio)
    if registry.exists(args.name):
        sys.exit(f"[エラー] '{args.name}' はすでにあります。別の名前にするか delete してください。")

    client = fish.get_client()
    text = args.text
    if not text and not args.no_transcribe:
        text = transcribe_with_log(client, audio, args.lang)

    print("声のモデルを作成中...")
    voice = fish.create_voice(client, args.name, audio, text=text, enhance=not args.no_enhance)
    registry.add(args.name, voice.id, source=Path(args.audio).name)
    print(f"完了: name={args.name}  voice_id={voice.id}  state={voice.state}")
    print(f'次はこれで試せます → python voice_clone.py say "こんにちは" --voice {args.name}')


def _save_and_play(audio: bytes, args) -> None:
    path = audio_io.new_output_path(args.out, args.format)
    save(audio, str(path))
    print(f"保存しました: {path}")
    audio_io.play_file(path, not args.no_play)


def cmd_say(args) -> None:
    client = fish.get_client()
    print(f"音声を生成中...（model={args.model}）")
    audio = fish.synthesize(
        client,
        args.text,
        registry.resolve_id(args.voice),
        model=args.model,
        fmt=args.format,
        speed=args.speed,
        temperature=args.temperature,
        normalize=args.normalize,
    )
    _save_and_play(audio, args)


def cmd_instant(args) -> None:
    confirm_consent(args.yes)
    ref_audio = audio_io.read_audio_bytes(args.audio)
    client = fish.get_client()
    ref_text = args.ref_text or transcribe_with_log(client, ref_audio, args.lang)
    print(f"音声を生成中...（model={args.model}）")
    audio = fish.synthesize_instant(
        client,
        args.text,
        ref_audio,
        ref_text,
        model=args.model,
        fmt=args.format,
        speed=args.speed,
        temperature=args.temperature,
        normalize=args.normalize,
    )
    _save_and_play(audio, args)


def cmd_list(args) -> None:
    voices = registry.load()
    if not voices:
        print("まだ声がありません。clone で作成してください。")
        return
    client = fish.get_client()
    for name, v in voices.items():
        try:
            state = fish.get_state(client, v["id"])
        except NotFoundError:
            state = "（サーバー上に見つかりません）"
        print(f"- {name:15} id={v['id']}  state={state}  元音声={v.get('source', '')}")


def cmd_delete(args) -> None:
    client = fish.get_client()
    try:
        fish.delete_voice(client, registry.resolve_id(args.voice))
    except NotFoundError:
        print("サーバー上にはすでにありませんでした。")
    registry.remove(args.voice)
    print(f"削除しました: {args.voice}")


def add_tts_options(sp) -> None:
    sp.add_argument("--model", default=config.DEFAULT_MODEL, help=f"TTSモデル（既定: {config.DEFAULT_MODEL}）")
    sp.add_argument("--format", default="mp3", choices=["mp3", "wav", "opus"])
    sp.add_argument("--speed", type=float, default=None, help="話す速さ 0.5〜2.0")
    sp.add_argument(
        "--temperature",
        type=float,
        default=config.DEFAULT_TEMPERATURE,
        help=f"抑揚のばらつき（既定{config.DEFAULT_TEMPERATURE}、上げると感情豊か・不安定に）",
    )
    sp.add_argument(
        "--no-normalize",
        dest="normalize",
        action="store_false",
        help="Fish Audio の文章正規化をオフにする（オフだと日本語で読まれなくなることがある）",
    )
    sp.add_argument("-o", "--out", help="保存先（省略時は output/ に日時名で保存）")
    sp.add_argument("--no-play", action="store_true", help="生成後に自動再生しない")


def register(sub) -> None:
    sp = sub.add_parser("clone", help="参考音声から声のモデルを作る")
    sp.add_argument("audio", help="参考音声（wav/mp3/m4a/opus、30秒〜1分推奨）")
    sp.add_argument("--name", required=True, help="この声につける名前")
    sp.add_argument("--text", help="参考音声で話している内容（省略時は自動で文字起こし・有料）")
    sp.add_argument("--no-transcribe", action="store_true", help="文字起こしをしない")
    sp.add_argument("--no-enhance", action="store_true", help="ノイズ除去をしない（静かな部屋で録った音声向け）")
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
    sp.add_argument("--ref-text", help="参考音声で話している内容（省略時は自動で文字起こし・有料）")
    sp.add_argument("--lang", default="ja")
    sp.add_argument("-y", "--yes", action="store_true", help="同意確認をスキップ")
    add_tts_options(sp)
    sp.set_defaults(func=cmd_instant)

    sp = sub.add_parser("list", help="作成済みの声を一覧表示")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("delete", help="声を削除")
    sp.add_argument("voice", help="名前または voice_id")
    sp.set_defaults(func=cmd_delete)
