"""
Ditto TalkingHead Engine Wrapper for Mirai Voice Studio
keeps the StreamSDK model loaded in GPU memory and pre-warms CUDA kernels
for ultra-fast talking head video generation.
"""

import os
import sys
import threading
import time
import numpy as np
import torch
from pathlib import Path

DITTO_DIR = Path(r"C:\Users\yuuki\.gemini\antigravity\scratch\ditto-talkinghead")
if str(DITTO_DIR) not in sys.path:
    sys.path.insert(0, str(DITTO_DIR))

torch.backends.cudnn.benchmark = False
torch.backends.cuda.matmul.allow_tf32 = True
torch.backends.cudnn.allow_tf32 = True

_sdk_instance = None
_sdk_lock = threading.Lock()


def get_ditto_sdk():
    """Singleton StreamSDK loaded once into GPU memory."""
    global _sdk_instance
    if _sdk_instance is not None:
        return _sdk_instance

    data_root = str(DITTO_DIR / "checkpoints" / "ditto_pytorch")
    cfg_pkl = str(DITTO_DIR / "checkpoints" / "ditto_cfg" / "v0.4_hubert_cfg_pytorch.pkl")

    print("[DittoEngine] Loading StreamSDK into GPU memory...", flush=True)
    t0 = time.time()
    from stream_pipeline_offline import StreamSDK
    _sdk_instance = StreamSDK(cfg_pkl, data_root)
    print(f"[DittoEngine] StreamSDK ready in {time.time() - t0:.2f}s", flush=True)
    return _sdk_instance


def warmup_ditto_Async(
    default_avatar_path: str | Path | None = None,
    videos_dir: str | Path | None = None,
    on_idle_ready=None,
):
    """Background warmup so the very first user chat is instant, and pre-generates the idle blink video."""
    def _warmup():
        try:
            with _sdk_lock:
                sdk = get_ditto_sdk()
                if default_avatar_path and Path(default_avatar_path).exists():
                    src_str = str(Path(default_avatar_path).resolve())
                    print(f"[DittoEngine] Pre-caching avatar face: {Path(src_str).name}", flush=True)
                    if not hasattr(sdk, "_source_cache"):
                        sdk._source_cache = {}
                    mtime = os.path.getmtime(src_str)
                    cache_key = (src_str, mtime, 512, -1, 2.3, 0, -0.125, True)
                    if cache_key not in sdk._source_cache:
                        info = sdk.avatar_registrar(
                            src_str,
                            max_dim=512,
                            n_frames=-1,
                            crop_scale=2.3,
                            crop_vx_ratio=0,
                            crop_vy_ratio=-0.125,
                            crop_flag_do_rot=True,
                        )
                        sdk._source_cache[cache_key] = info
                # Warm up GPU kernels for WarpNetwork and Decoder
                dummy_fs = np.zeros((1, 32, 16, 64, 64), dtype=np.float32)
                dummy_kp = np.zeros((1, 21, 3), dtype=np.float32)
                f3d = sdk.warp_f3d(dummy_fs, dummy_kp, dummy_kp)
                _ = sdk.decode_f3d(f3d)
                print("[DittoEngine] GPU warmup complete!", flush=True)

            if default_avatar_path and videos_dir and Path(default_avatar_path).exists():
                idle_list = ensure_idle_videos(default_avatar_path, videos_dir)
                if on_idle_ready and idle_list:
                    on_idle_ready(idle_list[0])
        except Exception as e:
            print(f"[DittoEngine] Warmup warning: {e}", flush=True)

    threading.Thread(target=_warmup, daemon=True).start()


