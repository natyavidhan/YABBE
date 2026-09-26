"""Keyframe curve maths — the single source of truth for how values move.

Mirrored exactly by ``frontend/src/editor/curves.ts``; both are checked against
``backend/tests/fixtures/curves.json``.

A segment runs from key ``a`` to key ``b``; ``a.ease`` picks its shape:

* ``linear`` / ``hold``
* ``bezier`` — a 2-D cubic Bézier through (t, v) using ``a.ho`` (outgoing
  handle) and ``b.hi`` (incoming handle), both ``(dt, dv)`` offsets from their
  key. Missing handles default to a straight line (⅓ of the segment).
  Handle times are clamped so time never runs backwards.
* ``ease_in`` / ``ease_out`` / ``ease_in_out`` — cubic power curves
* ``back_*`` (overshoot; ``ep[0]`` = overshoot, default 1.70158),
  ``elastic_*`` (``ep[0]`` = oscillations, default 3; ``ep[1]`` = decay,
  default 10), ``bounce_*``.

Colour properties use the same curves on a 0→1 progress value (Bézier handle
``dv`` is then measured in progress units) and blend RGBA per channel.
"""

from __future__ import annotations

import math
from typing import Optional, Sequence

from ..models import Keyframe


def _clamp01(p: float) -> float:
    return 0.0 if p < 0 else 1.0 if p > 1 else p


# -- named eases ------------------------------------------------------------------------


def _bounce_out(p: float) -> float:
    n1, d1 = 7.5625, 2.75
    if p < 1 / d1:
        return n1 * p * p
    if p < 2 / d1:
        p -= 1.5 / d1
        return n1 * p * p + 0.75
    if p < 2.5 / d1:
        p -= 2.25 / d1
        return n1 * p * p + 0.9375
    p -= 2.625 / d1
    return n1 * p * p + 0.984375


def _elastic_out(p: float, osc: float, decay: float) -> float:
    # Damped cosine, corrected so it ends exactly at 1.
    residual = 2 ** (-decay) * math.cos(2 * math.pi * osc)
    return 1 - 2 ** (-decay * p) * math.cos(2 * math.pi * osc * p) + p * residual


def _in_out(f_in, p: float) -> float:
    return f_in(2 * p) / 2 if p < 0.5 else 1 - f_in(2 - 2 * p) / 2


def named_ease(kind: str, p: float, ep: Optional[Sequence[float]] = None) -> float:
    """Progress 0→1 for the named eases (may overshoot for back/elastic)."""
    p = _clamp01(p)
    ep = ep or []
    if kind == "hold":
        return 0.0
    if kind == "ease_in":
        return p * p * p
    if kind == "ease_out":
        return 1 - (1 - p) ** 3
    if kind == "ease_in_out":
        return 4 * p * p * p if p < 0.5 else 1 - ((-2 * p + 2) ** 3) / 2
    if kind.startswith("back_"):
        c1 = ep[0] if ep else 1.70158
        back_in = lambda x: (c1 + 1) * x ** 3 - c1 * x ** 2  # noqa: E731
        if kind == "back_in":
            return back_in(p)
        if kind == "back_out":
            return 1 - back_in(1 - p)
        return _in_out(back_in, p)
    if kind.startswith("elastic_"):
        osc = ep[0] if len(ep) > 0 else 3.0
        decay = ep[1] if len(ep) > 1 else 10.0
        out = lambda x: _elastic_out(x, osc, decay)  # noqa: E731
        if kind == "elastic_out":
            return out(p)
        el_in = lambda x: 1 - out(1 - x)  # noqa: E731
        if kind == "elastic_in":
            return el_in(p)
        return _in_out(el_in, p)
    if kind.startswith("bounce_"):
        b_in = lambda x: 1 - _bounce_out(1 - x)  # noqa: E731
        if kind == "bounce_out":
            return _bounce_out(p)
        if kind == "bounce_in":
            return b_in(p)
        return _in_out(b_in, p)
    return p  # linear (and unknown)


