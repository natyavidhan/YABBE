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


def test_freeze_frame_as_image(client, media_dir):
    """The editor's freeze frame: a still saved as a hidden image asset."""
    pid = client.post("/api/projects", json={"name": "freeze-img", "width": 320, "height": 180, "fps": 25}).json()["id"]
    vid = _upload(client, pid, media_dir / "clip.mp4")
    main = main_seq(_wait_ready(client, pid))
    r = client.post(f"/api/projects/{pid}/media/freeze", json={"asset_id": vid["id"], "t": 1.0})
    assert r.status_code == 200, r.text
    still = r.json()
    assert still["kind"] == "image" and still["hidden"] and still["width"] == 640
    project = _wait_ready(client, pid)
    assert next(a for a in project["assets"] if a["id"] == still["id"])["status"] == "ready"
    v = main["tracks"][1]["id"]
    img = _frame(client, pid, main, [{"track_id": v, "type": "image", "asset_id": still["id"], "start": 0, "duration": 2}], 1.5)
    source = _frame(client, pid, main, [{"track_id": v, "type": "video", "asset_id": vid["id"], "start": 0,
                                         "duration": 2, "in_point": 1.0}], 0.0)
    assert np.abs(img - source).mean() < 6  # the same picture as the video at 1.0 s
    assert client.post(f"/api/projects/{pid}/media/freeze", json={"asset_id": still["id"], "t": 0}).status_code == 400


def test_shape_keyframes(client):
    """Shape properties animate: fill colour and width (previews and exports)."""
    import subprocess
    from conftest import _wait_job
    from app import storage

    pid = client.post("/api/projects", json={"name": "shape-kf", "width": 320, "height": 180, "fps": 25}).json()["id"]
    main = main_seq(client.get(f"/api/projects/{pid}").json())
    v = main["tracks"][1]["id"]
    clip = {"track_id": v, "type": "shape", "start": 0, "duration": 2,
            "shape": {"kind": "rectangle", "width": 100, "height": 60, "fill": "#ff0000"},
            "keyframes": {"shape_fill": [{"t": 0, "c": "#ff0000", "ease": "linear"}, {"t": 2, "c": "#0000ff", "ease": "linear"}],
                          "shape_width": [{"t": 0, "v": 100, "ease": "linear"}, {"t": 2, "v": 300, "ease": "linear"}]}}

    def width(im):
        row = np.abs(im[90] - im[90, 0]).max(-1) > 60
        return int(row.sum())

    a, b = _frame(client, pid, main, [clip], 0.0), _frame(client, pid, main, [clip], 1.96)
    _near(a[90, 160], (255, 0, 0))
    _near(b[90, 160], (0, 0, 255), 50)
    assert abs(width(a) - 100) < 6 and abs(width(b) - 296) < 8, (width(a), width(b))

    main["clips"] = [clip]
    client.put(f"/api/projects/{pid}", json={"sequences": [main]})
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    _wait_job(client, r.json()["job"]["id"])
    path = storage.exports_dir(pid) / r.json()["export"]["filename"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", "1.0", "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    mid = np.frombuffer(raw, np.uint8).reshape(180, 320, 3).astype(int)
    _near(mid[90, 160], (128, 0, 128), 45)  # halfway: purple
    assert abs(width(mid) - 200) < 10, width(mid)


def test_effect_switches(client):
    """Effects keep their settings while switched off: a disabled crop doesn't crop."""
    pid = client.post("/api/projects", json={"name": "fx", "width": 320, "height": 180, "fps": 25}).json()["id"]
    main = main_seq(client.get(f"/api/projects/{pid}").json())
    v = main["tracks"][1]["id"]
    clip = {"track_id": v, "type": "shape", "start": 0, "duration": 2, "effects": ["crop"],
            "shape": {"kind": "rectangle", "width": 200, "height": 100, "fill": "#ff0000"},
            "crop": {"left": 0.5}}
    on = _frame(client, pid, main, [clip])
    off = _frame(client, pid, main, [{**clip, "crop": {"left": 0.5, "enabled": False}}])
    assert (np.abs(on - (255, 0, 0)).max(-1) < 60).sum() < 0.6 * (np.abs(off - (255, 0, 0)).max(-1) < 60).sum()
    main["clips"] = [clip]
    saved = main_seq(client.put(f"/api/projects/{pid}", json={"sequences": [main]}).json())
    assert saved["clips"][0]["effects"] == ["crop"]
