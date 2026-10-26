"""顔を動かす処理の共通の形。Ditto 版も静止画版もこれに合わせる。"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class PreparedSource:
    source_id: str
    width: int
    height: int


@dataclass(frozen=True)
class Frame:
    """1 フレーム。timestamp_us は音声の先頭を 0 とした再生位置。"""

    body: bytes
    mime: str  # "image/jpeg" / "image/png" / "image/webp"
    width: int
    height: int
    timestamp_us: int
    duration_us: int


class FaceBackend(Protocol):
    name: str

    def prepare(self, source_png: bytes, landmarks: dict[str, Any] | None, asset_id: str | None) -> PreparedSource:
        """元画像（肩から上・黒背景の PNG）を受け取り、動かす準備をする。

        同じ asset_id なら、前に作った特徴量を使い回してよい。
        """
        ...

    def generate(self, source_id: str, wav: bytes, fps: int) -> Iterator[Frame]:
        """WAV に合わせて口や頭を動かしたフレームを、できた順に返す。

        展示PC は届いたフレームから順に再生するので、全部できるのを待たずに yield すること。
        """
        ...
