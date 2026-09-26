"""Text clips are rasterised to transparent PNGs with Pillow, then composited by
FFmpeg exactly like image clips (so transform/crop/opacity all apply)."""

from __future__ import annotations

import hashlib
import math
import threading
from functools import lru_cache
from pathlib import Path
from typing import Optional

from PIL import Image, ImageColor, ImageDraw, ImageFont

from .. import config
from ..models import TextStyle

_scan_lock = threading.Lock()


@lru_cache(maxsize=1)
def font_index() -> dict[str, dict[str, str]]:
    """{family: {style_key: path}} where style_key in regular/bold/italic/bolditalic."""
    with _scan_lock:
        index: dict[str, dict[str, str]] = {}
        seen: set[Path] = set()
        for root in config.FONT_DIRS:
            try:
                if not root.is_dir():
                    continue
                candidates = sorted(root.rglob("*"))
            except OSError:  # e.g. an unreadable home directory in a container
                continue
            for path in candidates:
                if path.suffix.lower() not in (".ttf", ".otf") or path in seen:
                    continue
                seen.add(path)
                try:
                    family, style = ImageFont.truetype(str(path), 12).getname()
                except Exception:  # noqa: BLE001 - unreadable font files are skipped
                    continue
                if not family:
                    continue
                s = (style or "").lower()
                bold = any(k in s for k in ("bold", "black", "heavy")) and "semi" not in s
                italic = "italic" in s or "oblique" in s
                key = ("bold" if bold else "") + ("italic" if italic else "") or "regular"
                if key == "regular" and s not in ("regular", "book", "roman", "normal", "medium", ""):
                    continue  # skip light/condensed/etc. variants for the regular slot
                index.setdefault(family, {}).setdefault(key, str(path))
        return {k: index[k] for k in sorted(index, key=str.lower) if "regular" in index[k]}


def families() -> list[str]:
    return list(font_index().keys())


def resolve_font(family: str, bold: bool, italic: bool) -> Optional[str]:
    idx = font_index()
    styles = idx.get(family)
    if styles is None:
        low = family.lower()
        styles = next((v for k, v in idx.items() if k.lower() == low), None)
    if styles is None:
        styles = idx.get("DejaVu Sans") or next(iter(idx.values()), None)
    if styles is None:
        return None
    key = ("bold" if bold else "") + ("italic" if italic else "") or "regular"
    return styles.get(key) or styles.get("bold" if bold else "italic" if italic else "regular") or styles["regular"]


def _rgba(color: Optional[str], fallback=(255, 255, 255, 255)) -> tuple[int, int, int, int]:
    if not color:
        return fallback
    try:
        c = ImageColor.getcolor(color, "RGBA")
        return c if isinstance(c, tuple) else fallback  # type: ignore[return-value]
    except ValueError:
        return fallback


def _cache_dir() -> Path:
    d = config.DATA_DIR / "cache" / "text"
    d.mkdir(parents=True, exist_ok=True)
    return d


def text_key(style: TextStyle) -> str:
    return hashlib.sha1(style.model_dump_json().encode()).hexdigest()[:20]


def render_text(style: TextStyle) -> tuple[Path, int, int]:
    """Rasterise at project resolution. Returns (png_path, width, height)."""
    out = _cache_dir() / f"{text_key(style)}.png"
    if out.is_file():
        with Image.open(out) as im:
            return out, im.width, im.height

    font_path = resolve_font(style.font, style.bold, style.italic)
    font = ImageFont.truetype(font_path, style.size) if font_path else ImageFont.load_default(style.size)
    content = style.content if style.content.strip() else " "
    spacing = int(style.size * (style.line_spacing - 1.0))

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    kwargs = dict(font=font, spacing=spacing, align=style.align, stroke_width=style.stroke_width)
    left, top, right, bottom = (math.floor(v) if i < 2 else math.ceil(v)
                                for i, v in enumerate(probe.multiline_textbbox((0, 0), content, **kwargs)))
    pad = style.padding if style.background else max(style.stroke_width, 2)
    w = max(1, right - left + pad * 2)
    h = max(1, bottom - top + pad * 2)

    img = Image.new("RGBA", (w, h), _rgba(style.background, (0, 0, 0, 0)) if style.background else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.multiline_text(
        (pad - left, pad - top), content,
        fill=_rgba(style.color), stroke_fill=_rgba(style.stroke_color, (0, 0, 0, 255)), **kwargs,
    )
    tmp = out.with_suffix(f".{threading.get_ident()}.png")
    img.save(tmp, "PNG")
    tmp.replace(out)
    return out, w, h


def measure(style: TextStyle) -> tuple[int, int]:
    _, w, h = render_text(style)
    return w, h
