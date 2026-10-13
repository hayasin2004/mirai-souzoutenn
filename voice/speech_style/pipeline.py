"""喋り方の調整をまとめてかける。

  LLM の返答
    → clean（マークダウン・絵文字などを消す）
    → 伸ばし棒を直す（やったー → やったあ）
    → 文ごとに区切る
    → 長い文に読点を足す
    → 感情タグを整える（または消す / 自動で付ける）
    → アクセント辞書で置き換える
    → 漢字が長く続く部分を読み方に置き換える（中国語と間違われないように）
    → 文ごとのリスト
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import emotion, normalize, reading
from .accent import AccentDict


@dataclass
class StyleOptions:
    emotion_tags: bool = True  # False にすると感情タグを全部消す
    auto_emotion: bool = False  # タグのない文に、文末の ！ などから自動でタグを付ける
    add_pauses: bool = True  # 長い文に読点を足す
    long_vowel: str = "vowel"  # ひらがなの後ろの伸ばし棒: vowel=母音に置換 / keep=そのまま / drop=消す
    max_run: int = 25  # 読点なしで続いてよい文字数
    kanji: str = "hiragana"  # 漢字が長く続く部分: hiragana=ひらがなに / phoneme=アクセント指定タグに / off=そのまま
    kanji_min_run: int = reading.DEFAULT_MIN_RUN  # 何文字続いたら置き換えるか
    accent_dict: AccentDict | None = None
    accent_dict_path: str | Path | None = None  # None なら accent_dict.json を探す
    log: list[str] = field(default_factory=list)  # 何を直したかの記録（確認用）


def style_for_speech(text: str, options: StyleOptions | None = None) -> list[str]:
    opt = options or StyleOptions()
    accent = opt.accent_dict or AccentDict.load(opt.accent_dict_path)

    if opt.kanji != "off" and not reading.available():
        opt.log.append("pyopenjtalk-plus が入っていないので、漢字の読み置き換えをしていません"
                       "（pip install -r requirements-style.txt）")

    sentences = []
    cleaned = normalize.fix_long_vowels(normalize.clean(text), opt.long_vowel)
    for s in normalize.split_sentences(cleaned):
        if opt.add_pauses:
            s = normalize.add_pauses(s, opt.max_run)
        if opt.emotion_tags:
            s, dropped = emotion.fix_tags(s)
            if dropped:
                opt.log.append(f"使えないタグを外しました: {dropped}")
            if opt.auto_emotion:
                s = emotion.auto_tag(s)
        else:
            s = emotion.strip_tags(s)
        s = accent.apply(s)  # 辞書に登録した単語が優先（この後の置き換えでは触らない）
        s = reading.soften_kanji(s, opt.kanji, opt.kanji_min_run)
        if re.sub(r"[、。！？…\s]", "", emotion.strip_tags(s)):  # タグや記号だけの文は捨てる
            sentences.append(s)
    return sentences
