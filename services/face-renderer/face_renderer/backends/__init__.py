"""顔を動かす処理の実装。FACE_RENDERER_BACKEND で選ぶ。"""

from __future__ import annotations

from .base import FaceBackend


def create_backend(name: str) -> FaceBackend:
    if name == "static":
        from .static import StaticBackend

        return StaticBackend()
    if name == "ditto":
        from .ditto import DittoBackend

        return DittoBackend()
    raise ValueError(f"知らない backend です: {name}（static / ditto）")
