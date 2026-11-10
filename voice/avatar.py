"""Anam のアバター（顔）に、Fish Audio で作った声を喋らせる。

Anam の「オーディオパススルー」モードを使う。
  Fish Audio … 声を作る（クローンした声で読み上げた音声）
  Anam       … 渡された音声に合わせて口を動かした映像を返す（顔だけ担当）

Anam 内蔵の AI や音声は使わないので、Anam 側は「アバターを動かした時間」だけ課金される。
アバターを別のサービスに差し替えるときは、このファイルだけ直せばよい。
"""

import asyncio
import io
import os
import threading
from collections.abc import Callable

import av
import numpy as np

from . import config

# Anam に送る音声の形式（16bit・モノラル）。16000〜48000Hz を受け付け、24000Hz が推奨
SAMPLE_RATE = 24000
BYTES_PER_SECOND = SAMPLE_RATE * 2

# 1回に送る量（0.5秒ぶん）
CHUNK_BYTES = BYTES_PER_SECOND // 2

# ANAM_AVATAR_ID を設定していないときに使う、Anam 公式のサンプルアバター（Liv）
DEFAULT_AVATAR_ID = "071b0286-4cce-4808-bee2-e642f1062de3"

# 接続してから喋れる状態になるまで待つ最大秒数
READY_TIMEOUT = 30.0

# 作ったアバターの一覧（名前 → avatar_id）。voices.json と同じ形
AVATARS_FILE = config.BASE_DIR / "avatars.json"

API_BASE = "https://api.anam.ai/v1"

# 写真から作るときの制限（Anam の仕様: JPEG / PNG / WebP、4.5MB まで）
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_BYTES = 4_500_000
# 大きすぎる写真を縮めるときの長い辺のピクセル数
RESIZE_LONG_SIDE = 2048


class AvatarError(Exception):
    """アバターの設定・接続まわりのエラー。"""


def get_api_key() -> str:
    config.load_env()
    api_key = os.environ.get("ANAM_API_KEY", "").strip().strip('"')
    if not api_key:
        raise AvatarError(
            ".env に ANAM_API_KEY がありません。https://lab.anam.ai で API キーを発行して追記してください。"
        )
    return api_key


def resolve_avatar_id(name_or_id: str | None) -> str:
    """avatar-create でつけた名前なら ID に変換する。省略時は .env の ANAM_AVATAR_ID。"""
    from . import registry

    if name_or_id:
        return registry.resolve_id(name_or_id, AVATARS_FILE)
    avatar = os.environ.get("ANAM_AVATAR_ID", "").strip().strip('"')
    if not avatar:
        print("[注意] アバターが未指定なので、サンプルのアバターを使います。")
        return DEFAULT_AVATAR_ID
    return avatar


def get_settings(avatar_id: str | None = None) -> tuple[str, str]:
    """API キーと、使うアバターの ID を返す。"""
    api_key = get_api_key()
    return api_key, resolve_avatar_id(avatar_id)


