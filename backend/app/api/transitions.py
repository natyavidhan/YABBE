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
PREVIEW_VERSION = 2
PW, PH, PFPS = 320, 180, 24
HOLD, PD = 0.5, 1.0


def _cache() -> Path:
    d = config.DATA_DIR / "cache" / "transitions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _paths(kind: str) -> tuple[Path, Path]:
    d = _cache()
    return d / f"{kind}.v{PREVIEW_VERSION}.webp", d / f"{kind}.v{PREVIEW_VERSION}.jpg"


def sample_images() -> tuple[Path, Path]:
    """Two illustrative stills (drawn once with Pillow): a warm sunset "A" and
    a cool night sea "B", so previews read clearly as scene A → scene B."""
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    from ..engine.text import resolve_font

    a_path, b_path = _cache() / "sample_a.v2.png", _cache() / "sample_b.v2.png"
    if a_path.is_file() and b_path.is_file():
        return a_path, b_path
    W, H = PW * 2, PH * 2  # drawn at 2x, downscaled by FFmpeg

    def gradient(top, mid, bottom):
        im = Image.new("RGB", (W, H))
        px = im.load()
        for y in range(H):
            f = y / (H - 1)
            c0, c1, g = (top, mid, f * 2) if f < 0.5 else (mid, bottom, f * 2 - 1)
            col = tuple(int(c0[i] + (c1[i] - c0[i]) * g) for i in range(3))
            for x in range(W):
                px[x, y] = col
        return im

    font_path = resolve_font("DejaVu Sans", True, False)
    font = ImageFont.truetype(font_path, 120) if font_path else ImageFont.load_default()

    a = gradient((255, 140, 90), (250, 190, 120), (120, 50, 140))
    d = ImageDraw.Draw(a)
    d.ellipse((W * 0.58, H * 0.30, W * 0.78, H * 0.30 + W * 0.20), fill=(255, 236, 170))
    d.polygon([(0, H), (0, H * 0.62), (W * 0.18, H * 0.45), (W * 0.36, H * 0.66), (W * 0.52, H * 0.50),
               (W * 0.74, H * 0.72), (W, H * 0.55), (W, H)], fill=(70, 30, 90))
    d.polygon([(0, H), (0, H * 0.8), (W * 0.3, H * 0.7), (W * 0.6, H * 0.86), (W, H * 0.76), (W, H)], fill=(40, 16, 60))
    d.text((W * 0.07, H * 0.06), "A", font=font, fill=(255, 255, 255, 230), stroke_width=4, stroke_fill=(90, 30, 90))

    b = gradient((12, 24, 48), (30, 70, 110), (24, 150, 140))
    d = ImageDraw.Draw(b)
    for i in range(40):
        x, y = (i * 97) % W, (i * 53) % int(H * 0.45)
        d.ellipse((x, y, x + 3, y + 3), fill=(230, 240, 255))
    d.ellipse((W * 0.18, H * 0.12, W * 0.30, H * 0.12 + W * 0.12), fill=(240, 244, 255))
    for k in range(6):
        y = H * (0.62 + k * 0.07)
        d.line([(x, y + 8 * __import__("math").sin(x / 40 + k)) for x in range(0, W + 10, 10)],
               fill=(120 + k * 15, 220, 230), width=5)
    d.text((W * 0.80, H * 0.06), "B", font=font, fill=(255, 255, 255, 230), stroke_width=4, stroke_fill=(20, 60, 90))

    a.filter(ImageFilter.SMOOTH).save(a_path)
    b.filter(ImageFilter.SMOOTH).save(b_path)
    return a_path, b_path


def _render_preview(kind: str, webp: Path, poster: Path) -> None:
    a_img, b_img = sample_images()
    total = HOLD * 2 + PD
    graph = [
        f"[0:v]scale={PW}:{PH},format=rgba,split[a0][a1]",
        f"[1:v]scale={PW}:{PH},format=rgba,split[b0][b1]",
        f"[a0]trim=0:{HOLD},setpts=PTS-STARTPTS[ah]",
        f"[a1]trim=start={HOLD}:end={HOLD + PD},setpts=PTS-STARTPTS[at]",
        f"[b0]trim=0:{PD},setpts=PTS-STARTPTS[bt]",
        f"[b1]trim=start={PD}:end={PD + HOLD},setpts=PTS-STARTPTS[bh]",
        *transitions.build_filters(kind, "at", "bt", "tr", PD, PFPS, PW, PH, f"pv{kind}"),
        "[ah][tr][bh]concat=n=3:v=1:a=0,format=rgba,split[v][still]",
        f"[still]select='eq(n\\,{int((HOLD + PD * 0.5) * PFPS)})',format=yuvj420p[p]",
    ]
    tmp_w = webp.with_suffix(".part.webp")
    tmp_p = poster.with_suffix(".part.jpg")
    ffmpeg.run([
        "-y",
        "-loop", "1", "-framerate", str(PFPS), "-t", str(total), "-i", str(a_img),
        "-loop", "1", "-framerate", str(PFPS), "-t", str(total), "-i", str(b_img),
        "-filter_complex", ";".join(graph),
        "-map", "[v]", "-c:v", "libwebp_anim", "-loop", "0", "-quality", "70", "-an", "-f", "webp", str(tmp_w),
        "-map", "[p]", "-frames:v", "1", "-q:v", "4", "-f", "image2", str(tmp_p),
    ], timeout=60)
    tmp_w.replace(webp)
    tmp_p.replace(poster)


def ensure_preview(kind: str) -> tuple[Path, Path]:
    webp, poster = _paths(kind)
    if webp.is_file() and poster.is_file():
        return webp, poster
    with _guard:
        lock = _locks.setdefault(kind, threading.Lock())
    with lock:
        if not (webp.is_file() and poster.is_file()):
            _render_preview(kind, webp, poster)
    return webp, poster


def prerender_all() -> None:
    """Warm the preview cache in the background (called at startup)."""
    for spec in transitions.CATALOG:
        try:
            ensure_preview(spec.id)
        except Exception:  # noqa: BLE001 - a broken preview must not stop the rest
            continue


@router.get("")
def catalog():
    return {
        "categories": transitions.CATEGORIES,
        "transitions": transitions.catalog_json(),
        "default_duration": transitions.DEFAULT_DURATION,
        "min_duration": transitions.MIN_DURATION,
        "max_duration": transitions.MAX_DURATION,
    }


def _serve(kind: str, which: int, media_type: str):
    if kind not in transitions.BY_ID:
        raise HTTPException(404, "Unknown transition")
    try:
        path = ensure_preview(kind)[which]
    except ffmpeg.FFmpegError as exc:
        raise HTTPException(500, f"Preview failed: {exc}") from None
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "max-age=86400"})


@router.get("/{kind}/preview.webp")
def preview(kind: str):
    """Animated preview: sample scene A → transition → scene B, looping."""
    return _serve(kind, 0, "image/webp")


@router.get("/{kind}/poster.jpg")
def poster(kind: str):
    """Still frame from the middle of the transition."""
    return _serve(kind, 1, "image/jpeg")
