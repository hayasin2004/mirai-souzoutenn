"""
Local Voice Cloning TTS & Offline STT Engine for Mirai Voice Studio
Runs 100% locally without cloud APIs:
1. Fast persistent Windows OneCore / SAPI Japanese TTS worker
2. Zero-shot acoustic voice adaptation (F0 fundamental pitch matching + vocal-tract spectral envelope transfer)
   from the user's recorded reference sample (voice_samples/<voice>.wav).
3. Offline Japanese Speech-to-Text fallback via Windows SpeechRecognitionEngine (ja-JP).
"""

import base64
import io
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import librosa
import numpy as np
import scipy.signal as signal
import soundfile as sf

_worker_lock = threading.Lock()
_ps_proc: subprocess.Popen | None = None
_profile_cache: dict[str, dict] = {}


_PS_WORKER_SCRIPT = r"""
Add-Type -AssemblyName System.Speech

$cat = New-Object -ComObject SAPI.SpObjectTokenCategory
$cat.SetId("HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Speech_OneCore\Voices", $false)
$tokens = @{}
foreach ($t in $cat.EnumerateTokens()) {
    $desc = $t.GetDescription()
    if ($desc -match "Ichiro") { $tokens["Ichiro"] = $t }
    elseif ($desc -match "Ayumi") { $tokens["Ayumi"] = $t }
    elseif ($desc -match "Sayaka") { $tokens["Sayaka"] = $t }
    elseif ($desc -match "Haruka") { $tokens["Haruka"] = $t }
}

$spVoice = New-Object -ComObject SAPI.SpVoice
$sysSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$sysSynth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo("ja-JP"))

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq "EXIT") { break }
    try {
        $req = $line | ConvertFrom-Json
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.text_b64))
        $vname = $req.voice
        $rate = [int]$req.rate
        $outPath = $req.out_path
        $wroteOk = $false

        if ($tokens.ContainsKey($vname)) {
            try {
                $spVoice.Voice = $tokens[$vname]
                $spVoice.Rate = $rate
                $fs = New-Object -ComObject SAPI.SpFileStream
                $fs.Open($outPath, 3, $false)
                $spVoice.AudioOutputStream = $fs
                [void]$spVoice.Speak($text)
                $fs.Close()
                if ((Test-Path $outPath) -and ((Get-Item $outPath).Length -gt 200)) {
                    $wroteOk = $true
                }
            } catch {}
        }

        if (-not $wroteOk) {
            $sysSynth.Rate = $rate
            $sysSynth.SetOutputToWaveFile($outPath)
            $sysSynth.Speak($text)
            $sysSynth.SetOutputToNull()
        }

        [Console]::Out.WriteLine("OK")
        [Console]::Out.Flush()
    } catch {
        [Console]::Out.WriteLine("ERR:" + $_.Exception.Message)
        [Console]::Out.Flush()
    }
}
"""


def _get_ps_worker() -> subprocess.Popen:
    global _ps_proc
    if _ps_proc is not None and _ps_proc.poll() is None:
        return _ps_proc
    encoded = base64.b64encode(_PS_WORKER_SCRIPT.encode("utf-16le")).decode("ascii")
    _ps_proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-EncodedCommand", encoded],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
    )
    return _ps_proc