def _image_for_upload(path) -> tuple[str, bytes, str]:
    """写真を Anam に送れる形にする。形式が違う・大きすぎるときは JPEG に変換して縮める。"""
    from pathlib import Path

    p = Path(path)
    if not p.exists():
        raise AvatarError(f"写真が見つかりません: {p}")
    data = p.read_bytes()
    ext = p.suffix.lower()
    if ext in IMAGE_EXT and len(data) <= MAX_IMAGE_BYTES:
        mime = {".png": "image/png", ".webp": "image/webp"}.get(ext, "image/jpeg")
        return p.name, data, mime

    import cv2

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise AvatarError(f"写真を読めませんでした（JPEG / PNG / WebP にしてください）: {p.name}")
    h, w = img.shape[:2]
    scale = min(1.0, RESIZE_LONG_SIDE / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    for quality in (92, 85, 75):
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if ok and len(buf) <= MAX_IMAGE_BYTES:
            print(f"[注意] 写真を JPEG に変換しました（{len(data) // 1024}KB → {len(buf) // 1024}KB）")
            return p.stem + ".jpg", buf.tobytes(), "image/jpeg"
    raise AvatarError("写真が大きすぎます。4.5MB 以下にしてください。")


# Anam が返すエラーのうち、よく起きるものの説明
_ERROR_HINTS = {
    "moderation_blocked": "写真が安全チェックで弾かれました。18歳以上だと判定できない、顔が写っていない等が原因です。"
                          "加工なし・正面・明るい場所で、肩まで写った写真で試してください。",
    "image_unprocessable": "写真から顔を見つけられませんでした。顔が1人だけ、はっきり写った写真にしてください。",
    "outpaint_content_blocked": "写真の周りを描き足す処理で弾かれました。同じ写真では通らないので、別の写真にしてください。",
    "moderation_rate_limited": "写真チェックの回数上限です（無料プランは1日10回）。時間をおいて試してください。",
    "CREATION_BUSY": "Anam 側が混んでいます。数秒待ってから試してください。",
    "CREATION_IN_PROGRESS": "同じ写真で作成中です。Anam Lab のアバター一覧を確認してください。",
}


def create_avatar(image_path, display_name: str, timeout: float = 180.0) -> dict:
    """写真1枚から Anam のアバターを作る。戻り値は Anam のアバター情報（"id" が avatar_id）。"""
    import httpx

    if not 3 <= len(display_name) <= 50:
        raise AvatarError("アバターの名前は3〜50文字にしてください。")
    filename, data, mime = _image_for_upload(image_path)
    try:
        res = httpx.post(
            f"{API_BASE}/avatars",
            headers={"Authorization": f"Bearer {get_api_key()}"},
            data={"displayName": display_name},
            files={"imageFile": (filename, data, mime)},
            timeout=timeout,
        )
    except httpx.HTTPError as e:
        raise AvatarError(f"Anam に接続できませんでした: {e}") from e

    if res.status_code in (200, 201):
        return res.json()
    if res.status_code == 401:
        raise AvatarError("Anam の API キーが無効です。.env の ANAM_API_KEY を確認してください。")
    if res.status_code == 403:
        raise AvatarError("このアカウントでは API からアバターを作れません（Anam Lab の画面からは作れます）。")
    body = res.text
    hint = next((h for code, h in _ERROR_HINTS.items() if code in body), "")
    raise AvatarError(f"アバターを作れませんでした（{res.status_code}）。{hint}\n  Anam の応答: {body[:300]}")


def save_avatar(name: str, avatar_id: str, source: str) -> None:
    from . import registry

    registry.add(name, avatar_id, source, AVATARS_FILE)


def list_avatars() -> dict:
    from . import registry

    return registry.load(AVATARS_FILE)


def to_pcm16(audio: bytes, sr: int = SAMPLE_RATE) -> bytes:
    """mp3 / wav などの音声データを、Anam に送れる形（16bit・モノラル・sr Hz の生データ）にする。"""
    try:
        with av.open(io.BytesIO(audio)) as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                raise AvatarError("音声が入っていません。")
            resampler = av.AudioResampler(format="s16", layout="mono", rate=sr)
            chunks = []
            for frame in container.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):  # 残りを出し切る
                chunks.append(out.to_ndarray().reshape(-1))
    except av.error.FFmpegError as e:
        raise AvatarError(f"音声データを読めませんでした（{e}）") from e
    if not chunks:
        return b""
    return np.concatenate(chunks).astype("<i2").tobytes()


def pcm_seconds(pcm: bytes) -> float:
    return len(pcm) / BYTES_PER_SECOND


class VideoDisplay:
    """アバターの映像を OpenCV のウィンドウに表示する（メインスレッドで run を呼ぶ）。"""

    def __init__(self, title: str = "Clone AI Avatar") -> None:
        self.title = title
        self._frame = None
        self._running = True

    def update(self, frame) -> None:
        self._frame = frame.to_ndarray(format="bgr24")

    def run(self) -> None:
        import cv2

        cv2.namedWindow(self.title, cv2.WINDOW_NORMAL)
        while self._running:
            if self._frame is not None:
                cv2.imshow(self.title, self._frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):  # ウィンドウ上で q を押すと終了
                break
        self._running = False
        cv2.destroyAllWindows()

    def stop(self) -> None:
        self._running = False

    def is_running(self) -> bool:
        return self._running


