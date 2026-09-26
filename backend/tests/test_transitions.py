"""Transitions: catalogue, previews, and rendered frames around a cut."""

from __future__ import annotations

import io
from pathlib import Path
import subprocess

import pytest
from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


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
    return pid, main_seq(project)["tracks"][1]["id"], a["id"], b["id"], v["id"]


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
    r = client.get("/api/transitions/spin/poster.jpg")
    assert r.status_code == 200 and r.content[:3] == b"\xff\xd8\xff"
    assert Image.open(io.BytesIO(r.content)).size == (320, 180)


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


def test_audio_crossfade(client, tmp_path):
    """Two tones across a transition: both audible (crossfaded) inside the
    window; with audio off, a hard cut at the cut."""
    low, high = tmp_path / "low.mp4", tmp_path / "high.mp4"
    for f, hz in ((low, 300), (high, 2000)):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25:d=6",
                        "-f", "lavfi", "-i", f"sine=f={hz}:d=6", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", str(f)], check=True)
    pid = client.post("/api/projects", json={"name": "xfade", "width": 320, "height": 180, "fps": 25}).json()["id"]
    lo, hi = _upload(client, pid, low), _upload(client, pid, high)
    project = _wait_ready(client, pid)
    track = main_seq(project)["tracks"][1]["id"]

    def export(audio: bool) -> Path:
        client.put(f"/api/projects/{pid}", json={"clips": [
            {"track_id": track, "type": "video", "asset_id": lo["id"], "start": 0, "duration": 2, "in_point": 1,
             "transition": {"kind": "mix", "duration": 1.0, "audio": audio}},
            {"track_id": track, "type": "video", "asset_id": hi["id"], "start": 2, "duration": 2, "in_point": 1},
        ]})
        r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low"})
        assert _wait_job(client, r.json()["job"]["id"])["status"] == "done"
        out = tmp_path / f"x{audio}.wav"
        mp4 = tmp_path / f"x{audio}.mp4"
        mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-ac", "1", "-ar", "8000", str(out)], check=True)
        return out

    def band_levels(wav: Path, t: float):
        """Energy of the 300 Hz and 2 kHz tones in a 0.1 s slice at t."""
        import math, wave, struct
        w = wave.open(str(wav))
        rate = w.getframerate()
        w.setpos(int(t * rate))
        n = int(0.1 * rate)
        xs = struct.unpack(f"<{n}h", w.readframes(n))
        def mag(f):
            re = sum(x * math.cos(2 * math.pi * f * i / rate) for i, x in enumerate(xs))
            im = sum(x * math.sin(2 * math.pi * f * i / rate) for i, x in enumerate(xs))
            return math.hypot(re, im) / n
        return mag(300), mag(2000)

    from pathlib import Path  # noqa: F811
    on = export(True)
    lo_before, hi_before = band_levels(on, 1.2)
    lo_mid, hi_mid = band_levels(on, 1.95)
    lo_after, hi_after = band_levels(on, 2.8)
    assert lo_before > 10 * max(hi_before, 1) and hi_after > 10 * max(lo_after, 1)
    assert lo_mid > 0.3 * lo_before and hi_mid > 0.3 * hi_after  # both audible mid-crossfade
    off = export(False)
    lo_mid2, hi_mid2 = band_levels(off, 1.8)
    assert hi_mid2 < 0.1 * max(lo_mid2, 1)  # hard cut: B not heard before the cut
