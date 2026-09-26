"""Keyframe interpolation, in Python and as FFmpeg expressions.

Both must agree exactly: Python is used for single frames and geometry, the
expression form lets FFmpeg animate per frame while encoding. The frontend
(src/editor/keyframes.ts) implements the same curves.
"""

from __future__ import annotations

from typing import Sequence

from ..models import Keyframe


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