class AudioPlayer:
    """Anam から返ってくる音声（映像と同期済み）をスピーカーで鳴らす。"""

    def __init__(self) -> None:
        self._stream = None

    def add_frame(self, frame) -> None:
        data = frame.to_ndarray()
        channels = len(frame.layout.channels)
        if frame.format.is_planar:  # (チャンネル, サンプル) → (サンプル, チャンネル)
            data = data.T
        data = data.reshape(-1, channels)
        if data.dtype == np.int16:
            data = data.astype(np.float32) / 32768.0
        else:
            data = data.astype(np.float32)
        if self._stream is None:  # 最初のフレームの形式に合わせて開く
            import sounddevice as sd

            self._stream = sd.OutputStream(
                samplerate=frame.sample_rate, channels=channels, dtype="float32", latency="low"
            )
            self._stream.start()
        self._stream.write(data)

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


async def _session(
    api_key: str,
    avatar_id: str,
    next_pcm: Callable[[], bytes | None],
    display: VideoDisplay,
    player: AudioPlayer,
    tail: float,
) -> None:
    from anam import AnamClient, AnamEvent, ClientOptions
    from anam.types import AgentAudioInputConfig, PersonaConfig

    client = AnamClient(
        api_key=api_key,
        # persona_id は付けない（付けると Anam 内蔵の AI が喋り出す）
        persona_config=PersonaConfig(avatar_id=avatar_id, enable_audio_passthrough=True),
        options=ClientOptions(),
    )
    ready = asyncio.Event()

    @client.on(AnamEvent.SESSION_READY)
    async def _on_ready() -> None:
        ready.set()

    @client.on(AnamEvent.CONNECTION_CLOSED)
    async def _on_closed(code: str, reason: str | None = None) -> None:
        print(f"接続が切れました: {code} {reason or ''}")
        display.stop()

    print("Anam に接続中...")
    session = await client.connect_async()
    async with session:

        async def consume_video() -> None:
            async for frame in session.video_frames():
                display.update(frame)

        async def consume_audio() -> None:
            async for frame in session.audio_frames():
                player.add_frame(frame)

        tasks = [asyncio.create_task(consume_video()), asyncio.create_task(consume_audio())]
        try:
            await asyncio.wait_for(ready.wait(), timeout=READY_TIMEOUT)
        except asyncio.TimeoutError:
            raise AvatarError("アバターの準備が時間内に終わりませんでした。") from None
        print("アバターの準備ができました。（映像ウィンドウで q を押すと終了）")

        while display.is_running():
            # 次の音声を待つ（文字入力や Fish Audio の生成は時間がかかるので別スレッドで）
            pcm = await asyncio.to_thread(next_pcm)
            if pcm is None or not display.is_running():
                break
            if not pcm:
                continue
            stream = session.create_agent_audio_input_stream(
                AgentAudioInputConfig(encoding="pcm_s16le", sample_rate=SAMPLE_RATE, channels=1)
            )
            for i in range(0, len(pcm), CHUNK_BYTES):
                await stream.send_audio_chunk(pcm[i : i + CHUNK_BYTES])
                await asyncio.sleep(0.01)
            # これを呼ばないと、続きの音声を待ったまま映像が止まる
            await stream.end_sequence()
            # 喋り終わるまで待つ
            await asyncio.sleep(pcm_seconds(pcm) + 0.5)

        await asyncio.sleep(tail)
        for t in tasks:
            t.cancel()


def run(
    next_pcm: Callable[[], bytes | None],
    avatar_id: str | None = None,
    *,
    tail: float = 1.0,
) -> None:
    """アバターに接続して、next_pcm() が返す音声を順番に喋らせる。

    next_pcm() は「次に喋らせる音声（to_pcm16 の結果）」を返す関数。None を返すと終了する。
    映像ウィンドウは OS の都合でメインスレッドに置く必要があるので、通信は別スレッドで動かす。
    """
    api_key, avatar = get_settings(avatar_id)
    display = VideoDisplay()
    player = AudioPlayer()
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            asyncio.run(_session(api_key, avatar, next_pcm, display, player, tail))
        except BaseException as e:  # noqa: BLE001 メインスレッドに伝えるため全部拾う
            errors.append(e)
        finally:
            display.stop()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        display.run()
    except KeyboardInterrupt:
        pass
    finally:
        display.stop()
        thread.join(timeout=5.0)
        player.stop()

    if errors:
        e = errors[0]
        if isinstance(e, AvatarError):
            raise e
        raise AvatarError(f"Anam との通信でエラーが起きました: {type(e).__name__}: {e}") from e
