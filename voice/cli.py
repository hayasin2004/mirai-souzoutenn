"""コマンドラインの入口。

voice/commands/ フォルダの中の .py ファイルを自動で読み込み、
各ファイルの register(subparsers) を呼んでコマンドを登録する。
新しいコマンドを追加するときは、commands/ にファイルを1つ足すだけでよい
（このファイルは触らなくてよいので、ブランチ同士でぶつかりにくい）。
"""

import argparse
import importlib
import pkgutil
import sys

import httpx
from fishaudio.exceptions import (
    APIError,
    AuthenticationError,
    FishAudioError,
    NotFoundError,
    RateLimitError,
)

from . import commands
from .audio_io import AudioFileError


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="クローンAI 音声ツール")
    sub = parser.add_subparsers(dest="command", required=True)
    for info in sorted(pkgutil.iter_modules(commands.__path__), key=lambda m: m.name):
        module = importlib.import_module(f"{commands.__name__}.{info.name}")
        if hasattr(module, "register"):
            module.register(sub)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except AudioFileError as e:
        sys.exit(f"[エラー] {e}")
    except AuthenticationError:
        sys.exit("[エラー] APIキーが無効です。.env の FISH_API_KEY を確認してください。")
    except RateLimitError:
        sys.exit("[エラー] 同時リクエスト上限です。少し待ってから再実行してください。")
    except NotFoundError:
        sys.exit("[エラー] 指定した声が見つかりません。list で確認してください。")
    except APIError as e:
        if e.status == 402:
            sys.exit(
                "[エラー 402] API の残高が足りません。文字起こしは有料です。\n"
                "  --text で台本を渡すか --no-transcribe を付けると無料モデルだけで動きます。"
            )
        sys.exit(f"[APIエラー {e.status}] {e.message}")
    except FishAudioError as e:
        sys.exit(f"[エラー] {e}")
    except httpx.HTTPError as e:
        sys.exit(f"[通信エラー] Fish Audio に接続できません: {e}")
