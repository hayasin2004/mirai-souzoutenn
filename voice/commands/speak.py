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
from ..speech_style.normalize import LONG_VOWEL_MODES
from ..speech_style.reading import DEFAULT_MIN_RUN, KANJI_MODES
from .voices import add_tts_options


def _read_text(args) -> str:
    if args.file:
        return Path(args.file).read_text(encoding="utf-8")
    if args.text:
        return args.text
    sys.exit("[エラー] 文章を指定するか、--file でテキストファイルを指定してください。")


def _options(args, overrides: dict | None = None) -> StyleOptions:
    o = overrides or {}
    return StyleOptions(
        long_vowel=o.get("long_vowel", args.long_vowel),
        kanji=o.get("kanji", args.kanji),
        kanji_min_run=args.kanji_min_run,
        emotion_tags=not args.no_emotion,
        auto_emotion=args.auto_emotion,
        add_pauses=not args.no_pauses,
        accent_dict_path=args.dict,
    )


def _style(args, overrides: dict | None = None) -> list[str]:
    opt = _options(args, overrides)
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


def _speak_once(client, args, overrides: dict | None, path: Path) -> Path:
    sentences = _style(args, overrides)
    if not sentences:
        sys.exit("[エラー] 読み上げる文章が空になりました。")
    print("読み上げる文章:")
    for s in sentences:
        print(f"  {s}")
    print(f"音声を生成中...（model={args.model}）")
    audio = fish.synthesize(
        client,
        " ".join(sentences),
        registry.resolve_id(args.voice),
        model=args.model,
        fmt=args.format,
        speed=args.speed,
        temperature=args.temperature,
        normalize=args.normalize,
    )
    save(audio, str(path))
    print(f"保存しました: {path}")
    return path


def cmd_speak(args) -> None:
    client = fish.get_client()
    base = audio_io.new_output_path(args.out, args.format, prefix="speak")

    if args.compare_long_vowel:
        variants = [(f"vowel-{m}", {"long_vowel": m}) for m in LONG_VOWEL_MODES]
    elif args.compare_kanji:
        variants = [(f"kanji-{m}", {"kanji": m}) for m in KANJI_MODES]
    else:
        variants = [("", {})]

    # 同じ設定でも生成のたびに結果が変わるので、--tries で何回か作って確かめられる
    made = []
    for label, overrides in variants:
        for n in range(1, args.tries + 1):
            suffix = "_".join(x for x in (label, f"{n}" if args.tries > 1 else "") if x)
            path = base.with_name(f"{base.stem}_{suffix}{base.suffix}") if suffix else base
            print(f"\n--- {label or '通常'}{f'（{n}回目）' if args.tries > 1 else ''} ---")
            made.append(_speak_once(client, args, overrides, path))

    if len(made) == 1:
        audio_io.play_file(made[0], not args.no_play)
    else:
        print(f"\n{len(made)} 個のファイルを作りました。聴き比べてください（自動再生はしません）。")


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
    sp.add_argument("--long-vowel", default="vowel", choices=LONG_VOWEL_MODES,
                    help="ひらがなの後ろの伸ばし棒: vowel=母音に置換（既定）/ keep=そのまま / drop=消す")
    sp.add_argument("--kanji", default="hiragana", choices=KANJI_MODES,
                    help="漢字が長く続く部分: hiragana=ひらがなに（既定）/ phoneme=アクセント指定タグに / off=そのまま")
    sp.add_argument("--kanji-min-run", type=int, default=DEFAULT_MIN_RUN,
                    help=f"漢字が何文字続いたら置き換えるか（既定: {DEFAULT_MIN_RUN}）")
    sp.add_argument("--dict", help="アクセント辞書のパス（既定: accent_dict.json）")


def register(sub) -> None:
    sp = sub.add_parser("style", help="喋らせる文章を整えた結果を表示する（無料）")
    _add_style_options(sp)
    sp.set_defaults(func=cmd_style)

    sp = sub.add_parser("speak", help="文章を喋りやすく整えてから、作成した声で読み上げる")
    _add_style_options(sp)
    sp.add_argument("--voice", required=True, help="clone でつけた名前、または voice_id")
    compare = sp.add_mutually_exclusive_group()
    compare.add_argument("--compare-long-vowel", action="store_true",
                         help="伸ばし棒の扱いを3通り（vowel/keep/drop）作って聴き比べる")
    compare.add_argument("--compare-kanji", action="store_true",
                         help="漢字の扱いを3通り（hiragana/phoneme/off）作って聴き比べる")
    sp.add_argument("--tries", type=int, default=1,
                    help="同じ設定で何回作るか（たまにしか起きない問題を確かめる用、既定: 1）")
    add_tts_options(sp)
    sp.set_defaults(func=cmd_speak)

    sp = sub.add_parser("accent", help="単語のアクセント（高低）を自動推定して表示する")
    sp.add_argument("words", nargs="+", help="調べたい単語（例: 橋が 箸が）")
    sp.set_defaults(func=cmd_accent)
