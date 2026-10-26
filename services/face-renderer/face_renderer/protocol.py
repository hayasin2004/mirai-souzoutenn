"""展示PC とのやり取りの形式（apps/web/src/features/face/renderer-protocol.ts と同じ）。

フレームの列は次のメッセージを順に並べたもの:
    [uint32 BE: ヘッダの長さ][ヘッダ: UTF-8 JSON][uint32 BE: 本体の長さ][本体]
"""

from __future__ import annotations

import json
import struct
from typing import Any

FRAME_STREAM_MIME = "application/x-face-frames"


def encode_message(header: dict[str, Any], body: bytes = b"") -> bytes:
    h = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return struct.pack(">I", len(h)) + h + struct.pack(">I", len(body)) + body


def frame_message(
    *, index: int, timestamp_us: int, duration_us: int, mime: str, width: int, height: int, body: bytes
) -> bytes:
    return encode_message(
        {
            "type": "frame",
            "index": index,
            "timestampUs": timestamp_us,
            "durationUs": duration_us,
            "mime": mime,
            "width": width,
            "height": height,
        },
        body,
    )


def end_message(frames: int) -> bytes:
    return encode_message({"type": "end", "frames": frames})


def error_message(message: str) -> bytes:
    return encode_message({"type": "error", "message": message})


def decode_messages(data: bytes) -> list[tuple[dict[str, Any], bytes]]:
    """テスト用：バイト列をメッセージに戻す（途中で切れていたらエラー）。"""
    out: list[tuple[dict[str, Any], bytes]] = []
    i = 0
    while i < len(data):
        (hl,) = struct.unpack_from(">I", data, i)
        header = json.loads(data[i + 4 : i + 4 + hl])
        (bl,) = struct.unpack_from(">I", data, i + 4 + hl)
        body = data[i + 8 + hl : i + 8 + hl + bl]
        if len(body) != bl:
            raise ValueError("途中で切れています")
        out.append((header, body))
        i += 8 + hl + bl
    return out
