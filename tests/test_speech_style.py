import json

import pytest

from voice.cli import main
from voice.speech_style import StyleOptions, style_for_speech
from voice.speech_style import accent, emotion, normalize
from voice.speech_style.accent import AccentDict, AccentError

try:
    import pyopenjtalk  # noqa: F401

    HAS_OJT = True
except ImportError:
    HAS_OJT = False

# pyopenjtalk-plus が入っていない環境では、アクセント自動推定のテストだけ飛ばす
needs_ojt = pytest.mark.skipif(not HAS_OJT, reason="pip install -r requirements-style.txt が必要")


def style(text: str, **kw) -> list[str]:
    kw.setdefault("accent_dict", AccentDict())
    return style_for_speech(text, StyleOptions(**kw))


# ---------- normalize ----------

def test_clean_removes_markdown_emoji_url():
    out = normalize.clean("## 見出し\n**太字**だよ😊 詳しくは https://example.com を見てね!!")
    assert "#" not in out and "*" not in out and "😊" not in out and "http" not in out
    assert out.endswith("見てね！")


def test_split_keeps_combined_marks():
    assert normalize.split_sentences("マジで！？すごい。本当？") == ["マジで！？", "すごい。", "本当？"]


def test_split_drops_list_markers():
    assert normalize.split_sentences("- いち\n2. に") == ["いち", "に"]


def test_add_pauses_only_long_runs():
    short = "雨なので休みです。"
    assert normalize.add_pauses(short) == short
    long = "昨日は雨が降っていたので来る人が少ないかと思っていたけれど思ったよりたくさん来た"
    out = normalize.add_pauses(long)
    assert "ので、" in out and "けれど、" in out
    assert out.replace("、", "") == long


def test_add_pauses_does_not_break_words():
    s = "できることならからあげを食べに行きたいと思っているところなんです"
    assert "で、き" not in normalize.add_pauses(s)


# ---------- emotion ----------

def test_japanese_tag_is_translated_and_moved_to_front():
    assert emotion.fix_tags("今日は[嬉しい]晴れ！")[0] == "[happy] 今日は晴れ！"


def test_inline_emphasis_stays_in_place():
    assert emotion.fix_tags("それで[強調]ここが大事")[0] == "それで[emphasis]ここが大事"


def test_too_many_tags_are_trimmed():
    text, dropped = emotion.fix_tags("[happy][excited][warm][gentle] やった")
    assert text == "[happy][excited][warm] やった" and dropped == ["gentle"]


def test_unusable_tag_is_dropped():
    text, dropped = emotion.fix_tags("[？？？]こんにちは")
    assert text == "こんにちは" and dropped == ["？？？"]


def test_auto_tag():
    assert emotion.auto_tag("マジで！？") == "[surprised] マジで！？"
    assert emotion.auto_tag("やった！") == "[excited] やった！"
    assert emotion.auto_tag("[sad] だめだ！") == "[sad] だめだ！"
    assert emotion.auto_tag("ふつう。") == "ふつう。"


# ---------- accent ----------

@needs_ojt
@pytest.mark.parametrize(
    "word, expected",
    [
        # Fish Audio 公式ドキュメントの例と同じになること
        ("橋が", "ha0shi1ga0"),
        ("箸が", "ha1shi0ga0"),
        ("端が", "ha0shi1ga1"),
    ],
)
def test_estimate_matches_official_examples(word, expected):
    assert accent.estimate(word) == expected


@needs_ojt
def test_estimate_handles_n_and_small_tsu():
    assert "N" in accent.estimate("本当")
    assert "cl" in accent.estimate("学校")
    assert accent.validate_phonemes(accent.estimate("本当ですか"))


def test_mora_pitch_rules():
    assert [accent.mora_pitch(p, 0) for p in (1, 2, 3)] == [0, 1, 1]  # 平板
    assert [accent.mora_pitch(p, 1) for p in (1, 2, 3)] == [1, 0, 0]  # 頭高
    assert [accent.mora_pitch(p, 2) for p in (1, 2, 3)] == [0, 1, 0]  # 中高


def test_dict_apply_prefers_longer_words_and_skips_tagged():
    d = AccentDict({"HAL": "ha1ru0", "HAL名古屋": "ha1ru0na0go1ya0"})
    out = d.apply("HAL名古屋とHAL")
    assert out == "<|phoneme_start|>ha1ru0na0go1ya0<|phoneme_end|>と<|phoneme_start|>ha1ru0<|phoneme_end|>"
    assert d.apply(out) == out  # 2回かけても変わらない


