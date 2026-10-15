"""Music from YouTube, via yt-dlp: search, and download a video's audio as MP3."""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Callable, Optional

from .. import config

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


class YouTubeError(Exception):
    pass


def _js_runtimes() -> dict[str, dict]:
    # yt-dlp needs a JavaScript runtime to solve YouTube's player challenges
    # (Deno is its default; Node works too).
    for name in ("deno", "node", "bun"):
        if shutil.which(name):
            return {name: {}}
    return {}


def _opts(**extra) -> dict[str, Any]:
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "js_runtimes": _js_runtimes(),
        "ffmpeg_location": config.FFMPEG,
        **extra,
    }


def _thumb(entry: dict) -> str:
    return f"https://i.ytimg.com/vi/{entry['id']}/mqdefault.jpg"


def search(query: str, limit: int = 12) -> list[dict]:
    """Videos matching ``query`` (no live streams; ones with a known length)."""
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_opts(extract_flat="in_playlist", skip_download=True)) as ydl:
            # ask for a few extra: live streams and channels get dropped
            res = ydl.extract_info(f"ytsearch{limit + 6}:{query}", download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise YouTubeError(_clean(exc)) from None
    out = []
    for e in (res or {}).get("entries") or []:
        if not e or not VIDEO_ID.fullmatch(str(e.get("id") or "")):
            continue
        if e.get("live_status") in ("is_live", "is_upcoming") or not e.get("duration"):
            continue
        out.append({
            "id": e["id"],
            "title": e.get("title") or e["id"],
            "channel": e.get("channel") or e.get("uploader") or "",
            "duration": float(e["duration"]),
            "thumbnail": _thumb(e),
        })
        if len(out) >= limit:
            break
    return out


def info(video_id: str) -> dict:
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_opts(format="bestaudio/best")) as ydl:
            return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise YouTubeError(_clean(exc)) from None


def download_mp3(
    meta: dict,
    out_dir: Path,
    on_progress: Callable[[float, Optional[str]], None],
) -> Path:
    """Download the best audio stream of ``meta`` (from :func:`info`) and convert it
    to the best MP3 (LAME V0, ~245 kb/s VBR). Returns the .mp3 path."""
    import yt_dlp

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            on_progress(d.get("downloaded_bytes", 0) / total if total else 0.0, "Downloading")

    def pp_hook(d: dict) -> None:
        if d.get("status") == "started" and d.get("postprocessor") == "ExtractAudio":
            on_progress(1.0, "Converting to MP3")

    opts = _opts(
        format="bestaudio/best",
        outtmpl=str(out_dir / "audio.%(ext)s"),
        progress_hooks=[hook],
        postprocessor_hooks=[pp_hook],
        postprocessors=[{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}],
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.process_ie_result(meta, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise YouTubeError(_clean(exc)) from None
    mp3 = out_dir / "audio.mp3"
    if not mp3.is_file():
        raise YouTubeError("The download didn't produce an MP3")
    return mp3


def _clean(exc: Exception) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(exc))
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*\S+:\s*)?", "", msg).strip() or "YouTube request failed"
