"""Motion tracking (After Effects' Tracker panel, lightweight edition).

Four trackers, all running on the CPU:

* ``point``      - one feature's position (Track Motion: position).
* ``transform``  - position, rotation and scale of a region (Track Motion:
                   position + rotation + scale).
* ``corner_pin`` - a flat surface's four corners (planar / perspective).
* ``stabilize``  - the camera's own motion over the whole frame.

Method (best practice from the literature, tuned for speed):

* Features: Shi-Tomasi corners inside the region (Shi & Tomasi, CVPR 1994).
* Motion: pyramidal Lucas-Kanade optical flow (Bouguet 2000). Each frame is
  matched against the *reference* frame (drift-free), with the previous
  frame's motion as the starting guess; the reference is only refreshed when
  too few features still match (Blender/libmv's "keyframe" matching).
* Outliers: forward-backward error (Kalal et al., ICPR 2010) plus RANSAC
  when fitting the motion model (translation / similarity / homography).
* Refinement: point tracks are refined to sub-pixel by normalised cross
  correlation against the reference pattern (the classic correlation
  tracker, also its confidence); corner pins by ECC image alignment
  (Evangelidis & Psarakis, PAMI 2008).
* Stabilisation: frame-to-frame global similarity (RANSAC) accumulated into
  the camera path; smoothing happens at render time, so changing it never
  needs re-tracking.

Frames are decoded by FFmpeg at analysis resolution (the proxy height for
"fast", up to 1080p for "precise") and streamed, never all held in memory.
Results are stored per content key (asset + tracker settings), so the same
tracker is never analysed twice and edits that don't touch it reuse it.
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
import threading
from pathlib import Path
from typing import Callable, Iterator, Optional

import cv2
import numpy as np

from .. import config, storage
from ..models import Asset, Tracker
from . import media

VERSION = "t1"
_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()


# --------------------------------------------------------------------------- keys & files


def key(asset: Asset, tracker: Tracker) -> str:
    params = tracker.model_dump_json(include={"kind", "ref", "box", "quad", "start", "end", "quality"})
    return hashlib.sha1(f"{VERSION}|{asset.id}|{asset.duration}|{params}".encode()).hexdigest()[:20]


def result_path(project_id: str, k: str) -> Path:
    return storage.cache_dir(project_id) / "tracks" / f"{k}.json"


def load(project_id: str, k: str) -> Optional[dict]:
    with _cache_lock:
        hit = _cache.get(f"{project_id}/{k}")
    if hit is not None:
        return hit
    path = result_path(project_id, k)
    if not path.is_file():
        return None
    data = json.loads(path.read_text())
    with _cache_lock:
        if len(_cache) > 64:
            _cache.clear()
        _cache[f"{project_id}/{k}"] = data
    return data


def _save(project_id: str, k: str, data: dict) -> None:
    path = result_path(project_id, k)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(path)


# --------------------------------------------------------------------------- frames


def _analysis_size(asset: Asset, quality: str) -> tuple[int, int]:
    cap = config.PROXY_HEIGHT if quality == "fast" else 1080
    h = min(asset.height, cap)
    h -= h % 2
    w = round(asset.width * h / asset.height / 2) * 2
    return w, h


def _frames(project_id: str, asset: Asset, quality: str, start: float, end: float, fps: float) -> Iterator[np.ndarray]:
    """Grey frames of the source from ``start`` to ``end`` (source seconds)."""
    src = media.preview_source(project_id, asset) if quality == "fast" else media.source_path(project_id, asset)
    w, h = _analysis_size(asset, quality)
    cmd = [config.FFMPEG, "-v", "error", "-nostdin", "-ss", f"{start:.6f}", "-i", str(src),
           "-t", f"{max(0.0, end - start):.6f}", "-an", "-vf", f"fps={fps},scale={w}:{h},format=gray",
           "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w)
    finally:
        proc.kill()
        proc.wait()


def _frames_backward(project_id: str, asset: Asset, quality: str, start: float, end: float, fps: float,
                     chunk: float = 4.0) -> Iterator[np.ndarray]:
    """Frames from ``end`` back to ``start``, decoded a few seconds at a time."""
    t1 = end
    while t1 > start + 1e-6:
        t0 = max(start, t1 - chunk)
        block = list(_frames(project_id, asset, quality, t0, t1, fps))
        yield from reversed(block)
        t1 = t0


# --------------------------------------------------------------------------- tracking core

LK = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))


def _features(img: np.ndarray, mask: Optional[np.ndarray], n: int = 200) -> np.ndarray:
    pts = cv2.goodFeaturesToTrack(img, maxCorners=n, qualityLevel=0.005, minDistance=5, mask=mask, blockSize=7)
    return np.empty((0, 1, 2), np.float32) if pts is None else pts.astype(np.float32)


def _flow(a: np.ndarray, b: np.ndarray, pts: np.ndarray, guess: Optional[np.ndarray] = None,
          fb_max: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """Track ``pts`` from ``a`` to ``b``; returns (new points, ok mask) after the
    forward-backward check."""
    if len(pts) == 0:
        return pts, np.zeros(0, bool)
    flags = 0
    nxt = None
    if guess is not None:
        nxt, flags = guess.copy(), cv2.OPTFLOW_USE_INITIAL_FLOW
    nxt, st, _ = cv2.calcOpticalFlowPyrLK(a, b, pts, nxt, flags=flags, **LK)
    back, st2, _ = cv2.calcOpticalFlowPyrLK(b, a, nxt, pts.copy(), flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **LK)
    fb = np.linalg.norm((back - pts).reshape(-1, 2), axis=1)
    ok = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < fb_max)
    return nxt, ok


def _apply(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply a 3x3 transform to Nx1x2 points."""
    return cv2.perspectiveTransform(pts.reshape(-1, 1, 2).astype(np.float32), M.astype(np.float64)).astype(np.float32)