def test_dict_rejects_bad_format():
    with pytest.raises(AccentError):
        AccentDict({"橋": "hashi"})


@needs_ojt
def test_dict_auto_entry():
    assert AccentDict({"箸": "auto"}).apply("箸") == "<|phoneme_start|>ha1shi0<|phoneme_end|>"


def test_dict_load_ignores_comment_keys(tmp_path):
    p = tmp_path / "d.json"
    p.write_text(json.dumps({"_説明": "x", "HAL": "ha1ru0"}, ensure_ascii=False), encoding="utf-8")
    assert AccentDict.load(p).entries == {"HAL": "ha1ru0"}


# ---------- pipeline ----------

def test_pipeline_end_to_end():
    out = style(
        "**ようこそ！**😊 [嬉しい]今日は来てくれてありがとう。昨日は雨が降っていたので来る人が少ないかと思っていたけれど思ったより多かった！",
        accent_dict=AccentDict({"今日": "kyo1o0"}),
    )
    assert out[0] == "ようこそ！"
    assert out[1].startswith("[happy] ")
    assert "<|phoneme_start|>kyo1o0<|phoneme_end|>" in out[1]
    assert "ので、" in out[2]


def test_pipeline_without_emotion():
    assert style("[happy] やった！", emotion_tags=False) == ["やった！"]


def test_pipeline_drops_tag_only_sentences():
    assert style("[happy]。こんにちは。") == ["こんにちは。"]


# ---------- commands ----------

@needs_ojt
def test_style_and_accent_commands(capsys):
    main(["style", "やった！すごい。", "--auto-emotion"])
    out = capsys.readouterr().out
    assert "[excited] やった！" in out
    main(["accent", "橋が"])
    assert "ha0shi1ga0" in capsys.readouterr().out


def test_speak_sends_styled_text(tmp_project, fake_client, tmp_path):
    out = tmp_path / "o.mp3"
    main(["speak", "[嬉しい]こんにちは！😊", "--voice", "vid", "-o", str(out), "--no-play",
          "--dict", str(tmp_path / "none.json")])
    kw = fake_client.tts.convert.call_args.kwargs
    assert kw["text"] == "[happy] こんにちは！"
    assert kw["reference_id"] == "vid"
    assert out.exists()


# ---------- 伸ばし棒 ----------

@pytest.mark.parametrize(
    "mode, expected",
    [
        ("vowel", "やったあ！すごおい。だよねえ。うん、そっかあ。ラーメン食べたいなあ。"),
        ("keep", "やったー！すごーい。だよねー。うんー、そっかー。ラーメン食べたいなー。"),
        ("drop", "やった！すごい。だよね。うん、そっか。ラーメン食べたいな。"),
    ],
)
def test_fix_long_vowels(mode, expected):
    src = "やったー！すごーい。だよね〜。うんー、そっかー。ラーメン食べたいなーーー。"
    assert normalize.fix_long_vowels(src, mode) == expected


def test_long_vowels_keep_katakana_words():
    for mode in normalize.LONG_VOWEL_MODES:
        assert normalize.fix_long_vowels("コーヒーとケーキとスーパー", mode) == "コーヒーとケーキとスーパー"


def test_long_vowel_bad_mode():
    with pytest.raises(ValueError):
        normalize.fix_long_vowels("やったー", "nope")


def test_pipeline_fixes_long_vowels_by_default():
    assert style("[嬉しい]やったー！") == ["[happy] やったあ！"]
    assert style("やったー！", long_vowel="keep") == ["やったー！"]


def test_speak_compare_long_vowel_makes_three_files(tmp_project, fake_client, tmp_path):
    out = tmp_path / "c.mp3"
    main(["speak", "やったー！", "--voice", "vid", "-o", str(out), "--compare-long-vowel",
          "--dict", str(tmp_path / "none.json")])
    texts = [c.kwargs["text"] for c in fake_client.tts.convert.call_args_list]
    assert texts == ["やったあ！", "やったー！", "やった！"]
    for mode in ("vowel", "keep", "drop"):
        assert (tmp_path / f"c_{mode}.mp3").exists()
