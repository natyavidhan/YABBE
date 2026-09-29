"""Motion tracking end to end: analyse through the API, apply, render."""

from __future__ import annotations

import io
import math
import subprocess
import time

import cv2
import numpy as np
import pytest
from PIL import Image

from conftest import _upload, _wait_ready, main_seq

W, H, FPS, N = 320, 180, 25, 50
RED = (230, 20, 20)


def _texture(seed=0):
    rng = np.random.default_rng(seed)
    t = cv2.resize((rng.random((60, 110, 3)) * 255).astype(np.uint8), (1100, 600), interpolation=cv2.INTER_CUBIC)
    return cv2.GaussianBlur(t, (0, 0), 1.2)


def _encode(frames, path):
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                          "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    p.wait()


def _moving_scene(path):
    """Scene panning in a curve; returns where scene point (550, 300) is per frame."""
    tex = _texture(1)
    pos = []
    frames = []
    for i in range(N):
        ox, oy = 390 + 60 * math.sin(i / 12), 210 + 30 * math.cos(i / 9)
        frames.append(tex[int(oy):int(oy) + H, int(ox):int(ox) + W])
        pos.append((550 - int(ox), 300 - int(oy)))
    _encode(frames, path)
    return pos


def _shaky_scene(path):
    tex = _texture(2)
    rng = np.random.default_rng(5)
    frames = []
    for i in range(N):
        dx, dy = rng.integers(-8, 9), rng.integers(-8, 9)
        frames.append(tex[300 + dy:300 + dy + H, 400 + dx:400 + dx + W])
    _encode(frames, path)


def _poster_scene(path):
    """A textured poster moving and tilting over a darker scene; returns its quads."""
    tex = _texture(3)
    poster = _texture(4)[:200, :300]
    quads, frames = [], []
    for i in range(N):
        u = i / (N - 1)
        q = np.float32([[80 + 30 * u, 40 + 5 * u], [230 + 20 * u, 50 - 10 * u], [220 + 25 * u, 140 + 5 * u], [90 + 20 * u, 150]])
        Hm = cv2.getPerspectiveTransform(np.float32([[0, 0], [300, 0], [300, 200], [0, 200]]), q)
        bg = (tex[100:100 + H, 100:100 + W] * 0.35).astype(np.uint8)
        warped = cv2.warpPerspective(poster, Hm, (W, H))
        mask = cv2.warpPerspective(np.ones((200, 300), np.uint8), Hm, (W, H))[..., None]
        frames.append(np.where(mask > 0, warped, bg))
        quads.append(q)
    _encode(frames, path)
    return quads


@pytest.fixture(scope="module")
def scenes(client, tmp_path_factory):
    d = tmp_path_factory.mktemp("track")
    truth_move = _moving_scene(d / "move.mp4")
    _shaky_scene(d / "shaky.mp4")
    quads = _poster_scene(d / "poster.mp4")
    Image.new("RGB", (160, 90), RED).save(d / "red.png")
    pid = client.post("/api/projects", json={"name": "track", "width": W, "height": H, "fps": FPS}).json()["id"]
    ids = {n: _upload(client, pid, d / f"{n}")["id"] for n in ("move.mp4", "shaky.mp4", "poster.mp4", "red.png")}
    main = main_seq(_wait_ready(client, pid))
    return pid, main, ids, truth_move, quads


def _track(client, pid, asset_id, tracker):
    r = client.post(f"/api/projects/{pid}/tracking/run", json={"asset_id": asset_id, "tracker": tracker})
    assert r.status_code == 200, r.text
    for _ in range(300):
        st = client.post(f"/api/projects/{pid}/tracking/status", json=[{"asset_id": asset_id, "tracker": tracker}]).json()[0]
        if st["state"] in ("done", "error"):
            assert st["state"] == "done", st
            return st
        time.sleep(0.1)
    raise AssertionError("tracking timed out")


def _frame(client, pid, main, clips, t):
    r = client.post(f"/api/projects/{pid}/frame",
                    json={"t": t, "height": H, "timeline": {"sequence_id": main["id"], "clips": clips}})
    assert r.status_code == 200, r.text
    return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype(int)


def _red_centre(im):
    m = (im[..., 0] > 170) & (im[..., 1] < 90) & (im[..., 2] < 90)
    ys, xs = np.nonzero(m)
    return (xs.mean(), ys.mean()) if len(xs) > 20 else None


