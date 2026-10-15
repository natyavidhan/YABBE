"""Vocal isolation, so the aligner hears the singer rather than the band.

Model: Kim_Vocal_2, an MDX-Net vocal model from the Ultimate Vocal Remover
project (already ONNX). It works on 44.1 kHz stereo spectrograms
(n_fft 7680, hop 1024, the lowest 3072 bins, 256 frames per chunk); the STFT
and its inverse are done here with numpy.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

import numpy as np

from ... import config
from .. import ffmpeg

SR = 44100
N_FFT, HOP, DIM_F, DIM_T = 7680, 1024, 3072, 256
COMPENSATE = 1.009
CHUNK = HOP * (DIM_T - 1)  # samples per model call
TRIM = N_FFT // 2
GEN = CHUNK - 2 * TRIM  # new samples each chunk contributes
_WINDOW = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic Hann


def decode(path: Path, sr: int, channels: int) -> np.ndarray:
    """Audio file → float32 array [channels, samples]."""
    raw = ffmpeg.run(["-i", str(path), "-vn", "-f", "f32le", "-ac", str(channels),
                            "-ar", str(sr), "-"], timeout=600)
    return np.frombuffer(raw, np.float32).reshape(-1, channels).T.copy()


def _stft(x: np.ndarray) -> np.ndarray:
    """[ch, CHUNK] → [ch, N_FFT//2+1, DIM_T] (centered, reflect padded)."""
    pad = N_FFT // 2
    xp = np.pad(x, ((0, 0), (pad, pad)), mode="reflect")
    idx = np.arange(DIM_T)[:, None] * HOP + np.arange(N_FFT)[None, :]
    frames = xp[:, idx] * _WINDOW  # [ch, T, N_FFT]
    return np.fft.rfft(frames, axis=-1).transpose(0, 2, 1)


def _istft(spec: np.ndarray) -> np.ndarray:
    """Inverse of :func:`_stft` (overlap-add with the squared-window normalisation)."""
    frames = np.fft.irfft(spec.transpose(0, 2, 1), n=N_FFT, axis=-1).astype(np.float32) * _WINDOW
    ch = spec.shape[0]
    length = N_FFT + HOP * (DIM_T - 1)
    out = np.zeros((ch, length), np.float32)
    norm = np.zeros(length, np.float32)
    for t in range(DIM_T):
        out[:, t * HOP:t * HOP + N_FFT] += frames[:, t]
        norm[t * HOP:t * HOP + N_FFT] += _WINDOW ** 2
    pad = N_FFT // 2
    return out[:, pad:pad + CHUNK] / np.maximum(norm[pad:pad + CHUNK], 1e-8)


def vocals(mix: np.ndarray, session, on_progress: Optional[Callable[[float], None]] = None,
           batch: int = 1) -> np.ndarray:
    """Stereo 44.1 kHz mix [2, n] → the vocal stem [2, n]."""
    n = mix.shape[1]
    pad = GEN - n % GEN if n % GEN else 0
    x = np.pad(mix, ((0, 0), (TRIM, pad + TRIM)))
    starts = list(range(0, x.shape[1] - CHUNK + 1, GEN))
    out = np.zeros((2, len(starts) * GEN), np.float32)
    for k, s in enumerate(starts):
        spec = _stft(x[:, s:s + CHUNK])[:, :DIM_F]  # [2, F, T] complex
        # UVR's channel layout: left re, left im, right re, right im
        inp = np.stack([spec[0].real, spec[0].imag, spec[1].real, spec[1].imag])[None].astype(np.float32)
        pred = session.run(None, {"input": inp})[0][0]
        full = np.zeros((2, N_FFT // 2 + 1, DIM_T), np.complex64)
        full[0, :DIM_F] = pred[0] + 1j * pred[1]
        full[1, :DIM_F] = pred[2] + 1j * pred[3]
        wav = _istft(full)
        out[:, k * GEN:(k + 1) * GEN] = wav[:, TRIM:TRIM + GEN]
        if on_progress:
            on_progress((k + 1) / len(starts))
    return out[:, :n] * COMPENSATE


def session():
    import onnxruntime as ort

    so = ort.SessionOptions()
    if config.ROTO_THREADS:
        so.intra_op_num_threads = config.ROTO_THREADS
    return ort.InferenceSession(str(config.MODELS_DIR / "lyrics" / "vocals.onnx"), so,
                                providers=["CPUExecutionProvider"])
