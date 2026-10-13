"""感情タグの確認と整形。

Fish Audio S2 系は、文の頭に [happy] のような角かっこのタグを書くと声色が変わる。
  - タグは自由な英語で書けるが、公式の例が英語なので日本語タグは英語に置き換える
  - 1文に重ねるのは 3 つまで（公式の推奨）
  - 文の途中のタグは効きにくいので、文頭に寄せる（[emphasis] などの語調タグは例外）
"""

import re

MAX_TAGS_PER_SENTENCE = 3

# LLM が日本語で付けてきたときの置き換え表
JA_TO_EN = {
    "嬉しい": "happy", "うれしい": "happy", "楽しい": "happy", "喜び": "happy",
    "悲しい": "sad", "かなしい": "sad", "寂しい": "sad",
    "怒り": "angry", "怒って": "angry", "怒る": "angry",
    "驚き": "surprised", "驚いて": "surprised", "びっくり": "surprised",
    "興奮": "excited", "わくわく": "excited", "ワクワク": "excited",
    "落ち着いて": "calm", "穏やか": "calm",
    "優しく": "gentle", "やさしく": "gentle",
    "照れ": "shy", "恥ずかしい": "shy",
    "不安": "nervous", "緊張": "nervous",
    "笑い": "laughing", "笑う": "laughing", "笑": "laughing",
    "ささやき": "whispering", "小声": "whispering",
    "強調": "emphasis",
    "考え中": "thoughtful", "考えて": "thoughtful",
    "残念": "slightly sad",
    "自信": "confident",
}

# 文の途中に置いても意味がある（語調・効果音系）タグ
INLINE_OK = {"emphasis", "laughing", "pause", "sigh", "breath"}

_TAG = re.compile(r"\[([^\[\]]{1,40})\]")
_ASCII_TAG = re.compile(r"^[a-z][a-z \-']*$")


def normalize_tag(raw: str) -> str | None:
    """タグを英語の小文字にそろえる。使えないタグは None。"""
    tag = raw.strip().lower()
    if tag in JA_TO_EN:
        return JA_TO_EN[tag]
    if raw.strip() in JA_TO_EN:
        return JA_TO_EN[raw.strip()]
    if _ASCII_TAG.fullmatch(tag):
        return tag
    return None


def fix_tags(sentence: str) -> tuple[str, list[str]]:
    """文の中のタグを整える。戻り値は（整えた文, 捨てたタグの一覧）。"""
    lead: list[str] = []
    dropped: list[str] = []

    def take_inline(m: re.Match) -> str:
        tag = normalize_tag(m.group(1))
        if tag is None:
            dropped.append(m.group(1))
            return ""
        if m.start() == 0 or tag not in INLINE_OK:
            lead.append(tag)
            return ""
        return f"[{tag}]"

    body = _TAG.sub(take_inline, sentence).strip()
    body = re.sub(r"\s{2,}", " ", body)

    unique: list[str] = []
    for t in lead:
        if t not in unique:
            unique.append(t)
    if len(unique) > MAX_TAGS_PER_SENTENCE:
        dropped += unique[MAX_TAGS_PER_SENTENCE:]
        unique = unique[:MAX_TAGS_PER_SENTENCE]

    prefix = "".join(f"[{t}]" for t in unique)
    return (f"{prefix} {body}".strip() if prefix else body), dropped


def strip_tags(sentence: str) -> str:
    """タグをすべて消す（感情タグを使わない設定のとき）。"""
    return re.sub(r"\s{2,}", " ", _TAG.sub("", sentence)).strip()


def has_lead_tag(sentence: str) -> bool:
    return sentence.startswith("[")


def auto_tag(sentence: str) -> str:
    """タグが付いていない文に、文末の記号から簡単なタグを付ける（おまけ機能）。"""
    if has_lead_tag(sentence):
        return sentence
    if sentence.endswith("！？") or sentence.endswith("？！"):
        return f"[surprised] {sentence}"
    if sentence.endswith("！"):
        return f"[excited] {sentence}"
    return sentence
