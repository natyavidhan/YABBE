"""Keyframe evaluation helpers built on :mod:`curves` (the curve maths).

Renders sample these per output frame and drive FFmpeg with timed commands, so
any curve shape renders exactly as the editor shows it.
"""

from __future__ import annotations

from typing import Sequence

from . import curves

from ..models import (SHAPE_COLOR_PROPS, SHAPE_NUMERIC_PROPS, TEXT_COLOR_PROPS, TEXT_INT_FIELDS, TEXT_NUMERIC_PROPS, Clip,
                      Keyframe, ShapeStyle, TextStyle)


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def ease(kind: str, p: float) -> float:
    return curves.named_ease(kind, p)


def value_at(frames: Sequence[Keyframe], u: float) -> float:
    """Value at clip-local time ``u`` (seconds from clip start)."""
    return curves.value_at(frames, u)


def samples(frames: Sequence[Keyframe], u0: float, n: int, fps: float) -> list[float]:
    """Values at u0, u0 + 1/fps, ... (n samples) — what renders use per frame."""
    return [curves.value_at(frames, u0 + i / fps) for i in range(n)]


# -- colours ----------------------------------------------------------------------------


def _rgba(c: str) -> tuple[int, int, int, int]:
    c = c.lstrip("#")
    a = int(c[6:8], 16) if len(c) == 8 else 255
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), a


def color_at(frames: Sequence[Keyframe], u: float) -> str:
    """Per-channel (RGBA) interpolation of colour keyframes."""
    def fmt(ch):
        return "#" + "".join(f"{max(0, min(255, round(x))):02x}" for x in ch)

    col = lambda k: _rgba(k.c or "#ffffff")  # noqa: E731
    if len(frames) == 1:
        return fmt(col(frames[0]))
    i, p = curves.progress_at(frames, u)
    ca, cb = col(frames[i]), col(frames[i + 1])
    return fmt(tuple(x + (y - x) * p for x, y in zip(ca, cb)))


def text_style_at(clip: Clip, u: float) -> TextStyle:
    """The clip's text style with style keyframes evaluated at time ``u``."""
    assert clip.text is not None
    updates: dict = {}
    for prop, field in TEXT_NUMERIC_PROPS.items():
        frames = clip.animated(prop)
        if frames:
            v = value_at(frames, u)
            updates[field] = int(round(v)) if field in TEXT_INT_FIELDS else round(v, 3)
    for prop, field in TEXT_COLOR_PROPS.items():
        frames = clip.animated(prop)
        if frames:
            updates[field] = color_at(frames, u)
    return clip.text.model_copy(update=updates) if updates else clip.text


def shape_style_at(clip: Clip, u: float) -> ShapeStyle:
    """The clip's shape with shape keyframes evaluated at time ``u``."""
    assert clip.shape is not None
    updates: dict = {}
    for prop, field in SHAPE_NUMERIC_PROPS.items():
        frames = clip.animated(prop)
        if frames:
            v = value_at(frames, u)
            lo, hi = (0.0, 0.5) if field == "radius" else (0.0, 500.0) if field == "stroke_width" else (1.0, 8000.0)
            updates[field] = round(min(hi, max(lo, v)), 3)
    for prop, field in SHAPE_COLOR_PROPS.items():
        frames = clip.animated(prop)
        if frames:
            updates[field] = color_at(frames, u)
    return clip.shape.model_copy(update=updates) if updates else clip.shape