def _similarity(src: np.ndarray, dst: np.ndarray) -> Optional[np.ndarray]:
    A, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=500)
    if A is None:
        return None
    return np.vstack([A, [0, 0, 1]])


def _ncc_refine(img: np.ndarray, tpl: np.ndarray, center: np.ndarray, radius: int = 6) -> tuple[np.ndarray, float]:
    """Sub-pixel position of ``tpl`` near ``center`` by normalised cross correlation."""
    th, tw = tpl.shape
    x0 = int(round(center[0] - tw / 2)) - radius
    y0 = int(round(center[1] - th / 2)) - radius
    H, W = img.shape
    if x0 < 0 or y0 < 0 or x0 + tw + 2 * radius > W or y0 + th + 2 * radius > H:
        return center, 0.0
    win = img[y0:y0 + th + 2 * radius, x0:x0 + tw + 2 * radius]
    r = cv2.matchTemplate(win, tpl, cv2.TM_CCOEFF_NORMED)
    _, best, _, (bx, by) = cv2.minMaxLoc(r)

    def sub(v_m, v0, v_p):  # parabola vertex
        d = v_m - 2 * v0 + v_p
        return 0.0 if abs(d) < 1e-9 else 0.5 * (v_m - v_p) / d

    dx = sub(r[by, bx - 1], r[by, bx], r[by, bx + 1]) if 0 < bx < r.shape[1] - 1 else 0.0
    dy = sub(r[by - 1, bx], r[by, bx], r[by + 1, bx]) if 0 < by < r.shape[0] - 1 else 0.0
    return np.array([x0 + bx + dx + tw / 2, y0 + by + dy + th / 2], np.float64), float(best)


