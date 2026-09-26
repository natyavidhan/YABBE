"""Media ingestion: probing, proxies, filmstrips, posters and waveforms."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path
from typing import Optional

import numpy as np

from .. import config, storage
from ..models import Asset
from . import ffmpeg

IMAGE_CODECS = {"png", "mjpeg", "jpeg2000", "webp", "bmp", "tiff", "jpegls", "ppm", "pgm", "qoi"}
IMAGE_FORMATS = ("image2", "png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe", "jpegls_pipe")

FILMSTRIP_HEIGHT = 64
FILMSTRIP_MAX_FRAMES = 60
POSTER_HEIGHT = 240
WAVEFORM_RATE = 8000
WAVEFORM_PEAKS_PER_SECOND = 100


def _parse_rate(rate: Optional[str]) -> float:
    if not rate or rate in ("0/0", "0"):
        return 0.0
    num, _, den = rate.partition("/")
    try:
        return float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _rotation(stream: dict) -> int:
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                return int(float(sd["rotation"]))
            except (TypeError, ValueError):
                pass
    try:
        return int(stream.get("tags", {}).get("rotate", 0))
    except (TypeError, ValueError):
        return 0


def analyze(path: Path) -> dict:
    """Probe a file and return the Asset fields describing it."""
    info = ffmpeg.probe(str(path))
    streams = info.get("streams", [])
    fmt = info.get("format", {})
    video = next(
        (s for s in streams if s.get("codec_type") == "video"
         and not (s.get("disposition", {}) or {}).get("attached_pic")),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video is None and audio is None:
        raise ffmpeg.FFmpegError("File has no audio or video streams")

    duration = 0.0
    for candidate in (fmt.get("duration"), (video or {}).get("duration"), (audio or {}).get("duration")):
        try:
            duration = float(candidate)
            if duration > 0:
                break
        except (TypeError, ValueError):
            continue

    fields: dict = {"has_audio": audio is not None, "has_video": video is not None}
    if video is not None:
        w, h = int(video.get("width") or 0), int(video.get("height") or 0)
        if abs(_rotation(video)) % 180 == 90:  # ffmpeg auto-rotates on decode
            w, h = h, w
        fields.update(width=w, height=h)
        still_codec = video.get("codec_name") in IMAGE_CODECS | {"gif"}
        is_image = fmt.get("format_name", "").startswith(IMAGE_FORMATS) or (
            still_codec and audio is None and duration <= 0.1
        )
        if is_image:
            fields.update(kind="image", duration=0.0, has_audio=False)
        else:
            fps = _parse_rate(video.get("avg_frame_rate")) or _parse_rate(video.get("r_frame_rate"))
            fields.update(kind="video", duration=duration, fps=round(fps, 3))
    else:
        fields.update(kind="audio", duration=duration)
    return fields


# -- derived files -------------------------------------------------------------------------

def proxy_path(project_id: str, asset: Asset) -> Path:
    ext = ".png" if asset.kind == "image" else ".mp4"
    return storage.cache_dir(project_id) / f"{asset.id}_proxy{ext}"


def filmstrip_path(project_id: str, asset_id: str) -> Path:
    return storage.cache_dir(project_id) / f"{asset_id}_filmstrip.jpg"


def poster_path(project_id: str, asset_id: str) -> Path:
    return storage.cache_dir(project_id) / f"{asset_id}_poster.jpg"


def waveform_path(project_id: str, asset_id: str) -> Path:
    return storage.cache_dir(project_id) / f"{asset_id}_waveform.bin"


def source_path(project_id: str, asset: Asset) -> Path:
    return storage.media_dir(project_id) / asset.filename


def preview_source(project_id: str, asset: Asset) -> Path:
    """Proxy when available (fast seeking, small frames), else the original."""
    p = proxy_path(project_id, asset)
    return p if p.is_file() else source_path(project_id, asset)


def make_proxy(project_id: str, asset: Asset, on_progress) -> None:
    src = source_path(project_id, asset)
    dst = proxy_path(project_id, asset)
    tmp = dst.with_name(dst.stem + ".part" + dst.suffix)
    if asset.kind == "image":
        # Downscale huge photos; keep alpha by writing PNG.
        limit = config.PROXY_HEIGHT * 2
        vf = f"scale=-2:'min({limit},ih)'" if asset.height > limit else "null"
        ffmpeg.run(["-y", "-i", str(src), "-vf", vf, "-frames:v", "1", "-update", "1", str(tmp)])
    else:
        vf = f"scale=-2:'min({config.PROXY_HEIGHT},ih)',format=yuv420p"
        ffmpeg.run_with_progress(
            [
                "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                # Short GOP => cheap random access for frame and segment rendering.
                "-g", "12", "-keyint_min", "12", "-sc_threshold", "0",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
                "-movflags", "+faststart", "-f", "mp4", str(tmp),
            ],
            asset.duration,
            on_progress,
        )
    tmp.replace(dst)


def make_poster(project_id: str, asset: Asset) -> None:
    src = preview_source(project_id, asset)
    dst = poster_path(project_id, asset.id)
    seek = [] if asset.kind == "image" else ["-ss", f"{min(1.0, asset.duration / 3):.3f}"]
    ffmpeg.run([
        "-y", *seek, "-i", str(src), "-frames:v", "1",
        "-vf", f"scale=-2:'min({POSTER_HEIGHT},ih)'", "-q:v", "4", "-update", "1", str(dst),
    ])


def make_filmstrip(project_id: str, asset: Asset) -> tuple[int, float]:
    """Horizontal sprite of evenly spaced thumbnails. Returns (count, interval)."""
    src = preview_source(project_id, asset)
    dst = filmstrip_path(project_id, asset.id)
    if asset.kind == "image" or asset.duration <= 0:
        ffmpeg.run([
            "-y", "-i", str(src), "-frames:v", "1",
            "-vf", f"scale=-2:{FILMSTRIP_HEIGHT}", "-q:v", "5", "-update", "1", str(dst),
        ])
        return 1, 0.0
    interval = max(1.0, asset.duration / FILMSTRIP_MAX_FRAMES)
    count = max(1, min(FILMSTRIP_MAX_FRAMES, math.ceil(asset.duration / interval)))
    ffmpeg.run([
        "-y", "-i", str(src), "-an",
        "-vf", f"fps=1/{interval:.4f},scale=-2:{FILMSTRIP_HEIGHT},tile={count}x1",
        "-frames:v", "1", "-q:v", "5", "-update", "1", str(dst),
    ])
    return count, interval


def make_waveform(project_id: str, asset: Asset) -> None:
    """Peak envelope (uint8, WAVEFORM_PEAKS_PER_SECOND values per second)."""
    src = source_path(project_id, asset)
    dst = waveform_path(project_id, asset.id)
    cmd = [
        config.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(src),
        "-map", "0:a:0", "-ac", "1", "-ar", str(WAVEFORM_RATE), "-f", "s16le", "pipe:1",
    ]
    bucket = WAVEFORM_RATE // WAVEFORM_PEAKS_PER_SECOND
    peaks: list[np.ndarray] = []
    leftover = np.empty(0, dtype=np.int16)
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(bucket * 2 * 4096)
            if not chunk:
                break
            data = np.concatenate([leftover, np.frombuffer(chunk[: len(chunk) - len(chunk) % 2], dtype=np.int16)])
            usable = len(data) - len(data) % bucket
            if usable:
                block = np.abs(data[:usable].astype(np.int32)).reshape(-1, bucket).max(axis=1)
                peaks.append(block)
            leftover = data[usable:]
    if len(leftover):
        peaks.append(np.array([np.abs(leftover.astype(np.int32)).max()]))
    arr = np.concatenate(peaks) if peaks else np.zeros(1, dtype=np.int32)
    top = max(1, int(arr.max()))
    # Normalise so quiet files are still visible, but keep relative dynamics.
    out = np.clip(arr * (255.0 / top), 0, 255).astype(np.uint8)
    dst.write_bytes(out.tobytes())


def clear_derived(project_id: str, asset_id: str) -> None:
    for p in storage.cache_dir(project_id).glob(f"{asset_id}_*"):
        p.unlink(missing_ok=True)
