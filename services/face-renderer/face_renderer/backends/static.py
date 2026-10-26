"""静止画を流すだけの実装。通信や同期の確認、PC-A に GPU が無いときの代わりに使う。"""

from __future__ import annotations

import math
import struct
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from typing import Any

from ..audio import read_wav_info
from .base import Frame, PreparedSource


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError("PNG ではありません")
    return struct.unpack(">II", data[16:24])


class StaticBackend:
    name = "static"

    def __init__(self, max_sources: int = 8) -> None:
        self._sources: OrderedDict[str, tuple[bytes, int, int]] = OrderedDict()
        self._max = max_sources

    def prepare(self, source_png: bytes, landmarks: dict[str, Any] | None, asset_id: str | None) -> PreparedSource:
        w, h = png_size(source_png)
        source_id = uuid.uuid4().hex
        self._sources[source_id] = (source_png, w, h)
        while len(self._sources) > self._max:
            self._sources.popitem(last=False)
        return PreparedSource(source_id, w, h)

    def generate(self, source_id: str, wav: bytes, fps: int) -> Iterator[Frame]:
        if source_id not in self._sources:
            raise KeyError(source_id)
        png, w, h = self._sources[source_id]
        info = read_wav_info(wav)
        frame_us = 1_000_000 / fps
        total = max(1, math.ceil(info.duration_sec * fps))
        for i in range(total):
            yield Frame(png, "image/png", w, h, round(i * frame_us), round(frame_us))
