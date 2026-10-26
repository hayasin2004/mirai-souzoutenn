"""声のサービスが返す WAV の読み込み。"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass


@dataclass(frozen=True)
class WavInfo:
    channels: int
    sample_rate: int
    sample_width: int
    frames: int

    @property
    def duration_sec(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


class WavError(ValueError):
    pass


def read_wav_info(data: bytes) -> WavInfo:
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            return WavInfo(w.getnchannels(), w.getframerate(), w.getsampwidth(), w.getnframes())
    except (wave.Error, EOFError) as e:
        raise WavError(f"WAV を読めません: {e}") from e
