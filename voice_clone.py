"""
クローンAI 音声ツールの入口（中身は voice/ フォルダ）

使い方:
  python voice_clone.py clone  sample.wav --name myvoice      # 声のモデルを作成して保存
  python voice_clone.py say    "こんにちは" --voice myvoice    # クローン音声で読み上げ
  python voice_clone.py instant sample.wav "こんにちは"        # モデルを作らず1回だけクローン
  python voice_clone.py list                                   # 作成済みの声一覧
  python voice_clone.py delete myvoice                         # 声を削除
  python voice_clone.py -h                                     # 全コマンドの一覧

自分の声、または本人の同意を得た声だけを使ってください。
"""

from voice.cli import main

if __name__ == "__main__":
    main()