class _RegionTracker:
    """Point / transform / corner pin: a region followed through the frames."""

    def __init__(self, kind: str, ref_img: np.ndarray, box_px: tuple[float, float, float, float],
                 quad_px: Optional[np.ndarray]):
        self.kind = kind
        H, W = ref_img.shape
        mask = np.zeros_like(ref_img)
        if quad_px is not None:
            cv2.fillConvexPoly(mask, quad_px.astype(np.int32), 255)
        else:
            cx, cy, bw, bh = box_px
            cv2.rectangle(mask, (int(cx - bw / 2), int(cy - bh / 2)), (int(cx + bw / 2), int(cy + bh / 2)), 255, -1)
        self.box = box_px
        self.quad = quad_px
        self._set_reference(ref_img, mask, np.eye(3))
        self.M = np.eye(3)  # reference frame -> current frame
        self.prev_M = np.eye(3)
        # The original pattern, cropped to the region (+ margin): the ECC target.
        pts = self._region_orig()
        m = 4
        x0, y0 = (max(0, int(v) - m) for v in pts.min(0))
        x1, y1 = (int(v) + m for v in pts.max(0))
        self._pattern = (ref_img[y0:y1, x0:x1].copy(), mask[y0:y1, x0:x1].copy(), (x0, y0))
        self.tpl = None
        if kind == "point":
            cx, cy, bw, bh = box_px
            x0, y0 = max(0, int(round(cx - bw / 2))), max(0, int(round(cy - bh / 2)))
            self.tpl = ref_img[y0:y0 + max(8, int(bh)), x0:x0 + max(8, int(bw))].copy()

    def _set_reference(self, img: np.ndarray, mask: np.ndarray, R: np.ndarray) -> None:
        self.ref_img = img
        self.ref_pts = _features(img, mask)
        self.R = R  # original frame -> this reference frame
        self.R_inv = np.linalg.inv(R)
        self.ref_count = len(self.ref_pts)

    def step(self, img: np.ndarray) -> tuple[np.ndarray, float]:
        """Track into ``img``; returns (M original->current, confidence 0..1)."""
        # Constant-velocity guess for where the reference features are now.
        velocity = self.M @ np.linalg.inv(self.prev_M)
        guess_M = velocity @ self.M
        M_ref = guess_M @ self.R_inv  # reference frame -> current (guess)
        conf = 0.0
        if len(self.ref_pts) >= 4:
            guess = _apply(M_ref, self.ref_pts)
            nxt, ok = _flow(self.ref_img, img, self.ref_pts, guess)
            src, dst = self.ref_pts[ok], nxt[ok]
            fit = None
            if self.kind == "point" and len(src) >= 1:
                d = np.median((dst - src).reshape(-1, 2), axis=0)
                fit = np.array([[1, 0, d[0]], [0, 1, d[1]], [0, 0, 1]], np.float64)
            elif self.kind == "transform" and len(src) >= 3:
                fit = _similarity(src, dst)
            elif self.kind == "corner_pin" and len(src) >= 6:
                fit, _ = cv2.findHomography(src, dst, cv2.RANSAC, 2.0)
            if fit is not None:
                M_ref = fit
                conf = min(1.0, len(src) / max(8, 0.6 * self.ref_count))
        new_M = M_ref @ self.R  # original -> current
        if self.kind == "point" and self.tpl is not None and self.tpl.size:
            c = _apply(new_M, np.array([[self.box[:2]]], np.float32)).reshape(2)
            refined, score = _ncc_refine(img, self.tpl, c)
            if score > 0.6:
                new_M = new_M.copy()
                new_M[0, 2] += refined[0] - c[0]
                new_M[1, 2] += refined[1] - c[1]
                conf = max(conf, score)
        if self.kind in ("corner_pin", "transform"):
            new_M = self._ecc(img, new_M)
        self.prev_M, self.M = self.M, new_M
        if conf < 0.5 or len(self.ref_pts) < 8:
            # Appearance changed too much: this frame becomes the new reference.
            mask = np.zeros_like(img)
            region = self._region_now()
            cv2.fillConvexPoly(mask, region.astype(np.int32), 255)
            self._set_reference(img, mask, new_M)
        return new_M, conf

    def _region_now(self) -> np.ndarray:
        return _apply(self.M, self._region_orig().reshape(-1, 1, 2)).reshape(-1, 2)

    def _ecc(self, img: np.ndarray, M: np.ndarray) -> np.ndarray:
        """Refine by ECC alignment of the *original* pattern (Evangelidis &
        Psarakis 2008): drift-free even after the reference was refreshed."""
        homography = self.kind == "corner_pin"
        tpl, mask, off = self._pattern
        try:
            # The pattern is a crop of the original frame at ``off``: fold that in.
            shift = np.array([[1, 0, off[0]], [0, 1, off[1]], [0, 0, 1]], np.float64)
            start = M @ shift
            warp = (start if homography else start[:2]).astype(np.float32)
            crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 1e-5)
            motion = cv2.MOTION_HOMOGRAPHY if homography else cv2.MOTION_AFFINE
            if hasattr(cv2, "findTransformECCWithMask"):  # OpenCV >= 4.12: only the pattern's own pixels count
                cc, warp = cv2.findTransformECCWithMask(tpl, img, mask, None, warp, motion, crit, 5)
            else:
                cc, warp = cv2.findTransformECC(tpl, img, warp, motion, crit, None, 5)
            if cc < 0.75:  # didn't lock on: keep the feature-based answer
                return M
            full = warp.astype(np.float64) if homography else np.vstack([warp, [0, 0, 1]]).astype(np.float64)
            return full @ np.linalg.inv(shift)
        except cv2.error:
            return M

    def _region_orig(self) -> np.ndarray:
        if self.quad is not None:
            return self.quad
        cx, cy, bw, bh = self.box
        return np.array([[cx - bw / 2, cy - bh / 2], [cx + bw / 2, cy - bh / 2],
                         [cx + bw / 2, cy + bh / 2], [cx - bw / 2, cy + bh / 2]], np.float32)


