"""avatar コマンドのテスト。Anam には接続せず、avatar.run を偽物に置き換える。"""

import io
import wave

import numpy as np
import pytest

from conftest import tone
from voice import avatar
from voice.cli import build_parser, main


def wav_bytes(audio: np.ndarray, sr: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((audio * 32767).astype("<i2").tobytes())
    return buf.getvalue()


@pytest.fixture
def fake_run(monkeypatch):
    """avatar.run の代わりに、喋らせる予定の音声を集めるだけの偽物。"""
    sent: list[bytes] = []

    def _run(next_pcm, avatar_id=None, **_):
        while (pcm := next_pcm()) is not None:
            sent.append(pcm)

    monkeypatch.setattr(avatar, "run", _run)
    return sent


def test_avatar_command_registered():
    names = set(build_parser()._subparsers._group_actions[0].choices)
    assert "avatar" in names


def test_to_pcm16_resamples_to_24k_mono():
    pcm = avatar.to_pcm16(wav_bytes(tone(1.0, sr=44100), 44100))
    assert abs(avatar.pcm_seconds(pcm) - 1.0) < 0.02
    samples = np.frombuffer(pcm, dtype="<i2")
    assert 0.25 < np.abs(samples).max() / 32768 < 0.35


def test_to_pcm16_rejects_broken_data():
    with pytest.raises(avatar.AvatarError):
        avatar.to_pcm16(b"not audio")


def test_get_settings_requires_api_key(monkeypatch):
    monkeypatch.setattr(avatar.config, "load_env", lambda: None)
    monkeypatch.delenv("ANAM_API_KEY", raising=False)
    with pytest.raises(avatar.AvatarError):
        avatar.get_settings()


def test_get_settings_falls_back_to_sample_avatar(monkeypatch):
    monkeypatch.setattr(avatar.config, "load_env", lambda: None)
    monkeypatch.setenv("ANAM_API_KEY", "key")
    monkeypatch.delenv("ANAM_AVATAR_ID", raising=False)
    assert avatar.get_settings() == ("key", avatar.DEFAULT_AVATAR_ID)
    assert avatar.get_settings("mine") == ("key", "mine")


def test_avatar_with_local_audio(fake_run, wav_file):
    path = wav_file(tone(2.0), name="hello.wav")
    main(["avatar", "--audio", str(path)])
    assert len(fake_run) == 1
    assert abs(avatar.pcm_seconds(fake_run[0]) - 2.0) < 0.05


def test_avatar_with_fish_voice(tmp_project, fake_client, fake_run):
    fake_client.tts.convert.return_value = wav_bytes(tone(1.5), 16000)
    main(["avatar", "[嬉しい]こんにちは！", "--voice", "vid999"])
    kwargs = fake_client.tts.convert.call_args.kwargs
    assert kwargs["reference_id"] == "vid999"
    assert "[happy]" in kwargs["text"]  # 喋り方の調整を通っている
    assert len(fake_run) == 1
    assert abs(avatar.pcm_seconds(fake_run[0]) - 1.5) < 0.05


def test_avatar_interactive(tmp_project, fake_client, fake_run, monkeypatch):
    fake_client.tts.convert.return_value = wav_bytes(tone(1.0), 16000)
    answers = iter(["一つ目です。", "二つ目です。", ""])
    monkeypatch.setattr("builtins.input", lambda *_: next(answers))
    main(["avatar", "--voice", "vid1", "-i"])
    assert len(fake_run) == 2


def test_avatar_requires_voice_or_audio(fake_run):
    with pytest.raises(SystemExit):
        main(["avatar", "こんにちは"])


# ---- 写真からアバター（顔）を作る ----


class FakeResponse:
    def __init__(self, status: int, payload: dict | None = None, text: str = ""):
        self.status_code = status
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def faces(tmp_path, monkeypatch):
    """avatars.json を一時フォルダに向け、Anam の API キーを偽物にする。"""
    monkeypatch.setattr(avatar, "AVATARS_FILE", tmp_path / "avatars.json")
    monkeypatch.setattr(avatar.config, "load_env", lambda: None)
    monkeypatch.setenv("ANAM_API_KEY", "key")
    return tmp_path


@pytest.fixture
def fake_post(monkeypatch):
    """httpx.post の偽物。呼ばれた内容を記録し、response を返す。"""
    import httpx

    calls = []
    state = {"response": FakeResponse(201, {"id": "face-123"})}

    def _post(url, **kw):
        calls.append((url, kw))
        return state["response"]

    monkeypatch.setattr(httpx, "post", _post)
    return types_ns(calls=calls, state=state)


def types_ns(**kw):
    import types

    return types.SimpleNamespace(**kw)


def jpg_file(path):
    path.write_bytes(b"\xff\xd8\xff" + b"0" * 100)  # 中身は送るだけなので本物でなくてよい
    return path


def test_create_avatar_sends_image(faces, fake_post):
    img = jpg_file(faces / "me.jpg")
    info = avatar.create_avatar(img, "tako-face")
    url, kw = fake_post.calls[0]
    assert url.endswith("/v1/avatars")
    assert kw["headers"]["Authorization"] == "Bearer key"
    assert kw["data"]["displayName"] == "tako-face"
    assert kw["files"]["imageFile"][2] == "image/jpeg"
    assert info["id"] == "face-123"


def test_create_avatar_explains_moderation_error(faces, fake_post):
    fake_post.state["response"] = FakeResponse(422, text='{"code":"moderation_blocked"}')
    with pytest.raises(avatar.AvatarError, match="18歳以上"):
        avatar.create_avatar(jpg_file(faces / "me.jpg"), "tako-face")


def test_create_avatar_rejects_short_name(faces, fake_post):
    with pytest.raises(avatar.AvatarError):
        avatar.create_avatar(jpg_file(faces / "me.jpg"), "ab")
    assert not fake_post.calls


def test_large_or_unsupported_image_is_converted(faces):
    cv2 = pytest.importorskip("cv2")
    big = (np.random.default_rng(0).integers(0, 255, (3000, 4000, 3))).astype(np.uint8)
    path = faces / "big.bmp"
    cv2.imwrite(str(path), big)
    name, data, mime = avatar._image_for_upload(path)
    assert name == "big.jpg" and mime == "image/jpeg"
    assert len(data) <= avatar.MAX_IMAGE_BYTES
    h, w = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR).shape[:2]
    assert max(h, w) == avatar.RESIZE_LONG_SIDE


