"""Turning tracking results into motion on the canvas (render time).

* follow     - a clip moves / rotates / scales with a point or transform tracker
               (After Effects: Track Motion -> Apply to layer).
* pin        - a clip is corner-pinned onto a corner-pin tracker's surface.
* stabilize  - a clip is counter-moved along its smoothed (or locked) camera path.

Tracking results are in normalised source coordinates and source time; they
are mapped through the tracked clip's own placement on the canvas at each
moment (its keyframes included), so moving / scaling the tracked footage keeps
everything attached. Nothing here re-tracks: changing smoothness, what to
apply, or which clip follows only changes the render.
"""

from __future__ import annotations

import hashlib
import math
from functools import lru_cache
from typing import NamedTuple, Optional

import numpy as np

from ..models import Clip, Project, Tracker
from . import tracking


class Found(NamedTuple):
    clip: Clip
    tracker: Tracker
    key: str
    data: Optional[dict]


def find(project: Project, clip_id: str, tracker_id: str) -> Optional[Found]:
    clip = next((c for c in project.clips if c.id == clip_id), None)
    if clip is None or clip.asset_id is None:
        return None
    tracker = next((t for t in clip.trackers if t.id == tracker_id), None)
    asset = project.asset(clip.asset_id)
    if tracker is None or asset is None:
        return None
    k = tracking.key(asset, tracker)
    return Found(clip, tracker, k, tracking.load(project.id, k))


def state_token(project: Project) -> str:
    """Changes when any tracker used by the project gains (or loses) its result,
    so cached previews made before tracking finished aren't reused after."""
    parts = []
    for seq in project.sequences:
        for c in seq.clips:
            asset = project.asset(c.asset_id) if c.asset_id else None
            if asset is None:
                continue
            for t in c.trackers:
                k = tracking.key(asset, t)
                parts.append(k + ("1" if tracking.result_path(project.id, k).is_file() else "0"))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:12] if parts else ""


# --------------------------------------------------------------------------- geometry


def source_to_canvas(project: Project, clip: Clip, u: float, nx: float, ny: float) -> tuple[float, float]:
    """Where normalised source point (nx, ny) of ``clip`` is on the canvas at clip time ``u``."""
    from .compositor import base_size, prop_value  # circular import

    base = base_size(project, clip, u)
    if base is None:
        return project.settings.width / 2, project.settings.height / 2
    c = clip.crop
    fx = (nx - c.left) / max(1e-6, c.width_fraction()) - 0.5
    fy = (ny - c.top) / max(1e-6, c.height_fraction()) - 0.5
    if clip.transform.flip_h:
        fx = -fx
    if clip.transform.flip_v:
        fy = -fy
    s = prop_value(clip, "scale", u)
    lx, ly = fx * base[0] * s, fy * base[1] * s
    a = math.radians(prop_value(clip, "rotation", u))
    rx, ry = lx * math.cos(a) - ly * math.sin(a), lx * math.sin(a) + ly * math.cos(a)
    return (project.settings.width / 2 + prop_value(clip, "x", u) + rx,
            project.settings.height / 2 + prop_value(clip, "y", u) + ry)


def _source_time(src: Clip, target: Clip, u: float) -> tuple[float, float]:
    """(tracked clip's local time, its source time) at ``target``'s local time ``u``."""
    us = target.start + u - src.start
    return us, src.in_point + max(0.0, us) * src.speed


# --------------------------------------------------------------------------- follow


def follow_offsets(project: Project, clip: Clip, us: list[float]) -> Optional[dict[str, list[float]]]:
    """Per-sample offsets for ``clip`` at its local times ``us``: dx, dy (canvas
    px), drot (deg), dscale (factor), relative to the tracker's reference frame."""
    link = clip.follow
    if link is None:
        return None
    f = find(project, link.clip_id, link.tracker_id)
    if f is None or f.data is None or f.data["kind"] not in ("point", "transform"):
        return None
    ref = tracking.sample(f.data, f.tracker.ref)
    ref_u = (f.tracker.ref - f.clip.in_point) / f.clip.speed
    p_ref = source_to_canvas(project, f.clip, ref_u, ref[0], ref[1])
    out: dict[str, list[float]] = {"dx": [], "dy": [], "drot": [], "dscale": []}
    for u in us:
        su, st = _source_time(f.clip, clip, u)
        r = tracking.sample(f.data, st)
        p = source_to_canvas(project, f.clip, su, r[0], r[1])
        out["dx"].append(p[0] - p_ref[0] if link.position else 0.0)
        out["dy"].append(p[1] - p_ref[1] if link.position else 0.0)
        out["drot"].append(r[2] - ref[2] if link.rotation else 0.0)
        out["dscale"].append(r[3] / ref[3] if link.scale and ref[3] else 1.0)
    return out