# -- Bézier ------------------------------------------------------------------------------


def bezier_handles(a: Keyframe, b: Keyframe, v0: float, v1: float) -> tuple[float, float, float, float]:
    """Normalised-time control points (x1, y1, x2, y2) for segment a→b, with y
    in value units. Handle times are clamped to keep the curve a function."""
    span = b.t - a.t
    ho = a.ho if a.ho is not None else (span / 3, (v1 - v0) / 3)
    hi = b.hi if b.hi is not None else (-span / 3, -(v1 - v0) / 3)
    hx1 = min(max(ho[0], 0.0), span)
    hx2 = min(max(-hi[0], 0.0), span)
    if hx1 + hx2 > span > 0:
        k = span / (hx1 + hx2)
        hx1, hx2 = hx1 * k, hx2 * k
    x1 = hx1 / span if span > 0 else 0.0
    x2 = 1 - hx2 / span if span > 0 else 1.0
    return x1, v0 + ho[1], x2, v1 + hi[1]


def _cubic(p0: float, p1: float, p2: float, p3: float, s: float) -> float:
    m = 1 - s
    return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3


def _cubic_d(p0: float, p1: float, p2: float, p3: float, s: float) -> float:
    m = 1 - s
    return 3 * m * m * (p1 - p0) + 6 * m * s * (p2 - p1) + 3 * s * s * (p3 - p2)


def solve_bezier_x(x1: float, x2: float, p: float) -> float:
    """Parameter s where the Bézier's x(s) == p (x0=0, x3=1, monotone)."""
    s = p
    for _ in range(8):  # Newton
        x = _cubic(0, x1, x2, 1, s) - p
        if abs(x) < 1e-9:
            return s
        d = _cubic_d(0, x1, x2, 1, s)
        if abs(d) < 1e-9:
            break
        s -= x / d
        if s < 0 or s > 1:
            break
    lo, hi = 0.0, 1.0  # bisection fallback
    s = p
    for _ in range(60):
        x = _cubic(0, x1, x2, 1, s)
        if abs(x - p) < 1e-10:
            break
        if x < p:
            lo = s
        else:
            hi = s
        s = (lo + hi) / 2
    return s


# -- segments & curves ------------------------------------------------------------------


def segment_value(a: Keyframe, b: Keyframe, u: float, v0: float, v1: float) -> float:
    span = b.t - a.t
    if span <= 0:
        return v1
    p = _clamp01((u - a.t) / span)
    if a.ease == "bezier":
        x1, y1, x2, y2 = bezier_handles(a, b, v0, v1)
        s = solve_bezier_x(x1, x2, p)
        return _cubic(v0, y1, y2, v1, s)
    return v0 + (v1 - v0) * named_ease(a.ease, p, a.ep)


def _segment(frames: Sequence[Keyframe], u: float) -> Optional[int]:
    """Index i of the segment frames[i]→frames[i+1] containing u, or None when
    u is before the first / after the last key."""
    if u <= frames[0].t or u >= frames[-1].t:
        return None
    lo, hi = 0, len(frames) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if frames[mid].t <= u:
            lo = mid
        else:
            hi = mid
    return lo


def value_at(frames: Sequence[Keyframe], u: float) -> float:
    i = _segment(frames, u)
    if i is None:
        return frames[0].v if u <= frames[0].t else frames[-1].v
    a, b = frames[i], frames[i + 1]
    return segment_value(a, b, u, a.v, b.v)


def progress_at(frames: Sequence[Keyframe], u: float) -> tuple[int, float]:
    """(segment index, eased progress) — used for colour keys."""
    i = _segment(frames, u)
    if i is None:
        return (0, 0.0) if u <= frames[0].t else (len(frames) - 2, 1.0)
    return i, segment_value(frames[i], frames[i + 1], u, 0.0, 1.0)
