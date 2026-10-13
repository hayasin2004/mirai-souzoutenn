"""アクセント辞書。

読み間違えやすい単語（同じ読みで高低が違う「橋・箸・端」や、固有名詞など）を登録しておくと、
音声合成に渡す前に Fish Audio のアクセント指定タグに置き換える。

辞書ファイル（accent_dict.json）の書き方:
    {
      "橋": "auto",            ← 自動で高低を推定（pyopenjtalk-plus が必要）
      "箸": "ha1shi0",         ← 手で指定（1=高い、0=低い。母音・ん・っ の後ろに付ける）
      "HAL": "ha1ru0"          ← 英語や略語の読み方も指定できる
    }

置き換え後の形:  <|phoneme_start|>ha0shi1<|phoneme_end|>
"""

import json
import re
from functools import lru_cache
from pathlib import Path

from .. import config

PHONEME_START = "<|phoneme_start|>"
PHONEME_END = "<|phoneme_end|>"
DEFAULT_DICT = config.BASE_DIR / "accent_dict.json"

# 拍（モーラ）の終わりになる音素。ここの後ろに高低の数字を付ける
_MORA_END = {"a", "i", "u", "e", "o", "A", "I", "U", "E", "O", "N", "cl"}
_PHONEME_PATTERN = re.compile(r"^(?:[bcdfghjkmnprstvwyz]*[aiueo][01]|N[01]|cl[01])+$")


class AccentError(Exception):
    pass


def _require_pyopenjtalk():
    try:
        import pyopenjtalk
    except ImportError as e:
        raise AccentError(
            "自動推定（auto）には pyopenjtalk-plus が必要です。pip install pyopenjtalk-plus を実行してください。"
        ) from e
    return pyopenjtalk


def _field(label: str, start: str, end: str) -> str:
    return label.split(start, 1)[1].split(end, 1)[0]


def mora_pitch(position: int, accent_type: int) -> int:
    """東京式アクセントで、アクセント句の何拍目が高いか（1）低いか（0）。

    accent_type: 0 = 平板（2拍目から高いまま）、n = n拍目の後で下がる
    """
    if position == 1:
        return 1 if accent_type == 1 else 0
    return 1 if accent_type == 0 or position <= accent_type else 0


@lru_cache(maxsize=512)
def estimate(text: str) -> str:
    """文字列から高低付きのローマ字音素を推定する。例: "橋が" → "ha0shi1ga0" """
    pyopenjtalk = _require_pyopenjtalk()
    out = []
    for label in pyopenjtalk.extract_fullcontext(text):
        phoneme = _field(label, "-", "+")
        if phoneme in ("sil", "pau"):
            continue
        position = int(_field(label, "/A:", "/").split("+")[1])
        accent_type = int(_field(label, "/F:", "/").split("_")[1].split("#")[0])
        if phoneme in _MORA_END:
            # 無声化した母音（大文字）は小文字に戻す。っ は cl のまま
            symbol = phoneme if phoneme in ("N", "cl") else phoneme.lower()
            out.append(f"{symbol}{mora_pitch(position, accent_type)}")
        else:
            out.append(phoneme)
    return "".join(out)


def wrap(phonemes: str) -> str:
    return f"{PHONEME_START}{phonemes}{PHONEME_END}"


def validate_phonemes(phonemes: str) -> bool:
    """手で書いた音素が形式どおりか（拍ごとに 0/1 が付いているか）。"""
    return bool(_PHONEME_PATTERN.fullmatch(phonemes))


class AccentDict:
    def __init__(self, entries: dict[str, str] | None = None):
        self.entries: dict[str, str] = {}
        for word, value in (entries or {}).items():
            self.add(word, value)

    @classmethod
    def load(cls, path: str | Path | None = None) -> "AccentDict":
        path = Path(path) if path else DEFAULT_DICT
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        data = {k: v for k, v in data.items() if not k.startswith("_")}  # "_説明" などは無視
        return cls(data)

    def add(self, word: str, value: str) -> None:
        value = value.strip()
        if value != "auto" and not validate_phonemes(value):
            raise AccentError(
                f"アクセント辞書の '{word}': '{value}' の形式が違います（例: ha0shi1）。"
                "母音・N・cl の後ろに 0 か 1 を付けてください。"
            )
        self.entries[word] = value

    def phonemes_for(self, word: str) -> str:
        value = self.entries[word]
        return estimate(word) if value == "auto" else value

    def apply(self, text: str) -> str:
        """文の中の登録単語を、アクセント指定タグに置き換える。長い単語を優先する。"""
        if not self.entries:
            return text
        words = sorted(self.entries, key=len, reverse=True)
        pattern = re.compile("|".join(re.escape(w) for w in words))
        # すでにタグの中にある部分は触らない
        parts = re.split(f"({re.escape(PHONEME_START)}.*?{re.escape(PHONEME_END)})", text)
        out = []
        for part in parts:
            if part.startswith(PHONEME_START):
                out.append(part)
            else:
                out.append(pattern.sub(lambda m: wrap(self.phonemes_for(m.group(0))), part))
        return "".join(out)
