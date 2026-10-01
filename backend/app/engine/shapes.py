"""Shape clips: vector shapes rasterised to transparent PNGs (4x supersampled
for smooth edges), then composited like images, so transform, crop, opacity,
blend modes and keyframes all apply. Drawn at the size they're shown at."""

from __future__ import annotations

import hashlib
import math
import threading
from pathlib import Path

from PIL import Image, ImageColor, ImageDraw

from .. import config
from ..models import ShapeStyle

VERSION = "s2"  # bump when drawing changes, so cached renders aren't reused
SS = 4  # supersampling
MAX_SIDE = 4096


def _rgba(color):
    if not color:
        return None
    c = ImageColor.getcolor(color, "RGBA")
    return c if isinstance(c, tuple) else None


def _cache_dir() -> Path:
    d = config.DATA_DIR / "cache" / "shapes"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _regular(n: int, cx: float, cy: float, rx: float, ry: float, phase: float = -math.pi / 2):
    return [(cx + rx * math.cos(phase + 2 * math.pi * i / n), cy + ry * math.sin(phase + 2 * math.pi * i / n))
            for i in range(n)]


def render(style: ShapeStyle, factor: float = 1.0) -> tuple[Path, int, int]:
    """PNG of the shape at ``factor`` x its size (project px). Returns (path, w, h)."""
    f = max(0.05, min(factor, MAX_SIDE / max(style.width, style.height)))
    w, h = max(1, round(style.width * f)), max(1, round(style.height * f))
    key = hashlib.sha1(f"{VERSION}|{style.model_dump_json()}|{w}x{h}".encode()).hexdigest()[:20]
    out = _cache_dir() / f"{key}.png"
    if out.is_file():
        return out, w, h
    W, H = w * SS, h * SS
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    fill, stroke = _rgba(style.fill), _rgba(style.stroke)
    sw = round(style.stroke_width * f * SS) if stroke else 0
    i = 0.0  # Pillow draws outlines inside the shape, so the shape fills its box exactly
    box = (0, 0, W - 1, H - 1)
    k = style.kind
    if k == "rectangle":
        r = style.radius * min(W, H)
        d.rounded_rectangle(box, radius=r, fill=fill, outline=stroke, width=sw)
    elif k == "ellipse":
        d.ellipse(box, fill=fill, outline=stroke, width=sw)
    elif k in ("triangle", "polygon", "star"):
        cx, cy, rx, ry = W / 2, H / 2, W / 2 - i, H / 2 - i
        if k == "triangle":
            pts = [(cx, i), (W - 1 - i, H - 1 - i), (i, H - 1 - i)]
        elif k == "polygon":
            pts = _regular(style.sides, cx, cy, rx, ry)
        else:
            outer = _regular(style.sides, cx, cy, rx, ry)
            inner = _regular(style.sides, cx, cy, rx * style.inner, ry * style.inner, -math.pi / 2 + math.pi / style.sides)
            pts = [p for pair in zip(outer, inner) for p in pair]
        d.polygon(pts, fill=fill, outline=stroke, width=sw)
    else:  # line / arrow across the box, thickness = stroke width (or the height)
        color = stroke or fill or (255, 255, 255, 255)
        t = max(SS, sw or round(min(style.height * f, 8 * f) * SS))
        y = H / 2
        head = min(W * 0.4, t * 4) if k == "arrow" else 0
        d.line([(t / 2, y), (W - head - (0 if head else t / 2), y)], fill=color, width=t)
        if head:
            d.polygon([(W - head, y - head * 0.6), (W, y), (W - head, y + head * 0.6)], fill=color)
    img = img.resize((w, h), Image.LANCZOS)
    tmp = out.with_suffix(f".{threading.get_ident()}.png")
    img.save(tmp, "PNG")
    tmp.replace(out)
    return out, w, h


def animated_sequence(styles: list[ShapeStyle], fps: float, factor: float) -> tuple[Path, int, int]:
    """One drawing per frame (``styles[i]`` is frame ``i``), centred on a fixed
    transparent canvas (the largest size reached), as an ffconcat list playing at
    ``fps``. Returns (list, canvas width, canvas height) - the canvas in project px."""
    cw = max(s.width for s in styles)
    ch = max(s.height for s in styles)
    f = max(0.05, min(factor, MAX_SIDE / max(cw, ch)))
    W, H = max(2, round(cw * f)), max(2, round(ch * f))
    pad_dir = _cache_dir() / "pad"
    pad_dir.mkdir(exist_ok=True)
    padded: dict[str, Path] = {}
    runs: list[list] = []
    for st in styles:
        k = st.model_dump_json()
        if k not in padded:
            png, w, h = render(st, f)
            out = pad_dir / f"{hashlib.sha1((VERSION + k).encode()).hexdigest()[:16]}_{W}x{H}.png"
            if not out.is_file():
                canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                with Image.open(png) as im:
                    canvas.paste(im, ((W - w) // 2, (H - h) // 2))
                tmp = out.with_suffix(f".{threading.get_ident()}.png")
                canvas.save(tmp, "PNG")
                tmp.replace(out)
            padded[k] = out
        p = padded[k]
        if runs and runs[-1][0] == p:
            runs[-1][1] += 1
        else:
            runs.append([p, 1])
    lines = ["ffconcat version 1.0"]
    for p, n in runs:
        lines += [f"file '{p}'", f"duration {n / fps:.6f}"]
    lines.append(f"file '{runs[-1][0]}'")
    body = "\n".join(lines) + "\n"
    lst = _cache_dir() / "seq"
    lst.mkdir(exist_ok=True)
    path = lst / (hashlib.sha1(body.encode()).hexdigest()[:20] + ".txt")
    if not path.is_file():
        path.write_text(body)
    return path, round(cw), round(ch)