# --------------------------------------------------------------------------- corner pin


def pin_corners(project: Project, clip: Clip, us: list[float]) -> Optional[list[list[tuple[float, float]]]]:
    """Canvas corners (TL, TR, BR, BL) for a pinned clip at local times ``us``."""
    link = clip.pin
    if link is None:
        return None
    f = find(project, link.clip_id, link.tracker_id)
    if f is None or f.data is None or f.data["kind"] != "corner_pin":
        return None
    out = []
    for u in us:
        su, st = _source_time(f.clip, clip, u)
        r = tracking.sample(f.data, st)
        out.append([source_to_canvas(project, f.clip, su, r[2 * i], r[2 * i + 1]) for i in range(4)])
    return out


# --------------------------------------------------------------------------- stabilize


@lru_cache(maxsize=32)
def _correction(project_id: str, key: str, mode: str, smoothness: float, rotation: bool, scale: bool,
                auto_zoom: bool) -> Optional[tuple[np.ndarray, np.ndarray, float]]:
    """(times, per-frame correction rows [dx, dy, deg, scale], constant zoom)."""
    data = tracking.load(project_id, key)
    if data is None or data["kind"] != "stabilize":
        return None
    corr = np.array(tracking.smooth_path(data, smoothness, mode == "lock"), np.float64)
    if len(corr) == 0:
        return None
    if not rotation:
        corr[:, 2] = 0.0
    if not scale:
        corr[:, 3] = 1.0
    zoom = _auto_zoom(corr, *data["size"]) if auto_zoom else 1.0
    return np.array(data["times"], np.float64), corr, zoom


def _auto_zoom(corr: np.ndarray, w: float, h: float) -> float:
    """Smallest constant zoom so no frame shows its moving edge."""
    corners = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    need = 1.0
    for dx, dy, deg, s in corr:
        a = math.radians(-deg)
        R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
        lo, hi = 1.0, 3.0
        for _ in range(20):  # bisection: output corners must map inside the source frame
            z = (lo + hi) / 2
            p = (R @ (corners / z - [dx * w, dy * h]).T).T / s
            if (np.abs(p[:, 0]) <= w / 2 + 1e-6).all() and (np.abs(p[:, 1]) <= h / 2 + 1e-6).all():
                hi = z
            else:
                lo = z
        need = max(need, hi)
    return min(need, 3.0)


def stabilize_offsets(project: Project, clip: Clip, us: list[float]) -> Optional[dict[str, list[float]]]:
    """Per-sample corrections for a stabilised clip: dx, dy (canvas px), drot, dscale."""
    st = clip.stabilize
    if st is None or clip.asset_id is None:
        return None
    f = find(project, clip.id, st.tracker_id)
    if f is None or f.data is None:
        return None
    c = _correction(project.id, f.key, st.mode, st.smoothness, st.rotation, st.scale, st.auto_zoom)
    if c is None:
        return None
    times, corr, zoom = c
    from .compositor import base_size, prop_value  # circular import

    out: dict[str, list[float]] = {"dx": [], "dy": [], "drot": [], "dscale": []}
    for u in us:
        t = clip.in_point + u * clip.speed
        row = [float(np.interp(t, times, corr[:, i])) for i in range(4)]
        base = base_size(project, clip, u) or (0.0, 0.0)
        s = prop_value(clip, "scale", u)
        a = math.radians(prop_value(clip, "rotation", u))
        lx, ly = row[0] * base[0] * s * zoom, row[1] * base[1] * s * zoom
        out["dx"].append(lx * math.cos(a) - ly * math.sin(a))
        out["dy"].append(lx * math.sin(a) + ly * math.cos(a))
        out["drot"].append(row[2])
        out["dscale"].append(row[3] * zoom)
    return out
