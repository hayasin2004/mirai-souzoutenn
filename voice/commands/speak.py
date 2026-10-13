"""喋り方を整えてから読み上げるコマンド。

  python voice_clone.py style "LLMの返答"              … 整えた結果を表示するだけ（無料・API不要）
  python voice_clone.py speak "LLMの返答" --voice tako  … 整えてから読み上げる
  python voice_clone.py accent 橋が 箸が               … 高低の自動推定を表示（辞書づくり用）
"""

import sys
from pathlib import Path

from fishaudio.utils import save

from .. import audio_io, fish, registry
from ..speech_style import StyleOptions, style_for_speech
from ..speech_style.accent import AccentError, estimate
from .voices import add_tts_options


def _read_text(args) -> str:
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    if args.text:
        return args.text
    sys.exit("[エラー] 文章を指定するか、--file でテキストファイルを指定してください。")


def _options(args) -> StyleOptions:
    return StyleOptions(
        emotion_tags=not args.no_emotion,
        auto_emotion=args.auto_emotion,
        add_pauses=not args.no_pauses,
        accent_dict_path=args.dict,
    )


def _style(args) -> list[str]:
    opt = _options(args)
    try:
        sentences = style_for_speech(_read_text(args), opt)
    except AccentError as e:
        sys.exit(f"[エラー] {e}")
    for line in opt.log:
        print(f"[注意] {line}")
    return sentences


def cmd_style(args) -> None:
    for i, s in enumerate(_style(args), 1):
        print(f"{i:2}: {s}")


def cmd_speak(args) -> None:
    sentences = _style(args)
    if not sentences:
        sys.exit("[エラー] 読み上げる文章が空になりました。")
    text = " ".join(sentences)
    print("読み上げる文章:")
    for s in sentences:
        print(f"  {s}")
    client = fish.get_client()
    print(f"音声を生成中...（model={args.model}）")
    audio = fish.synthesize(
        client,
        text,
        registry.resolve_id(args.voice),
        model=args.model,
        fmt=args.format,
        speed=args.speed,
        temperature=args.temperature,
    )
    path = audio_io.new_output_path(args.out, args.format, prefix="speak")
    save(audio, str(path))
    print(f"保存しました: {path}")
    audio_io.play_file(path, not args.no_play)


def cmd_accent(args) -> None:
    try:
        for word in args.words:
            print(f"{word}\t{estimate(word)}")
    except AccentError as e:
        sys.exit(f"[エラー] {e}")
    print("（1=高い、0=低い。違っていたら accent_dict.json に手で書いてください）")


def _add_style_options(sp) -> None:
    sp.add_argument("text", nargs="?", help="喋らせる文章（LLM の返答）")
    sp.add_argument("--file", help="文章をテキストファイルから読む")
    sp.add_argument("--no-emotion", action="store_true", help="感情タグを全部消す")
    sp.add_argument("--auto-emotion", action="store_true", help="タグのない文に、文末の ！ などから自動でタグを付ける")
    sp.add_argument("--no-pauses", action="store_true", help="長い文に読点を足さない")
    sp.add_argument("--dict", help="アクセント辞書のパス（既定: accent_dict.json）")


def register(sub) -> None:
    sp = sub.add_parser("style", help="喋らせる文章を整えた結果を表示する（無料）")
    _add_style_options(sp)
    sp.set_defaults(func=cmd_style)

    sp = sub.add_parser("speak", help="文章を喋りやすく整えてから、作成した声で読み上げる")
    _add_style_options(sp)
    sp.add_argument("--voice", required=True, help="clone でつけた名前、または voice_id")
    add_tts_options(sp)
    sp.set_defaults(func=cmd_speak)

    sp = sub.add_parser("accent", help="単語のアクセント（高低）を自動推定して表示する")
    sp.add_argument("words", nargs="+", help="調べたい単語（例: 橋が 箸が）")
    sp.set_defaults(func=cmd_accent)
