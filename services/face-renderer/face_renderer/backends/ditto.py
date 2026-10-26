"""Ditto（音声 → 顔の動き）＋ LivePortrait（写真を動かす）の実装。PC-A で作る。

ここは PC-A の環境（NVIDIA GPU・CUDA・TensorRT・学習済みモデル）が無いと書けないので、
まだ中身は無い。README の「Ditto をつなぐ」に沿って実装する。

実装の要点:
- prepare: 元画像から LivePortrait の特徴量（見た目・顔のキーポイント）を作り、asset_id ごとにキャッシュする。
  展示PC が送る元画像は「肩から上・背景は黒」。LivePortrait が顔の周りを動かして貼り戻すので、
  肩から下はそのまま止まる。
- generate: WAV を Ditto の音声特徴（16kHz）に通し、動きを作りながら、できたフレームから順に
  JPEG にして yield する。全部できるのを待たない（最初の映像までの時間が延びるため）。
- 1 フレームの JPEG 品質は 85 前後から始め、LAN の帯域と画質を見て決める。
- GPU は 1 枚を 1 つのリクエストで使う想定。同時に来たら待たせる（main.py のロック）。
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from .base import Frame, PreparedSource


class DittoBackend:
    name = "ditto"

    def __init__(self) -> None:
        raise NotImplementedError(
            "Ditto はまだつながっていません。PC-A で README の「Ditto をつなぐ」を実施してください。"
            "それまでは FACE_RENDERER_BACKEND=static で動かせます。"
        )

    def prepare(self, source_png: bytes, landmarks: dict[str, Any] | None, asset_id: str | None) -> PreparedSource:
        raise NotImplementedError

    def generate(self, source_id: str, wav: bytes, fps: int) -> Iterator[Frame]:
        raise NotImplementedError
