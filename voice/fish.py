"""Fish Audio API の呼び出しをまとめたもの。

他のモジュールからは、この中の関数だけを使う。
API を別のサービスに差し替えるときは、このファイルだけ直せばよい。
"""

from dataclasses import dataclass

from fishaudio import FishAudio
from fishaudio.core import RequestOptions
from fishaudio.types import ReferenceAudio, TTSConfig

from . import config


@dataclass
class Transcript:
    text: str
    duration: float  # 秒（分からなければ 0）


def get_client() -> FishAudio:
    """環境変数 FISH_API_KEY を使ってクライアントを作る。"""
    config.load_env()
    return FishAudio()


def transcribe(client: FishAudio, audio: bytes, language: str = "ja") -> Transcript:
    """音声を文字起こしする（有料）。"""
    result = client.asr.transcribe(
        audio=audio,
        language=language,
        request_options=RequestOptions(additional_headers={"model": config.ASR_MODEL}),
    )
    duration = result.segments[-1].end if result.segments else 0.0
    return Transcript(text=result.text, duration=duration)


def create_voice(
    client: FishAudio,
    name: str,
    audio: bytes,
    text: str | None = None,
    enhance: bool = True,
):
    """参考音声から声のモデルを作る。戻り値の .id が voice_id。"""
    return client.voices.create(
        title=name,
        voices=[audio],
        texts=[text] if text else None,
        visibility="private",  # 自分だけが使える
        enhance_audio_quality=enhance,  # ノイズ除去・音量調整
    )


def _tts_config(fmt: str, temperature: float) -> TTSConfig:
    return TTSConfig(format=fmt, latency="normal", temperature=temperature)


def synthesize(
    client: FishAudio,
    text: str,
    voice_id: str,
    *,
    model: str = config.DEFAULT_MODEL,
    fmt: str = "mp3",
    speed: float | None = None,
    temperature: float = config.DEFAULT_TEMPERATURE,
) -> bytes:
    """作成済みの声で読み上げる。"""
    return client.tts.convert(
        text=text,
        reference_id=voice_id,
        speed=speed,
        config=_tts_config(fmt, temperature),
        model=model,
    )


def synthesize_instant(
    client: FishAudio,
    text: str,
    ref_audio: bytes,
    ref_text: str,
    *,
    model: str = config.DEFAULT_MODEL,
    fmt: str = "mp3",
    speed: float | None = None,
    temperature: float = config.DEFAULT_TEMPERATURE,
) -> bytes:
    """声のモデルを作らずに、参考音声をその場で使って読み上げる。"""
    return client.tts.convert(
        text=text,
        references=[ReferenceAudio(audio=ref_audio, text=ref_text)],
        speed=speed,
        config=_tts_config(fmt, temperature),
        model=model,
    )


def get_state(client: FishAudio, voice_id: str) -> str:
    return client.voices.get(voice_id).state


def delete_voice(client: FishAudio, voice_id: str) -> None:
    client.voices.delete(voice_id)
