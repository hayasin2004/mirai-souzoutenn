"""漢字が長く続く部分を、読み方に置き換える。

「吉野家の豚角煮丼好評販売中」のように漢字ばかりの文は、音声合成から見ると
日本語か中国語か区別がつかず、たまに中国語で読まれてしまう。
漢字が何文字も続く部分だけ、読み方（ひらがな）か、アクセント指定タグに置き換えて
「これは日本語だ」とはっきりさせる。

  off      … 何もしない
  hiragana … ひらがなにする（豚角煮丼好評販売中 → ぶたかくにどんこうひょうはんばいちゅう）
  phoneme  … アクセント指定タグにする（<|phoneme_start|>bu0ta1ka1ku1...<|phoneme_end|>）

読み方の推定には pyopenjtalk-plus を使う。入っていなければ何もしない。
"""

import re

from .accent import PHONEME_END, PHONEME_START, AccentError, estimate, wrap

KANJI_MODES = ("hiragana", "phoneme", "off")
DEFAULT_MIN_RUN = 4  # この文字数以上、漢字が続いたら置き換える

_KANJI = "一-龯々〆ヶ"
# 置き換えない部分（感情タグ・アクセント指定タグ）
_PROTECTED = re.compile(rf"(\[[^\[\]]*\]|{re.escape(PHONEME_START)}.*?{re.escape(PHONEME_END)})")


def _kata_to_hira(text: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def reading_of(run: str) -> str | None:
    """漢字の並びの読み方（カタカナ）。推定できなければ None。"""
    try:
        import pyopenjtalk
    except ImportError:
        return None
    morphs = pyopenjtalk.run_frontend(run)
    if "".join(m["string"] for m in morphs) != run:
        return None  # 数字の変換などで元の文字と対応が取れないときは触らない
    reading = "".join(m["read"] for m in morphs)
    return reading if reading and re.fullmatch(r"[ァ-ヶー]+", reading) else None


def available() -> bool:
    try:
        import pyopenjtalk  # noqa: F401

        return True
    except ImportError:
        return False


def soften_kanji(text: str, mode: str = "hiragana", min_run: int = DEFAULT_MIN_RUN) -> str:
    if mode not in KANJI_MODES:
        raise ValueError(f"漢字の扱いは {KANJI_MODES} のどれかです: {mode}")
    if mode == "off":
        return text
    run_re = re.compile(rf"[{_KANJI}]{{{min_run},}}")

    def convert(m: re.Match) -> str:
        run = m.group(0)
        if mode == "hiragana":
            reading = reading_of(run)
            return _kata_to_hira(reading) if reading else run
        try:
            return wrap(estimate(run))
        except AccentError:
            return run

    parts = _PROTECTED.split(text)
    return "".join(p if _PROTECTED.fullmatch(p) else run_re.sub(convert, p) for p in parts)
