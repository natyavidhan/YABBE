"""Roto brush end to end: select an object on one frame, follow it, cut it out."""

from __future__ import annotations

import io
import math
import subprocess
import time

import cv2
import numpy as np
import pytest
from PIL import Image

from app.engine import roto as roto_engine
from conftest import _upload, _wait_ready, main_seq

pytestmark = pytest.mark.skipif(not roto_engine.available(), reason="roto brush model not installed")

W, H, FPS, N = 320, 180, 25, 25
BLUE = (30, 30, 220)


def _ball_clip(path):
    """A striped ball rolling over a busy background; returns its centre per frame."""
    rng = np.random.default_rng(7)
    bg = cv2.GaussianBlur(cv2.resize((rng.random((40, 70, 3)) * 255).astype(np.uint8), (W + 200, H),
                                     interpolation=cv2.INTER_CUBIC), (0, 0), 2)
    centres, frames = [], []
    for i in range(N):
        f = bg[:, i * 4:i * 4 + W].copy()
        cx, cy = int(70 + i * 7), int(90 + 25 * math.sin(i / 5))
        cv2.circle(f, (cx, cy), 32, (250, 200, 40), -1)
        for s in range(-30, 31, 12):  # stripes so it has texture
            cv2.line(f, (cx - 30, cy + s), (cx + 30, cy + s), (200, 40, 40), 3)
        cv2.circle(f, (cx, cy), 32, (250, 200, 40), 2)
        frames.append(f)
        centres.append((cx, cy))
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                          "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", str(path)],
                         stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    p.wait()
    return centres


def _truth(c):
    m = np.zeros((H, W), bool)
    cv2.circle(m.view(np.uint8), c, 33, 1, -1)
    return m.astype(bool)


def test_roto_brush(client, tmp_path):
    centres = _ball_clip(tmp_path / "ball.mp4")
    Image.new("RGB", (W, H), BLUE).save(tmp_path / "blue.png")
    pid = client.post("/api/projects", json={"name": "roto", "width": W, "height": H, "fps": FPS}).json()["id"]
    ball = _upload(client, pid, tmp_path / "ball.mp4")
    blue = _upload(client, pid, tmp_path / "blue.png")
    main = main_seq(_wait_ready(client, pid))
    assert client.get("/api/roto/info").json()["available"]

    cx, cy = centres[0]
    prompt = {"t": 0, "box": [(cx - 36) / W, (cy - 36) / H, (cx + 36) / W, (cy + 36) / H]}
    # instant preview on the prompted frame
    r = client.post(f"/api/projects/{pid}/roto/preview", json={"asset_id": ball["id"], "prompt": prompt})
    assert r.status_code == 200, r.text
    pm = cv2.resize(cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_GRAYSCALE), (W, H)) > 127
    t = _truth(centres[0])
    assert (pm & t).sum() / (pm | t).sum() > 0.85

    roto = {"prompts": [prompt]}
    item = {"clip_id": "c", "asset_id": ball["id"], "roto": roto}
    assert client.post(f"/api/projects/{pid}/roto/run", json=item).status_code == 200
    for _ in range(600):
        st = client.post(f"/api/projects/{pid}/roto/status", json=[item]).json()[0]
        if st["state"] in ("done", "error"):
            break
        time.sleep(0.2)
    assert st["state"] == "done", st

    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]

    def frame(t, **roto_extra):
        clips = [{"track_id": v1, "type": "image", "asset_id": blue["id"], "start": 0, "duration": 1},
                 {"id": "c", "track_id": v2, "type": "video", "asset_id": ball["id"], "start": 0, "duration": 1,
                  "roto": {**roto, **roto_extra}}]
        r = client.post(f"/api/projects/{pid}/frame",
                        json={"t": t, "height": H, "timeline": {"sequence_id": main["id"], "clips": clips}})
        assert r.status_code == 200, r.text
        assert len(r.content) > 100, ("empty frame", roto_extra, len(r.content))
        return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype(int)

    for t in (0.0, 0.48, 0.92):
        c = centres[round(t * FPS)]
        truth = _truth(c)
        matte = frame(t, matte=True)[..., 0] > 127
        iou = (matte & truth).sum() / (matte | truth).sum()
        assert iou > 0.85, (t, iou)
        im = frame(t)
        assert abs(im[c[1], c[0]] - np.array([250, 200, 40])).max() < 70  # the ball stays
        far = ~cv2.dilate(truth.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
        blueish = (np.abs(im - np.array(BLUE)).max(-1) < 40)
        assert blueish[far].mean() > 0.95, (t, blueish[far].mean())  # everything else is cut away
        inv = frame(t, invert=True)
        assert abs(inv[c[1], c[0]] - np.array(BLUE)).max() < 40  # inverted: the ball is removed

    # The export (a video render, not a single frame) cuts it out too.
    from conftest import _wait_job
    from app import storage
    seq = {**main, "clips": [
        {"track_id": v1, "type": "image", "asset_id": blue["id"], "start": 0, "duration": 1},
        {"id": "c", "track_id": v2, "type": "video", "asset_id": ball["id"], "start": 0, "duration": 1, "roto": roto}]}
    assert client.put(f"/api/projects/{pid}", json={"sequences": [seq]}).status_code == 200
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    _wait_job(client, r.json()["job"]["id"])
    path = storage.exports_dir(pid) / r.json()["export"]["filename"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", "0.6", "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    im = np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(int)
    c = centres[15]
    assert abs(im[c[1], c[0]] - np.array([250, 200, 40])).max() < 70
    assert abs(im[10, W - 10] - np.array(BLUE)).max() < 40