IDLE_PRESETS = [
    {
        "suffix": "",
        "label": "自然な待機・うなずき",
        "blink_pattern": [18, 28, 7, 34],
        "pitch": (1.45, 0.55),
        "yaw": (1.85, -0.75),
        "roll": (0.95, 0.35),
        "t_amp": (0.0008, 0.0018),
        "gaze_amp": (2.2, 1.4),
    },
    {
        "suffix": "_v2",
        "label": "少し考えて視線を動かす",
        "blink_pattern": [22, 12, 32, 8],
        "pitch": (-1.10, 0.90),
        "yaw": (-2.60, 1.15),
        "roll": (-1.45, 0.55),
        "t_amp": (-0.0011, 0.0012),
        "gaze_amp": (-3.4, 1.8),
    },
    {
        "suffix": "_v3",
        "label": "リラックスしてゆっくり深呼吸",
        "blink_pattern": [28, 20, 14, 24],
        "pitch": (2.10, -0.65),
        "yaw": (1.10, 1.40),
        "roll": (1.35, -0.65),
        "t_amp": (0.0005, 0.0026),
        "gaze_amp": (1.5, -2.0),
    },
]


def _generate_single_idle_video(
    source_path: Path,
    idle_mp4_path: Path,
    preset: dict,
    duration_sec: float = 6.0,
    force_regen: bool = False,
) -> Path | None:
    if not force_regen and idle_mp4_path.exists() and idle_mp4_path.stat().st_size > 1000:
        if idle_mp4_path.stat().st_mtime >= source_path.stat().st_mtime:
            return idle_mp4_path

    with _sdk_lock:
        sdk = get_ditto_sdk()
        import soundfile as sf
        from inference import run as ditto_run

        silent_wav_path = idle_mp4_path.parent / f"silent_{idle_mp4_path.stem}.wav"
        silent_samples = np.zeros((int(16000 * duration_sec),), dtype=np.float32)
        sf.write(str(silent_wav_path), silent_samples, 16000)

        n_frames = int(round(duration_sec * 25))
        p1, p2 = preset["pitch"]
        y1, y2 = preset["yaw"]
        r1, r2 = preset["roll"]
        tx, ty = preset["t_amp"]
        gx, gy = preset["gaze_amp"]

        ctrl_info = {}
        for i in range(n_frames + 5):
            theta = (2.0 * np.pi * i) / float(n_frames)
            d_pitch = 2.0 + p1 * float(np.sin(theta)) + p2 * float(np.sin(2.0 * theta))
            d_yaw = y1 * float(np.sin(theta)) + y2 * float(np.sin(2.0 * theta))
            d_roll = r1 * float(np.sin(theta)) + r2 * float(np.sin(2.0 * theta))
            d_t = np.array([[tx * np.sin(theta), ty * np.sin(theta), 0.0]], dtype=np.float32)
            d_gaze = (gx * float(np.sin(2.0 * theta)), gy * float(np.sin(theta)))
            ctrl_info[i] = {
                "delta_pitch": d_pitch,
                "delta_yaw": d_yaw,
                "delta_roll": d_roll,
                "delta_t": d_t,
                "delta_gaze": d_gaze,
            }

        more_kwargs = {
            "setup_kwargs": {
                "sampling_timesteps": 10,
                "max_size": 512,
                "frame_stride": 1,
                "use_d_keys": {"exp": 0.15, "pitch": 0.1, "yaw": 0.1, "roll": 0.1, "t": 0.1},
                "delta_eye_open_n": preset["blink_pattern"],
                "fade_type": "s",
                "fade_out_keys": ("exp", "pitch", "yaw", "roll", "t"),
                "overall_ctrl_info": {"vad_alpha": 0.0, "delta_pitch": 2.0},
                "ctrl_info": ctrl_info,
            },
            "run_kwargs": {
                "fade_in": 12,
                "fade_out": 12,
            },
        }
        t0 = time.time()
        print(f"[DittoEngine] Generating idle loop ({preset['label']}) for {source_path.name} -> {idle_mp4_path.name}...", flush=True)
        try:
            ditto_run(sdk, str(silent_wav_path), str(source_path), str(idle_mp4_path), more_kwargs=more_kwargs)
            print(f"[DittoEngine] Idle loop ready in {time.time() - t0:.2f}s -> {idle_mp4_path.name}", flush=True)
        finally:
            for p in [silent_wav_path, Path(str(idle_mp4_path) + ".tmp.mp4")]:
                if p.exists():
                    try:
                        p.unlink()
                    except Exception:
                        pass
        return idle_mp4_path if idle_mp4_path.exists() else None


