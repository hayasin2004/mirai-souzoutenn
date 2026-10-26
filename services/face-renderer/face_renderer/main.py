"""顔を動かすサービス（PC-A）。形式は PROTOCOL.md。

起動:  uvicorn face_renderer.main:app --host 0.0.0.0 --port 8000
環境変数:
    FACE_RENDERER_BACKEND        static（既定）/ ditto
    FACE_RENDERER_ALLOW_ORIGINS  展示PC の Web アプリのオリジン（カンマ区切り）。例 http://192.168.0.20:3000
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Iterator

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from . import __version__
from .audio import WavError, read_wav_info
from .backends import create_backend
from .protocol import FRAME_STREAM_MIME, end_message, error_message, frame_message

log = logging.getLogger("face_renderer")

MAX_WAV_BYTES = 50 * 1024 * 1024
MAX_SOURCE_BYTES = 30 * 1024 * 1024

backend = create_backend(os.environ.get("FACE_RENDERER_BACKEND", "static"))
# GPU は 1 つのリクエストずつ使う
gpu_lock = threading.Lock()

app = FastAPI(title="jibun-ai face renderer", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.environ.get("FACE_RENDERER_ALLOW_ORIGINS", "http://localhost:3000,http://localhost:3100").split(",")
        if o.strip()
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "backend": backend.name, "version": __version__}


@app.post("/prepare")
async def prepare(
    source: UploadFile = File(...),
    landmarks: str | None = Form(None),
    assetId: str | None = Form(None),  # noqa: N803 （展示PC 側の名前に合わせる）
) -> dict[str, object]:
    data = await source.read()
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise HTTPException(400, "source の大きさが不正です")
    lm = None
    if landmarks:
        try:
            lm = json.loads(landmarks)
        except json.JSONDecodeError as e:
            raise HTTPException(400, "landmarks の JSON が壊れています") from e
    try:
        prepared = backend.prepare(data, lm, assetId)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"sourceId": prepared.source_id, "width": prepared.width, "height": prepared.height}


@app.post("/speak")
async def speak(request: Request, sourceId: str = Query(...), fps: int = Query(25, ge=1, le=60)) -> StreamingResponse:  # noqa: N803
    wav = await request.body()
    if not wav or len(wav) > MAX_WAV_BYTES:
        raise HTTPException(400, "音声の大きさが不正です")
    try:
        info = read_wav_info(wav)
    except WavError as e:
        raise HTTPException(400, str(e)) from e

    try:
        frames = backend.generate(sourceId, wav, fps)
        first = next(frames, None)  # 知らない sourceId などはここでエラーにして 4xx を返す
    except KeyError as e:
        raise HTTPException(404, "先に prepare してください") from e

    def stream() -> Iterator[bytes]:
        t0 = time.perf_counter()
        count = 0
        with gpu_lock:
            try:
                for frame in [first] if first else []:
                    yield frame_message(
                        index=count, timestamp_us=frame.timestamp_us, duration_us=frame.duration_us,
                        mime=frame.mime, width=frame.width, height=frame.height, body=frame.body,
                    )
                    count += 1
                for frame in frames:
                    yield frame_message(
                        index=count, timestamp_us=frame.timestamp_us, duration_us=frame.duration_us,
                        mime=frame.mime, width=frame.width, height=frame.height, body=frame.body,
                    )
                    count += 1
                yield end_message(count)
            except Exception as e:  # 途中の失敗はストリームの中で知らせる（ステータスはもう送っている）
                log.exception("generate に失敗しました")
                yield error_message(str(e))
        log.info("speak: %.2fs の音声 → %d フレーム, %.2fs", info.duration_sec, count, time.perf_counter() - t0)

    return StreamingResponse(stream(), media_type=FRAME_STREAM_MIME, headers={"Cache-Control": "no-store"})
