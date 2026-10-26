"""形式どおりに動くかの確認（静止画の実装で）。 python -m pytest"""

import io
import struct
import wave
import zlib

from fastapi.testclient import TestClient

from face_renderer.main import app
from face_renderer.protocol import decode_messages, encode_message

client = TestClient(app)


def png(w: int, h: int) -> bytes:
    def chunk(t: bytes, d: bytes) -> bytes:
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\x10" * (w * 3) for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def wav(sec: float, rate: int = 24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(sec * rate))
    return buf.getvalue()


def prepare() -> str:
    r = client.post("/prepare", files={"source": ("source.png", png(64, 64), "image/png")}, data={"assetId": "a1"})
    assert r.status_code == 200, r.text
    assert r.json()["width"] == 64
    return r.json()["sourceId"]


def test_health() -> None:
    assert client.get("/health").json()["status"] == "ok"


def test_speak_streams_frames_then_end() -> None:
    sid = prepare()
    r = client.post(f"/speak?sourceId={sid}&fps=25", content=wav(2), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/x-face-frames"
    msgs = decode_messages(r.content)
    frames = [h for h, _ in msgs if h["type"] == "frame"]
    assert len(frames) == 50
    assert [f["timestampUs"] for f in frames[:3]] == [0, 40000, 80000]
    assert msgs[-1][0] == {"type": "end", "frames": 50}


def test_errors() -> None:
    sid = prepare()
    assert client.post(f"/speak?sourceId={sid}", content=b"not wav").status_code == 400
    assert client.post("/speak?sourceId=nope", content=wav(1)).status_code == 404
    assert client.post("/prepare", files={"source": ("x.png", b"not png", "image/png")}).status_code == 400


def test_protocol_matches_web() -> None:
    # apps/web の renderer-protocol.test.ts と同じ並び
    b = encode_message({"type": "end", "frames": 2})
    assert b[:4] == struct.pack(">I", len(b'{"type":"end","frames":2}'))
    assert b.endswith(b"\x00\x00\x00\x00")