def _track_region(frames: Iterator[np.ndarray], tracker: "_RegionTracker", n: int,
                  on_frame: Callable[[int], None]) -> list[tuple[np.ndarray, float]]:
    out = []
    for i, img in enumerate(frames):
        if i == 0:
            out.append((np.eye(3), 1.0))  # the reference frame itself
            continue
        out.append(tracker.step(img))
        on_frame(i)
    return out


def _stabilize_path(frames: Iterator[np.ndarray], on_frame: Callable[[int], None]) -> list[np.ndarray]:
    """Camera path: cumulative similarity of each frame relative to the first."""
    path = [np.eye(3)]
    prev = None
    prev_pts = None
    for i, img in enumerate(frames):
        if prev is None:
            prev = img
            continue
        H, W = img.shape
        if prev_pts is None or len(prev_pts) < 60:
            prev_pts = _features(prev, None, 400)
        nxt, ok = _flow(prev, img, prev_pts, fb_max=1.5)
        step = _similarity(prev_pts[ok], nxt[ok]) if ok.sum() >= 8 else None
        if step is None:
            step = np.eye(3)
        path.append(step @ path[-1])
        prev = img
        prev_pts = nxt[ok].reshape(-1, 1, 2) if ok.sum() >= 60 else None
        on_frame(i)
    return path


# --------------------------------------------------------------------------- job entry point