def test_follow_point(client, scenes):
    pid, main, ids, truth, _ = scenes
    x0, y0 = truth[0]
    tracker = {"id": "k1", "kind": "point", "ref": 0, "box": [x0 / W, y0 / H, 24 / W, 24 / H], "quality": "precise"}
    st = _track(client, pid, ids["move.mp4"], tracker)
    again = client.post(f"/api/projects/{pid}/tracking/run", json={"asset_id": ids["move.mp4"], "tracker": tracker}).json()
    assert again["state"] == "done" and again["key"] == st["key"]  # cached: never analysed twice

    data = client.get(f"/api/projects/{pid}/tracking/result/{st['key']}").json()
    errs = [math.hypot(r[0] * W - truth[i][0], r[1] * H - truth[i][1]) for i, r in enumerate(data["samples"])]
    assert np.mean(errs) < 1.0 and max(errs) < 3, (np.mean(errs), max(errs))

    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]
    video = {"id": "src", "track_id": v1, "type": "video", "asset_id": ids["move.mp4"], "start": 0, "duration": 2,
             "trackers": [tracker]}
    # A small red card placed on the feature at the reference frame, following it.
    card = {"track_id": v2, "type": "image", "asset_id": ids["red.png"], "start": 0, "duration": 2,
            "transform": {"x": x0 - W / 2, "y": y0 - H / 2, "scale": 0.12},
            "follow": {"clip_id": "src", "tracker_id": "k1"}}
    for t in (0.0, 0.8, 1.6):
        with_card = _frame(client, pid, main, [video, card], t)
        without = _frame(client, pid, main, [video], t)
        changed = np.abs(with_card - without).sum(-1) > 60  # the texture has reds of its own
        ys, xs = np.nonzero(changed)
        c = (xs.mean(), ys.mean()) if len(xs) > 20 else None
        want = truth[round(t * FPS)]
        assert c and math.hypot(c[0] - want[0], c[1] - want[1]) < 3, (t, c, want)


def test_stabilize_lock(client, scenes):
    pid, main, ids, _, _ = scenes
    tracker = {"id": "k2", "kind": "stabilize", "quality": "precise"}
    _track(client, pid, ids["shaky.mp4"], tracker)
    v1 = main["tracks"][1]["id"]
    base = {"id": "shake", "track_id": v1, "type": "video", "asset_id": ids["shaky.mp4"], "start": 0, "duration": 2,
            "trackers": [tracker]}

    def spread(clip):
        ims = [_frame(client, pid, main, [clip], t) for t in (0.0, 0.4, 0.8, 1.2, 1.6)]
        centre = [im[60:120, 110:210].astype(float) for im in ims]
        return np.mean([np.abs(c - centre[0]).mean() for c in centre[1:]])

    shaky = spread(base)
    steady = spread({**base, "stabilize": {"tracker_id": "k2", "mode": "lock", "auto_zoom": True}})
    assert steady < shaky / 3, (shaky, steady)


def test_corner_pin(client, scenes):
    pid, main, ids, _, quads = scenes
    q0 = quads[0]
    tracker = {"id": "k3", "kind": "corner_pin", "ref": 0, "quality": "precise",
               "quad": [[float(x) / W, float(y) / H] for x, y in q0]}
    _track(client, pid, ids["poster.mp4"], tracker)
    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]
    video = {"id": "pv", "track_id": v1, "type": "video", "asset_id": ids["poster.mp4"], "start": 0, "duration": 2,
             "trackers": [tracker]}
    card = {"track_id": v2, "type": "image", "asset_id": ids["red.png"], "start": 0, "duration": 2,
            "pin": {"clip_id": "pv", "tracker_id": "k3"}}
    for t in (0.0, 1.0, 1.9):
        im = _frame(client, pid, main, [video, card], t)
        q = quads[min(N - 1, round(t * FPS))]
        c = _red_centre(im)
        want = q.mean(0)
        assert c and math.hypot(c[0] - want[0], c[1] - want[1]) < 3, (t, c, want)
        red = (im[..., 0] > 170) & (im[..., 1] < 90)
        inside = np.zeros((H, W), np.uint8)
        cv2.fillConvexPoly(inside, q.astype(np.int32), 1)
        assert red[inside == 0].mean() < 0.01  # nothing painted outside the surface
        assert red[inside == 1].mean() > 0.9  # and the surface is covered
