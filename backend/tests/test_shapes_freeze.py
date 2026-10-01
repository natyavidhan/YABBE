"""Shape clips and freeze frames."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from conftest import _upload, _wait_ready, main_seq


def _frame(client, pid, main, clips, t=0.5, h=180):
    r = client.post(f"/api/projects/{pid}/frame",
                    json={"t": t, "height": h, "timeline": {"sequence_id": main["id"], "clips": clips}})
    assert r.status_code == 200, r.text
    return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype(int)


def _near(px, want, tol=40):
    assert all(abs(a - b) <= tol for a, b in zip(px, want)), (px, want)


def test_shapes(client):
    pid = client.post("/api/projects", json={"name": "shapes", "width": 320, "height": 180, "fps": 25}).json()["id"]
    main = main_seq(client.get(f"/api/projects/{pid}").json())
    v = main["tracks"][1]["id"]

    def shape(**s):
        return {"track_id": v, "type": "shape", "start": 0, "duration": 2, "shape": s}

    im = _frame(client, pid, main, [shape(kind="rectangle", width=200, height=100, fill="#ff0000")])
    _near(im[90, 160], (255, 0, 0))
    _near(im[90, 70], (255, 0, 0))   # inside, near the left edge (x 60..260)
    _near(im[90, 40], (0, 0, 0))     # outside
    _near(im[20, 160], (0, 0, 0))

    im = _frame(client, pid, main, [shape(kind="ellipse", width=100, height=100, fill="#00ff00")])
    _near(im[90, 160], (0, 255, 0))
    _near(im[45, 115], (0, 0, 0))    # the box corner is outside the circle

    # Outline only, no fill: the middle stays empty.
    im = _frame(client, pid, main, [shape(kind="rectangle", width=120, height=120, fill=None,
                                          stroke="#ffffff", stroke_width=10)])
    _near(im[90, 160], (0, 0, 0))
    _near(im[90, 103], (255, 255, 255))

    # Transform applies: half scale and moved right.
    c = shape(kind="rectangle", width=100, height=100, fill="#0000ff")
    c["transform"] = {"x": 100, "scale": 0.5}
    im = _frame(client, pid, main, [c])
    _near(im[90, 260], (0, 0, 255))
    _near(im[90, 160], (0, 0, 0))

    for kind in ("triangle", "polygon", "star", "line", "arrow"):
        im = _frame(client, pid, main, [shape(kind=kind, width=160, height=120, fill="#ffff00", stroke="#ff00ff",
                                              stroke_width=6)])
        assert (np.abs(im - (255, 255, 0)).max(-1) < 60).any() or (np.abs(im - (255, 0, 255)).max(-1) < 60).any(), kind

    # Shapes survive saving (no media needed).
    main["clips"] = [shape(kind="star")]
    saved = client.put(f"/api/projects/{pid}", json={"sequences": [main]}).json()
    assert main_seq(saved)["clips"][0]["shape"]["kind"] == "star"


def test_freeze_frame(client, media_dir):
    pid = client.post("/api/projects", json={"name": "freeze", "width": 320, "height": 180, "fps": 25}).json()["id"]
    vid = _upload(client, pid, media_dir / "clip.mp4")  # testsrc2: changes every frame
    main = main_seq(_wait_ready(client, pid))
    v = main["tracks"][1]["id"]
    still = {"track_id": v, "type": "video", "asset_id": vid["id"], "start": 0, "duration": 2, "in_point": 1.0, "hold": True}
    a, b = _frame(client, pid, main, [still], 0.2), _frame(client, pid, main, [still], 1.7)
    assert np.abs(a - b).mean() < 2  # frozen
    source = _frame(client, pid, main, [{**still, "hold": False}], 0.0)  # the source frame at 1.0 s
    assert np.abs(a - source).mean() < 6
    moving = _frame(client, pid, main, [{**still, "hold": False}], 1.7)
    assert np.abs(moving - source).mean() > 6  # (the video itself does move)
