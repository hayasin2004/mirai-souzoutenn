"""クローンAI 音声モジュール。

構成:
  config.py    … 設定値（モデル名・パス）と .env の読み込み
  registry.py  … 作成した声の一覧（voices.json）の管理
  audio_io.py  … 音声ファイルの読み込み・保存・再生
  fish.py      … Fish Audio API の呼び出し（クローン作成・読み上げ・文字起こし）
  cli.py       … コマンドライン（voice/commands/ 内のコマンドを自動で読み込む）
"""
