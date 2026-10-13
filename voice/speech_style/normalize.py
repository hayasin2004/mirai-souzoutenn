"""喋らせる文章の整形。

LLM はチャット向けにマークダウンや絵文字を出しがちで、そのまま読み上げると
「アスタリスク」や変な間が入る。ここで読み上げに不要なものを消し、文ごとに区切る。
"""

import re
import unicodedata

# 読み上げに不要なもの
_URL = re.compile(r"https?://\S+")
_MD_BOLD = re.compile(r"(\*\*|__|\*|`)")
_MD_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_MD_BULLET = re.compile(r"^\s*(?:[-*+・]|\d+[.)])\s+", re.MULTILINE)
_EMOJI = re.compile(
    "["
    "\U0001F300-\U0001FAFF"  # 絵文字全般
    "\U00002600-\U000027BF"  # 記号・装飾
    "\U0001F000-\U0001F2FF"
    "\U0000FE0F\U0000200D"
    "]+"
)
_KAOMOJI = re.compile(r"[（(][^（）()]{0,8}[´∀･ω▽≧≦；;゜°ﾟ][^（）()]{0,8}[)）]")
_SPACES = re.compile(r"[ \t　]+")

# 文の区切り（句点・感嘆符・疑問符・改行）。区切り記号は前の文に残す
_SENTENCE_END = re.compile(r"(?<=[。！？!?])(?![。！？!?])\s*|\n+")

# 読点を足してよい場所（接続助詞などの直後）。長く続く文だけに使う
#  「て」「で」は「できる」「ですが」などの途中にも出てきて誤爆するので入れていない
_SOFT_BREAK = re.compile(r"(?<=[ぁ-んァ-ヶ一-龯])(けれど|けど|ので|から|のに|ながら|たら|れば|ては|ても)(?=[^、。！？!?…ー」』）]{6,})")


def clean(text: str) -> str:
    """マークダウン・URL・絵文字・顔文字を消し、全角半角をそろえる。"""
    text = _URL.sub("", text)
    text = _MD_HEADING.sub("", text)
    text = _MD_BULLET.sub("", text)
    text = _MD_BOLD.sub("", text)
    text = _EMOJI.sub("", text)
    text = _KAOMOJI.sub("", text)
    # 英数字は半角、カタカナは全角にそろえる（NFKC だと句読点も変わるので個別に戻す）
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("!", "！").replace("?", "？")
    text = re.sub(r"\.{3,}|。{2,}", "…", text)
    text = re.sub(r"！{2,}", "！", text)
    text = re.sub(r"？{2,}", "？", text)
    text = re.sub(r"[〜~]{2,}", "〜", text)
    text = re.sub(r"[ー]{3,}", "ーー", text)
    text = _SPACES.sub(" ", text)
    return text.strip()


_LEADING_MARK = re.compile(r"^(?:[-*+・]|\d+[.)])\s+")


def split_sentences(text: str) -> list[str]:
    parts = (_LEADING_MARK.sub("", p.strip()) for p in _SENTENCE_END.split(text))
    return [p for p in parts if p]


def add_pauses(sentence: str, max_run: int = 25) -> str:
    """読点なしで長く続く部分に、接続助詞の後ろで読点を足して息継ぎを入れる。

    Fish Audio は読点で自然に間を取るので、長い文がのっぺり続くのを防げる。
    """
    pieces = re.split(r"([、。！？…])", sentence)
    out = []
    for piece in pieces:
        if len(piece) > max_run and not re.fullmatch(r"[、。！？…]", piece):
            piece = _insert_breaks(piece, max_run)
        out.append(piece)
    return "".join(out)


def _insert_breaks(run: str, max_run: int) -> str:
    result = ""
    last_break = 0
    for m in _SOFT_BREAK.finditer(run):
        end = m.end()
        if end - last_break >= max_run // 2:
            result += run[last_break:end] + "、"
            last_break = end
    return result + run[last_break:]
