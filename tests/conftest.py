"""テスト共通の準備。API には実際に接続せず、偽物（モック）に置き換える。"""

import sys
import types
from pathlib import Path
from unittest import mock

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from voice import audio_io, config  # noqa: E402


@pytest.fixture
def tmp_project(tmp_path, monkeypatch):
    """voices.json と output/ を一時フォルダに向ける。"""
    monkeypatch.setattr(config, "VOICES_FILE", tmp_path / "voices.json")
    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    return tmp_path


@pytest.fixture
def fake_client(monkeypatch):
    """Fish Audio クライアントの偽物。"""
    client = mock.MagicMock()
    seg = types.SimpleNamespace(start=0.0, end=28.0, text="x")
    client.asr.transcribe.return_value = types.SimpleNamespace(text="こんにちは。", segments=[seg])
    client.voices.create.return_value = types.SimpleNamespace(id="vid123", state="trained")
    client.voices.get.return_value = types.SimpleNamespace(state="trained")
    client.tts.convert.return_value = b"ID3fake-mp3"
    from voice import fish

    monkeypatch.setattr(fish, "get_client", lambda: client)
    return client


def tone(seconds: float, sr: int = 16000, freq: float = 220.0, amp: float = 0.3) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


@pytest.fixture
def wav_file(tmp_path):
    """指定した配列を wav にして、そのパスを返す関数。"""

    def _make(audio: np.ndarray, name: str = "a.wav", sr: int = 16000) -> Path:
        return audio_io.save_wav(tmp_path / name, audio, sr)

    return _make
