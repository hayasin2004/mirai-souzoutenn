"""LLM の返答を、音声合成に渡す前に「喋りやすい形」に整える。

  normalize.py … 記号・マークダウン・絵文字を消し、長い文に読点を足し、文ごとに区切る
  emotion.py   … 感情タグ（[happy] など）の確認と、日本語タグの英語への置き換え
  accent.py    … アクセント辞書（読み間違いやすい単語の高低を指定する）
  pipeline.py  … 上の3つを順番にかける

使い方:
    from voice.speech_style import style_for_speech
    sentences = style_for_speech("LLM の返答")   # 文ごとのリスト
    text = " ".join(sentences)                     # まとめて音声合成に渡すとき
"""

from .pipeline import StyleOptions, style_for_speech

__all__ = ["StyleOptions", "style_for_speech"]
