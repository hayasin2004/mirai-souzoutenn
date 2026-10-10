import json

import numpy as np
import pytest

from conftest import tone
from voice import audio_io, registry
from voice.cli import build_parser, main


def test_registry_roundtrip(tmp_project):
    registry.add("tako", "vid1", "test.mp3")
    assert registry.exists("tako")
    assert registry.resolve_id("tako") == "vid1"
    assert registry.resolve_id("raw-id") == "raw-id"
    registry.remove("tako")
    assert not registry.exists("tako")


def test_load_audio_resamples_to_mono(wav_file):
    path = wav_file(tone(1.0, sr=44100), sr=44100)
    audio = audio_io.load_audio(path, sr=16000)
    assert audio.dtype == np.float32
    assert abs(len(audio) - 16000) < 400
    assert 0.25 < np.abs(audio).max() < 0.35


def test_load_audio_missing_file(tmp_path):
    with pytest.raises(audio_io.AudioFileError):
        audio_io.load_audio(tmp_path / "none.wav")


def test_read_audio_bytes_rejects_unknown_ext(tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("x")
    with pytest.raises(audio_io.AudioFileError):
        audio_io.read_audio_bytes(p)


def test_all_commands_registered():
    names = set(build_parser()._subparsers._group_actions[0].choices)
    assert {"clone", "say", "instant", "list", "delete"} <= names


def test_clone_say_delete_flow(tmp_project, fake_client, wav_file):
    src = wav_file(tone(30.0), name="me.wav")
    main(["clone", str(src), "--name", "tako", "-y"])
    voices = json.loads((tmp_project / "voices.json").read_text(encoding="utf-8"))
    assert voices["tako"]["id"] == "vid123"
    # 文字起こしの結果がテキストとして渡されている
    assert fake_client.voices.create.call_args.kwargs["texts"] == ["こんにちは。"]

    out = tmp_project / "o.mp3"
    main(["say", "テスト", "--voice", "tako", "-o", str(out), "--no-play", "--temperature", "0.85"])
    kw = fake_client.tts.convert.call_args.kwargs
    assert kw["reference_id"] == "vid123"
    assert kw["model"] == "s2.1-pro-free"
    assert kw["config"].temperature == 0.85
    assert out.read_bytes() == b"ID3fake-mp3"

    main(["delete", "tako"])
    assert not registry.exists("tako")


def test_clone_with_text_skips_transcribe(tmp_project, fake_client, wav_file):
    src = wav_file(tone(30.0), name="me.wav")
    main(["clone", str(src), "--name", "t2", "-y", "--text", "台本", "--no-enhance"])
    fake_client.asr.transcribe.assert_not_called()
    kw = fake_client.voices.create.call_args.kwargs
    assert kw["texts"] == ["台本"]
    assert kw["enhance_audio_quality"] is False


def test_api_402_message(tmp_project, fake_client, wav_file, capsys):
    from fishaudio.exceptions import APIError

    fake_client.asr.transcribe.side_effect = APIError(402, "Insufficient API credit")
    src = wav_file(tone(30.0), name="me.wav")
    with pytest.raises(SystemExit) as e:
        main(["clone", str(src), "--name", "t3", "-y"])
    assert "--text" in str(e.value)