def _compute_spectral_envelope(y: np.ndarray, sr: int, n_fft: int = 1024) -> np.ndarray:
    """Compute smoothed log-magnitude vocal-tract spectral envelope."""
    from scipy.ndimage import gaussian_filter1d
    y_act = y[np.abs(y) > 0.015]
    if len(y_act) < n_fft:
        y_act = y
    _, _, Zxx = signal.stft(y_act, fs=sr, nperseg=n_fft, noverlap=n_fft // 2)
    mag = np.mean(np.abs(Zxx) + 1e-7, axis=1)
    log_mag = np.log(mag)
    return gaussian_filter1d(log_mag, sigma=6.0)


def _estimate_median_f0(y: np.ndarray, sr: int) -> float:
    y_act = y[np.abs(y) > 0.02]
    if len(y_act) < 2048:
        return 140.0
    if len(y_act) > sr * 10:
        y_act = y_act[: sr * 10]
    f0 = librosa.yin(y_act, fmin=65, fmax=380, sr=sr)
    valid = f0[(f0 > 68) & (f0 < 360)]
    if len(valid) == 0:
        return 140.0
    return float(np.median(valid))


def get_speaker_profile(voice_name: str, sample_wav_bytes: bytes | None) -> dict:
    """Extract and cache target speaker's F0 pitch and vocal-tract spectral envelope."""
    cache_key = f"{voice_name}:{len(sample_wav_bytes) if sample_wav_bytes else 0}"
    if cache_key in _profile_cache:
        return _profile_cache[cache_key]

    if not sample_wav_bytes:
        prof = {"base_voice": "Ichiro", "target_f0": None, "env_24k": None}
        _profile_cache[cache_key] = prof
        return prof

    y, sr = sf.read(io.BytesIO(sample_wav_bytes), dtype="float32")
    if y.ndim > 1:
        y = np.mean(y, axis=1)
    if sr != 24000:
        y = librosa.resample(y, orig_sr=sr, target_sr=24000)
        sr = 24000

    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    if peak > 1e-4:
        y = y / peak * 0.9

    target_f0 = _estimate_median_f0(y, sr)
    if target_f0 < 175.0:
        base_voice = "Ichiro"
    elif target_f0 < 235.0:
        base_voice = "Sayaka"
    else:
        base_voice = "Ayumi"

    env_24k = _compute_spectral_envelope(y, sr, n_fft=1024)
    prof = {
        "base_voice": base_voice,
        "target_f0": target_f0,
        "env_24k": env_24k,
    }
    _profile_cache[cache_key] = prof
    return prof


def synthesize_local_cloned_tts(
    text: str,
    voice_name: str,
    sample_wav_bytes: bytes | None = None,
    speed: float | None = None,
) -> bytes:
    """
    Synthesize Japanese speech locally and adapt pitch (F0) + vocal-tract spectral envelope
    to match the target speaker's reference WAV sample.
    Returns 24kHz 16-bit PCM WAV bytes.
    """
    prof = get_speaker_profile(voice_name, sample_wav_bytes)
    base_voice = prof["base_voice"]

    sapi_rate = 1
    if speed is not None and speed != 1.0:
        sapi_rate = int(np.clip(round((speed - 1.0) * 6 + 1), -5, 7))

    text_b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
    tmp_fd, tmp_wav = tempfile.mkstemp(prefix="local_tts_", suffix=".wav")
    os.close(tmp_fd)
    try:
        with _worker_lock:
            proc = _get_ps_worker()
            req = json.dumps(
                {"text_b64": text_b64, "voice": base_voice, "rate": sapi_rate, "out_path": tmp_wav},
                ensure_ascii=True,
            )
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(req + "\n")
            proc.stdin.flush()
            resp_line = proc.stdout.readline().strip()
            if not resp_line.startswith("OK"):
                raise RuntimeError(f"Local OneCore TTS failed: {resp_line}")

        y, sr = sf.read(tmp_wav, dtype="float32")
        if y.ndim > 1:
            y = np.mean(y, axis=1)
        if sr != 24000:
            y = librosa.resample(y, orig_sr=sr, target_sr=24000)
            sr = 24000

        non_silent = np.where(np.abs(y) > 0.008)[0]
        if len(non_silent) > 100:
            pad = int(0.04 * sr)
            s_i = max(0, int(non_silent[0]) - pad)
            e_i = min(len(y), int(non_silent[-1]) + pad)
            y = y[s_i:e_i]

        # 1. Pitch (F0) adaptation to match cloned speaker
        target_f0 = prof.get("target_f0")
        if target_f0 is not None and len(y) > 2048:
            base_f0 = _estimate_median_f0(y, sr)
            if base_f0 > 60.0:
                n_steps = float(np.clip(12.0 * np.log2(target_f0 / base_f0), -10.0, 10.0))
                if abs(n_steps) >= 0.35:
                    y = librosa.effects.pitch_shift(y, sr=sr, n_steps=n_steps, bins_per_octave=12)

        # 2. Vocal-tract spectral envelope (timbre/formant) transfer
        target_env = prof.get("env_24k")
        if target_env is not None and len(y) > 2048:
            n_fft = 1024
            src_env = _compute_spectral_envelope(y, sr, n_fft=n_fft)
            diff_log = np.clip(target_env - src_env, -1.1, 1.1)
            freqs = np.linspace(0, sr / 2, len(diff_log))
            weight = np.ones_like(diff_log) * 0.62
            weight[freqs < 85] = 0.0
            weight[freqs > 8500] = 0.15
            gain = np.exp(diff_log * weight)[:, None]

            _, _, Zxx = signal.stft(y, fs=sr, nperseg=n_fft, noverlap=n_fft // 2)
            _, y_mod = signal.istft(Zxx * gain, fs=sr, nperseg=n_fft, noverlap=n_fft // 2)
            y = y_mod[: len(y)].astype(np.float32)

        peak = float(np.max(np.abs(y))) if len(y) else 0.0
        if peak > 1e-4:
            y = (y / peak * 0.88).astype(np.float32)

        out_buf = io.BytesIO()
        sf.write(out_buf, y, 24000, subtype="PCM_16", format="WAV")
        return out_buf.getvalue()
    finally:
        if os.path.exists(tmp_wav):
            try:
                os.remove(tmp_wav)
            except Exception:
                pass


def transcribe_audio_local_sapi(wav_path: str | Path) -> str:
    """Offline Japanese Speech-to-Text fallback using Windows System.Speech.Recognition (ja-JP)."""
    ps_script = f"""
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$culture = New-Object System.Globalization.CultureInfo("ja-JP")
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToWaveFile("{str(Path(wav_path).resolve())}")
$res = $rec.Recognize()
$rec.Dispose()
if ($null -ne $res) {{
    [Console]::Out.WriteLine($res.Text)
}}
"""
    encoded = base64.b64encode(ps_script.encode("utf-16le")).decode("ascii")
    cp = subprocess.run(
        ["powershell", "-NoProfile", "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
    )
    return (cp.stdout or "").strip()
