"""Transition catalogue + small animated previews (rendered once, cached)."""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import config
from ..engine import ffmpeg, transitions

router = APIRouter(prefix="/api/transitions", tags=["transitions"])

_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()
PREVIEW_VERSION = 1


@router.get("")
def catalog():
    return {
        "categories": transitions.CATEGORIES,
        "transitions": transitions.catalog_json(),
        "default_duration": transitions.DEFAULT_DURATION,
        "min_duration": transitions.MIN_DURATION,
        "max_duration": transitions.MAX_DURATION,
    }


def _render_preview(kind: str, out: Path) -> None:
    W, H, fps = 192, 108, 20
    hold, D = 0.6, 0.9
    total = hold * 2 + D
    graph = [
        f"[0:v]format=rgba,split[a0][a1]",
        f"[1:v]format=rgba,split[b0][b1]",
        f"[a0]trim=0:{hold},setpts=PTS-STARTPTS[ah]",
        f"[a1]trim=start={hold}:end={hold + D},setpts=PTS-STARTPTS[at]",
        f"[b0]trim=0:{D},setpts=PTS-STARTPTS[bt]",
        f"[b1]trim=start={D}:end={D + hold},setpts=PTS-STARTPTS[bh]",
        *transitions.build_filters(kind, "at", "bt", "tr", D, fps, W, H, f"pv{kind}"),
        "[ah][tr][bh]concat=n=3:v=1:a=0,format=rgba[v]",
    ]
    tmp = out.with_suffix(".part.webp")
    ffmpeg.run([
        "-y",
        "-f", "lavfi", "-i", f"testsrc2=s={W}x{H}:r={fps}:d={total}",
        "-f", "lavfi", "-i", f"gradients=s={W}x{H}:r={fps}:d={total}:c0=0x7c5cff:c1=0x20c997:speed=0.02",
        "-filter_complex", ";".join(graph), "-map", "[v]",
        "-c:v", "libwebp_anim", "-loop", "0", "-quality", "60", "-an", "-f", "webp", str(tmp),
    ], timeout=60)
    tmp.replace(out)


@router.get("/{kind}/preview.webp")
def preview(kind: str):
    if kind not in transitions.BY_ID:
        raise HTTPException(404, "Unknown transition")
    d = config.DATA_DIR / "cache" / "transitions"
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"{kind}.v{PREVIEW_VERSION}.webp"
    if not out.is_file():
        with _guard:
            lock = _locks.setdefault(kind, threading.Lock())
        with lock:
            if not out.is_file():
                try:
                    _render_preview(kind, out)
                except ffmpeg.FFmpegError as exc:
                    raise HTTPException(500, f"Preview failed: {exc}") from None
    return FileResponse(out, media_type="image/webp", headers={"Cache-Control": "max-age=86400"})