def run(project_id: str, asset: Asset, tracker: Tracker, on_progress: Callable[[float], None]) -> dict:
    """Track and store the result (normalised source coordinates, source time)."""
    k = key(asset, tracker)
    fps = asset.fps or 25.0
    w, h = _analysis_size(asset, tracker.quality)
    start = max(0.0, tracker.start if tracker.start is not None else 0.0)
    end = min(asset.duration, tracker.end if tracker.end is not None else asset.duration)
    ref = min(max(tracker.ref, start), max(start, end - 1 / fps))
    total = max(1, round((end - start) * fps))
    done = [0]

    def tick(_):
        done[0] += 1
        on_progress(min(0.99, done[0] / total))

    times: list[float] = []
    records: list = []
    if tracker.kind == "stabilize":
        path = _stabilize_path(_frames(project_id, asset, tracker.quality, start, end, fps), tick)
        for i, M in enumerate(path):
            a = math.atan2(M[1, 0], M[0, 0])
            s = math.hypot(M[0, 0], M[1, 0])
            # Similarity about the frame centre, translation normalised to the frame size.
            c = np.array([w / 2, h / 2, 1.0])
            moved = M @ c
            times.append(start + i / fps)
            records.append([round(float(moved[0] - c[0]) / w, 6), round(float(moved[1] - c[1]) / h, 6),
                            round(math.degrees(float(a)), 4), round(float(s), 6)])
        data = {"kind": "stabilize", "fps": fps, "times": times, "path": records, "size": [w, h]}
    else:
        if tracker.kind == "corner_pin":
            quad = np.array([[p[0] * w, p[1] * h] for p in tracker.quad], np.float32)
            xs, ys = quad[:, 0], quad[:, 1]
            box = ((xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2, xs.max() - xs.min(), ys.max() - ys.min())
        else:
            quad = None
            bx = tracker.box
            box = (bx[0] * w, bx[1] * h, max(8.0, bx[2] * w), max(8.0, bx[3] * h))
        ref_img = next(_frames(project_id, asset, tracker.quality, ref, ref + 1 / fps, fps), None)
        if ref_img is None:
            raise ValueError("Could not read the reference frame")

        def make():
            return _RegionTracker(tracker.kind, ref_img, box, quad)

        fwd = _track_region(_frames(project_id, asset, tracker.quality, ref, end, fps), make(),
                            total, tick)
        back = _track_region(_frames_backward(project_id, asset, tracker.quality, start, ref + 1 / fps, fps),
                             make(), total, tick)
        seq = [(ref - i / fps, m, c) for i, (m, c) in enumerate(back)][1:][::-1]  # skip the shared ref frame
        seq += [(ref + i / fps, m, c) for i, (m, c) in enumerate(fwd)]
        for t, M, conf in seq:
            times.append(round(t, 6))
            if tracker.kind == "corner_pin":
                q = _apply(M, quad.reshape(-1, 1, 2)).reshape(-1, 2)
                records.append([round(float(v), 6) for p in q for v in (p[0] / w, p[1] / h)] + [round(float(conf), 3)])
            else:
                c = _apply(M, np.array([[box[:2]]], np.float32)).reshape(2)
                a = math.degrees(math.atan2(M[1, 0], M[0, 0]))
                s = math.hypot(M[0, 0], M[1, 0])
                records.append([round(float(c[0]) / w, 6), round(float(c[1]) / h, 6), round(float(a), 4),
                                round(float(s), 6), round(float(conf), 3)])
        data = {"kind": tracker.kind, "fps": fps, "times": times, "samples": records, "ref": ref, "size": [w, h]}
    _save(project_id, k, data)
    with _cache_lock:
        _cache[f"{project_id}/{k}"] = data
    on_progress(1.0)
    return data


# --------------------------------------------------------------------------- sampling


def sample(data: dict, t: float) -> list[float]:
    """Linearly interpolated record at source time ``t`` (clamped to the tracked range)."""
    times = data["times"]
    rows = data["path"] if data["kind"] == "stabilize" else data["samples"]
    if not times:
        return []
    if t <= times[0]:
        return list(rows[0])
    if t >= times[-1]:
        return list(rows[-1])
    fps = data["fps"]
    i = min(len(times) - 2, max(0, int((t - times[0]) * fps)))
    while i > 0 and times[i] > t:
        i -= 1
    while i < len(times) - 2 and times[i + 1] < t:
        i += 1
    f = (t - times[i]) / max(1e-9, times[i + 1] - times[i])
    return [a + (b - a) * f for a, b in zip(rows[i], rows[i + 1])]


def smooth_path(data: dict, seconds: float, lock: bool) -> list[list[float]]:
    """Per-frame correction (dx, dy, deg, scale) that moves each frame from the
    shaky camera path to a smooth (Gaussian, ``seconds`` wide) or locked one."""
    p = np.array(data["path"], np.float64)
    if len(p) == 0:
        return []
    if lock:
        target = np.tile(np.array([0.0, 0.0, 0.0, 1.0]), (len(p), 1))
    else:
        sigma = max(0.5, seconds * data["fps"] / 2)
        r = int(3 * sigma)
        k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
        k /= k.sum()
        padded = np.pad(p, ((r, r), (0, 0)), mode="edge")
        target = np.stack([np.convolve(padded[:, c], k, mode="valid") for c in range(4)], 1)
    corr = np.empty_like(p)
    corr[:, :2] = target[:, :2] - p[:, :2]
    corr[:, 2] = target[:, 2] - p[:, 2]
    corr[:, 3] = target[:, 3] / p[:, 3]
    return corr.tolist()
