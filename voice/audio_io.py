"""音声ファイルの読み込み・保存・再生。

load_audio() は mp3 / m4a / wav などを numpy 配列にする。
PyAV（av パッケージ）に ffmpeg が同梱されているので、Windows でも ffmpeg を別に入れる必要はない。
"""

import os
import subprocess
import sys
import wave
from datetime import datetime
from pathlib import Path

import av
import numpy as np

from . import config


class AudioFileError(Exception):
    """音声ファイルが読めない・形式が違うときのエラー。"""


def read_audio_bytes(path_str: str | Path) -> bytes:
    """API に送るために音声ファイルをバイト列で読む（形式とサイズを確認する）。"""
    path = Path(path_str)
    if not path.exists():
        raise AudioFileError(f"ファイルが見つかりません: {path}")
    if path.suffix.lower() not in config.SUPPORTED_EXT:
        raise AudioFileError(
            f"対応形式は {', '.join(sorted(config.SUPPORTED_EXT))} です: {path.name}"
        )
    data = path.read_bytes()
    if len(data) > config.MAX_UPLOAD_BYTES:
        print("[注意] ファイルが大きいです。30秒〜2分程度に切り出すと安定します。")
    return data


def load_audio(path_str: str | Path, sr: int = 16000) -> np.ndarray:
    """音声ファイルをモノラル・指定サンプルレートの float32 配列（-1.0〜1.0）で読む。"""
    path = Path(path_str)
    if not path.exists():
        raise AudioFileError(f"ファイルが見つかりません: {path}")
    try:
        with av.open(str(path)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise AudioFileError(f"音声が入っていません: {path.name}")
            resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
            chunks = []
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):  # 残りを出し切る
                chunks.append(out.to_ndarray().reshape(-1))
    except av.error.FFmpegError as e:
        raise AudioFileError(f"音声ファイルを読めませんでした: {path.name}（{e}）") from e
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32)


def save_wav(path_str: str | Path, audio: np.ndarray, sr: int) -> Path:
    """float32 配列（-1.0〜1.0）を 16bit モノラル wav で保存する。"""
    path = Path(path_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


def new_output_path(out: str | None, fmt: str, prefix: str = "tts") -> Path:
    """保存先を決める。指定がなければ output/ に日時の名前で保存する。"""
    if out:
        return Path(out)
    config.OUTPUT_DIR.mkdir(exist_ok=True)
    return config.OUTPUT_DIR / f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}.{fmt}"


def play_file(path: Path, enabled: bool = True) -> None:
    """保存した音声を OS 標準のプレーヤーで再生する。"""
    if not enabled:
        return
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # Windows: 既定のアプリ（メディアプレーヤー等）で開く
        elif sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
        print("再生中...")
    except OSError as e:
        print(f"[注意] 自動再生できませんでした（{e}）。ファイルを直接開いてください。")