def test_avatar_create_command_saves_name(faces, fake_post):
    main(["avatar-create", str(jpg_file(faces / "me.jpg")), "--name", "tako", "-y"])
    assert avatar.list_avatars()["tako"]["id"] == "face-123"
    # 名前で指定すると ID に変換される
    assert avatar.resolve_avatar_id("tako") == "face-123"
    assert avatar.resolve_avatar_id("raw-id") == "raw-id"


def test_avatar_with_image_creates_face_then_speaks(faces, fake_post, fake_run, wav_file, monkeypatch):
    used = {}
    real_run = avatar.run

    def _run(next_pcm, avatar_id=None, **kw):
        used["face"] = avatar_id
        return real_run(next_pcm, avatar_id, **kw)

    monkeypatch.setattr(avatar, "run", _run)
    audio = wav_file(tone(1.0), name="hello.wav")
    main(["avatar", "--audio", str(audio), "--image", str(jpg_file(faces / "me.jpg")), "-y"])
    assert used["face"] == "face-123"
    assert len(fake_run) == 1


def test_avatar_checks_args_before_using_photo_check(faces, fake_post):
    # 文章も -i もないときは、写真を送る前に止まる（1日の回数を無駄にしない）
    with pytest.raises(SystemExit):
        main(["avatar", "--voice", "tako", "--image", str(jpg_file(faces / "me.jpg")), "-y"])
    assert not fake_post.calls
