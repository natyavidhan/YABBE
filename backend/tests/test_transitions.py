"""Transitions: catalogue, previews, and rendered frames around a cut."""

from __future__ import annotations

import io
import subprocess

import pytest
from PIL import Image

from conftest import _upload, _wait_job, _wait_ready


def _px(client, pid, t, xy=(320, 180)):
    r = client.post(f"/api/projects/{pid}/frame", json={"t": t, "height": 360})
    assert r.status_code == 200, r.text
    return Image.open(io.BytesIO(r.content)).convert("RGB").getpixel(xy)


@pytest.fixture(scope="module")
def two_colours(client, tmp_path_factory):
    d = tmp_path_factory.mktemp("tr")
    red, blue = d / "red.png", d / "blue.png"
    Image.new("RGB", (640, 360), (220, 30, 30)).save(red)
    Image.new("RGB", (640, 360), (30, 30, 220)).save(blue)
    vid = d / "short.mp4"  # 2 s of footage, for edge-hold behaviour
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1edc1e:s=640x360:r=25:d=2",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(vid)], check=True)
    pid = client.post("/api/projects", json={"name": "tr", "width": 640, "height": 360, "fps": 25}).json()["id"]
    a = _upload(client, pid, red)
    b = _upload(client, pid, blue)
    v = _upload(client, pid, vid)
    project = _wait_ready(client, pid)
    return pid, project["tracks"][1]["id"], a["id"], b["id"], v["id"]


def _set(client, pid, clips):
    r = client.put(f"/api/projects/{pid}", json={"clips": clips})
    assert r.status_code == 200, r.text


def test_catalogue(client):
    data = client.get("/api/transitions").json()
    ids = {t["id"] for t in data["transitions"]}
    assert len(ids) >= 70 and {"mix", "pull_in", "spin", "wipe_left", "circle_open", "glitch"} <= ids
    assert set(data["categories"]) >= {t["category"] for t in data["transitions"]}


def test_preview_webp(client):
    r = client.get("/api/transitions/spin/preview.webp")
    assert r.status_code == 200 and r.content[:4] == b"RIFF" and b"WEBP" in r.content[:16]
    assert client.get("/api/transitions/nope/preview.webp").status_code == 404


def test_mix_blends_around_the_cut(client, two_colours):
    pid, track, a, b, _ = two_colours
    _set(client, pid, [
        {"track_id": track, "type": "image", "asset_id": a, "start": 0, "duration": 2,
         "transition": {"kind": "mix", "duration": 1}},
        {"track_id": track, "type": "image", "asset_id": b, "start": 2, "duration": 2},
    ])
    before, mid, after = _px(client, pid, 1.4), _px(client, pid, 2.0), _px(client, pid, 2.6)
    assert before[0] > 180 and before[2] < 70  # still red before the window
    assert 90 < mid[0] < 160 and 90 < mid[2] < 160  # half-way blend
    assert after[2] > 180 and after[0] < 70  # blue after


def test_wipe_splits_frame(client, two_colours):
    pid, track, a, b, _ = two_colours
    _set(client, pid, [
        {"track_id": track, "type": "image", "asset_id": a, "start": 0, "duration": 2,
         "transition": {"kind": "wipe_left", "duration": 1}},
        {"track_id": track, "type": "image", "asset_id": b, "start": 2, "duration": 2},
    ])
    left, right = _px(client, pid, 2.0, (40, 180)), _px(client, pid, 2.0, (600, 180))
    assert {left[0] > 150, right[0] > 150} == {True, False}  # one side red, the other blue


def test_gap_means_no_transition(client, two_colours):
    pid, track, a, b, _ = two_colours
    _set(client, pid, [
        {"track_id": track, "type": "image", "asset_id": a, "start": 0, "duration": 2,
         "transition": {"kind": "mix", "duration": 1}},
        {"track_id": track, "type": "image", "asset_id": b, "start": 2.5, "duration": 2},
    ])
    assert _px(client, pid, 1.9)[0] > 180  # A untouched up to its end


@pytest.mark.parametrize("kind", ["pull_in", "spin", "glitch", "swipe_left", "flash", "circle_open", "morph"])
def test_export_with_transition(client, two_colours, tmp_path, kind):
    """Video clip running out of footage (edge frames held) + transition, exported."""
    pid, track, a, _, v = two_colours
    _set(client, pid, [
        {"track_id": track, "type": "video", "asset_id": v, "start": 0, "duration": 2,
         "transition": {"kind": kind, "duration": 0.8}},
        {"track_id": track, "type": "image", "asset_id": a, "start": 2, "duration": 1.5},
    ])
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low", "height": 360})
    job = _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    mp4 = tmp_path / "t.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(mp4)], capture_output=True, text=True).stdout)
    assert abs(dur - 3.5) < 0.15
    # HLS segment across the cut renders too
    s = client.post(f"/api/projects/{pid}/preview", json={"height": 360}).json()
    assert client.get(f"/api/preview/{s['key']}/seg_0.ts").status_code == 200
    assert client.get(f"/api/preview/{s['key']}/seg_1.ts").status_code == 200
