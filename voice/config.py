"""設定値の置き場所。値を変えたいときはここだけ直せばよいようにしている。"""

from pathlib import Path

from dotenv import load_dotenv

# プロジェクトのルート（voice_clone.py がある場所）
BASE_DIR = Path(__file__).resolve().parent.parent

VOICES_FILE = BASE_DIR / "voices.json"
OUTPUT_DIR = BASE_DIR / "output"

# s2.1-pro-free: 無料のテスト用モデル（速度保証なし）
# 本番では "s2.1-pro" に変更（有料: $15 / 100万バイト）
DEFAULT_MODEL = "s2.1-pro-free"

# 文字起こしモデル（有料: $0.36 / 音声1時間）
ASR_MODEL = "transcribe-1-pro"

# 抑揚のばらつき。上げると感情豊かになるが不安定になる
DEFAULT_TEMPERATURE = 0.7

# Fish Audio の文章正規化（normalize）。公式の説明は「英語と中国語向け」だが、
# 実際に試すとオフにすると日本語で読まれなくなったので、既定はオン（API の既定と同じ）
DEFAULT_NORMALIZE = True

SUPPORTED_EXT = {".wav", ".mp3", ".m4a", ".opus"}
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


def load_env() -> None:
    """.env から FISH_API_KEY などを読み込む。"""
    load_dotenv(BASE_DIR / ".env")