def ensure_idle_videos(
    source_path: str | Path,
    output_dir: str | Path,
    duration_sec: float = 6.0,
    force_regen: bool = False,
) -> list[Path]:
    """
    Generate (or return cached) 3 distinct seamless looping idle video variations
    for natural, non-repetitive waiting behavior.
    """
    source_path = Path(source_path).resolve()
    if not source_path.exists():
        return []
    output_dir = Path(output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if source_path.suffix.lower() == ".mp4":
        return [source_path]

    safe_stem = "".join(c if c.isalnum() or c in "._-" else "_" for c in source_path.stem)
    results: list[Path] = []
    for preset in IDLE_PRESETS:
        idle_mp4_path = output_dir / f"idle_{safe_stem}{preset['suffix']}.mp4"
        res = _generate_single_idle_video(
            source_path=source_path,
            idle_mp4_path=idle_mp4_path,
            preset=preset,
            duration_sec=duration_sec,
            force_regen=force_regen,
        )
        if res is not None:
            results.append(res)
    return results


def ensure_idle_video(
    source_path: str | Path,
    output_dir: str | Path,
    duration_sec: float = 6.0,
    force_regen: bool = False,
) -> Path | None:
    """Backward-compatible helper returning the primary idle video path."""
    videos = ensure_idle_videos(source_path, output_dir, duration_sec=duration_sec, force_regen=force_regen)
    return videos[0] if videos else None


def generate_talking_video(
    audio_path: str | Path,
    source_path: str | Path,
    output_path: str | Path,
    sampling_timesteps: int = 10,
    frame_stride: int = 3,
    max_size: int = 512,
) -> tuple[Path, dict]:
    """
    Generate talking head MP4 from audio_path and source_path (image or video).
    Returns (output_path, timing_dict).
    Thread-safe via _sdk_lock.
    """
    audio_path = str(Path(audio_path).resolve())
    source_path = str(Path(source_path).resolve())
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with _sdk_lock:
        t_init = time.time()
        sdk = get_ditto_sdk()
        sdk_load_sec = round(time.time() - t_init, 3)

        # Measure audio duration
        audio_duration_sec = 0.0
        try:
            import soundfile as sf
            info = sf.info(audio_path)
            audio_duration_sec = round(info.duration, 2)
        except Exception:
            pass

        from inference import run as ditto_run
        more_kwargs = {
            "setup_kwargs": {
                "sampling_timesteps": sampling_timesteps,
                "max_size": max_size,
                "frame_stride": frame_stride,
                "fade_type": "s",
                "fade_out_keys": ("exp", "pitch", "yaw", "roll", "t"),
            },
            "run_kwargs": {
                "fade_in": 5,
                "fade_out": 6,
            },
        }
        t0 = time.time()
        print(
            f"[DittoEngine] Generating video: source={Path(source_path).name}, "
            f"audio={Path(audio_path).name} ({audio_duration_sec}s, steps={sampling_timesteps}, stride={frame_stride})",
            flush=True,
        )
        ditto_run(sdk, audio_path, source_path, str(output_path), more_kwargs=more_kwargs)
        gen_sec = round(time.time() - t0, 2)
        tmp_file = Path(str(output_path) + ".tmp.mp4")
        if tmp_file.exists():
            try:
                tmp_file.unlink()
            except Exception:
                pass
        est_frames = int(round(audio_duration_sec * 25)) if audio_duration_sec > 0 else 0
        eff_fps = round(est_frames / gen_sec, 1) if gen_sec > 0 and est_frames > 0 else 0.0
        timing_info = {
            "sdk_load_sec": sdk_load_sec,
            "ditto_gen_sec": gen_sec,
            "audio_duration_sec": audio_duration_sec,
            "frames": est_frames,
            "effective_fps": eff_fps,
            "sampling_timesteps": sampling_timesteps,
            "frame_stride": frame_stride,
        }
        print(
            f"[DittoEngine] Video generated in {gen_sec:.2f}s "
            f"(audio={audio_duration_sec}s, frames={est_frames}, speed={eff_fps}fps) -> {output_path.name}",
            flush=True,
        )
        return output_path, timing_info
