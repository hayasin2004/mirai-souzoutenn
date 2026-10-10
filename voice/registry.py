"""作成した声の一覧（名前 → voice_id）を voices.json で管理する。"""

import json
from datetime import datetime
from pathlib import Path

from . import config


def load(path: Path | None = None) -> dict:
    path = path or config.VOICES_FILE
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save(voices: dict, path: Path | None = None) -> None:
    path = path or config.VOICES_FILE
    path.write_text(json.dumps(voices, ensure_ascii=False, indent=2), encoding="utf-8")


def add(name: str, voice_id: str, source: str, path: Path | None = None) -> None:
    voices = load(path)
    voices[name] = {
        "id": voice_id,
        "source": source,
        "created_at": datetime.now().isoformat(timespec="seconds"),
    }
    save(voices, path)


def remove(name: str, path: Path | None = None) -> None:
    voices = load(path)
    voices.pop(name, None)
    save(voices, path)


def exists(name: str, path: Path | None = None) -> bool:
    return name in load(path)


def resolve_id(name_or_id: str, path: Path | None = None) -> str:
    """名前が登録されていれば voice_id を返す。なければ voice_id とみなしてそのまま返す。"""
    voices = load(path)
    if name_or_id in voices:
        return voices[name_or_id]["id"]
    return name_or_id
