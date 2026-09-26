"""Keyframe interpolation, in Python and as FFmpeg expressions.

Both must agree exactly: Python is used for single frames and geometry, the
expression form lets FFmpeg animate per frame while encoding. The frontend
(src/editor/keyframes.ts) implements the same curves.
"""

from __future__ import annotations

from typing import Sequence

from ..models import TEXT_COLOR_PROPS, TEXT_INT_FIELDS, TEXT_NUMERIC_PROPS, Clip, Keyframe, TextStyle


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def ease(kind: str, p: float) -> float:
    p = min(1.0, max(0.0, p))
    if kind == "hold":
        return 0.0
    if kind == "ease_in":
        return p * p * p
    if kind == "ease_out":
        return 1 - (1 - p) ** 3
    if kind == "ease_in_out":
        return 4 * p * p * p if p < 0.5 else 1 - ((-2 * p + 2) ** 3) / 2
    return p


def value_at(frames: Sequence[Keyframe], u: float) -> float:
    """Value at clip-local time ``u`` (seconds from clip start)."""
    if u <= frames[0].t:
        return frames[0].v
    for a, b in zip(frames, frames[1:]):
        if u < b.t:
            span = b.t - a.t
            p = (u - a.t) / span if span > 0 else 1.0
            return a.v + (b.v - a.v) * ease(a.ease, p)
    return frames[-1].v


def _ease_expr(kind: str, p: str) -> str:
    if kind == "hold":
        return "0"
    if kind == "ease_in":
        return f"pow({p},3)"
    if kind == "ease_out":
        return f"(1-pow(1-{p},3))"
    if kind == "ease_in_out":
        return f"if(lt({p},0.5),4*pow({p},3),1-pow(2-2*{p},3)/2)"
    return p


def expr(frames: Sequence[Keyframe], u: str) -> str:
    """FFmpeg expression of clip-local time expression ``u``.

    Uses no commas outside function calls' argument lists, but the result must
    still be single-quoted inside a filtergraph.
    """
    if len(frames) == 1:
        return _num(frames[0].v)
    out = _num(frames[-1].v)
    # Build from the last segment backwards: if(lt(u,t_{i+1}), seg_i, rest)
    for a, b in reversed(list(zip(frames, frames[1:]))):
        span = b.t - a.t
        if span <= 0:
            continue
        p = f"clip(({u}-{_num(a.t)})/{_num(span)},0,1)"
        seg = f"({_num(a.v)}+{_num(b.v - a.v)}*{_ease_expr(a.ease, p)})"
        out = f"if(lt({u},{_num(b.t)}),{seg},{out})"
    return f"if(lt({u},{_num(frames[0].t)}),{_num(frames[0].v)},{out})"


def value_range(frames: Sequence[Keyframe]) -> tuple[float, float]:
    """Min/max the curve reaches (eased curves never overshoot the keys)."""
    vs = [k.v for k in frames]
    return min(vs), max(vs)


# -- colours ----------------------------------------------------------------------------


def _rgba(c: str) -> tuple[int, int, int, int]:
    c = c.lstrip("#")
    a = int(c[6:8], 16) if len(c) == 8 else 255
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), a


def color_at(frames: Sequence[Keyframe], u: float) -> str:
    """Per-channel (RGBA) interpolation of colour keyframes."""
    def fmt(ch):
        return "#" + "".join(f"{max(0, min(255, round(x))):02x}" for x in ch)

    if u <= frames[0].t:
        return fmt(_rgba(frames[0].c or "#ffffff"))
    for a, b in zip(frames, frames[1:]):
        if u < b.t:
            span = b.t - a.t
            p = ease(a.ease, (u - a.t) / span if span > 0 else 1.0)
            ca, cb = _rgba(a.c or "#ffffff"), _rgba(b.c or "#ffffff")
            return fmt(tuple(x + (y - x) * p for x, y in zip(ca, cb)))
    return fmt(_rgba(frames[-1].c or "#ffffff"))


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
