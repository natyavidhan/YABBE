"""Keyframes: interpolation maths and per-frame rendering vs single frames."""

from __future__ import annotations

import io
import subprocess

import pytest
from PIL import Image

from app.engine import keyframes
from app.models import Clip, Keyframe

from conftest import _upload, _wait_job, _wait_ready


def K(t, v, ease="linear"):
    return Keyframe(t=t, v=v, ease=ease)


@pytest.mark.parametrize("ease", ["linear", "ease_in", "ease_out", "ease_in_out", "hold"])
def test_expression_matches_python(ease):
    frames = [K(0.5, 10, ease), K(1.5, 110, "linear"), K(3, -50)]
    expr = keyframes.expr(frames, "(t)")
    for u in [0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.2, 3, 4]:
        # Evaluate the FFmpeg expression with FFmpeg itself (aevalsrc at time u).
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"aevalsrc='{expr}':s=8000:d={u + 0.01}",
             "-f", "f64le", "-"], capture_output=True, check=True).stdout
        import struct
        samples = struct.unpack(f"<{len(out) // 8}d", out)
        ff = samples[int(round(u * 8000))] if int(round(u * 8000)) < len(samples) else samples[-1]
        assert ff == pytest.approx(keyframes.value_at(frames, u), abs=1e-3), (ease, u)


def test_ease_shapes():
    assert keyframes.ease("linear", 0.25) == pytest.approx(0.25)
    assert keyframes.ease("ease_in", 0.5) < 0.5 < keyframes.ease("ease_out", 0.5)
    assert keyframes.ease("ease_in_out", 0.5) == pytest.approx(0.5)
    assert keyframes.ease("hold", 0.99) == 0


def test_clip_keyframes_are_sorted_deduped_and_clamped():
    c = Clip(track_id="t", type="image", keyframes={
        "opacity": [K(2, 5), K(1, 0.5), K(1, 0.25)], "scale": []})
    assert [(k.t, k.v) for k in c.keyframes["opacity"]] == [(1, 0.25), (2, 1)]
    assert "scale" not in c.keyframes


def _red_centroid(img: Image.Image):
    px = img.convert("RGB").load()
    xs = ys = n = 0
    for y in range(0, img.height, 2):
        for x in range(0, img.width, 2):
            r, g, b = px[x, y]
            if r > 50 and r > 2.5 * g and r > 2.5 * b:
                xs += x; ys += y; n += 1
    return (xs / n, ys / n, n) if n else (None, None, 0)


def test_animated_render_matches_single_frames(client, tmp_path):
    photo = tmp_path / "red.png"
    Image.new("RGB", (400, 400), (230, 20, 20)).save(photo)
    tone = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", str(tone)], check=True)
    pid = client.post("/api/projects", json={"name": "kf", "width": 640, "height": 360, "fps": 25}).json()["id"]
    img = _upload(client, pid, photo)
    snd = _upload(client, pid, tone)
    project = _wait_ready(client, pid)
    vt, at = project["tracks"][1]["id"], project["tracks"][2]["id"]
    clips = [
        {"track_id": vt, "type": "image", "asset_id": img["id"], "start": 0, "duration": 3,
         "transform": {"scale": 0.3},
         "keyframes": {
             "x": [{"t": 0, "v": -200}, {"t": 2, "v": 200, "ease": "linear"}],
             "scale": [{"t": 0, "v": 0.2}, {"t": 2, "v": 0.5}],
             "rotation": [{"t": 0, "v": 0}, {"t": 2, "v": 90}],
             "opacity": [{"t": 1, "v": 1}, {"t": 2.5, "v": 0.2}],
         }},
        {"track_id": at, "type": "audio", "asset_id": snd["id"], "start": 0, "duration": 3,
         "keyframes": {"volume": [{"t": 0, "v": 0}, {"t": 1, "v": 0}, {"t": 1.01, "v": 1}]}},
    ]
    r = client.put(f"/api/projects/{pid}", json={"clips": clips})
    assert r.status_code == 200, r.text

    # Single frames (Python interpolation path)
    singles = {}
    for t in (0.0, 1.0, 2.0):
        r = client.post(f"/api/projects/{pid}/frame", json={"t": t, "height": 360})
        singles[t] = Image.open(io.BytesIO(r.content))
    cx0, _, n0 = _red_centroid(singles[0.0])
    cx1, _, n1 = _red_centroid(singles[1.0])
    cx2, _, n2 = _red_centroid(singles[2.0])
    assert cx0 < cx1 < cx2 and abs(cx1 - 320) < 6  # x: -200 -> 0 -> +200
    assert n0 < n1 < n2  # growing

    # Export (FFmpeg expression path) and compare the same instants
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    job = _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    ex = r.json()["export"]
    mp4 = tmp_path / "out.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{ex['id']}/download").content)
    for t, single in singles.items():
        png = tmp_path / f"f{t}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1", str(png)], check=True)
        ecx, ecy, en = _red_centroid(Image.open(png))
        scx, scy, sn = _red_centroid(single)
        assert abs(ecx - scx) < 4 and abs(ecy - scy) < 4, (t, ecx, scx)
        assert abs(en - sn) / sn < 0.12, (t, en, sn)
    # Opacity 1 -> 0.2 between 1 s and 2.5 s: the red gets darker (black background).
    def redness(t):
        png = tmp_path / f"o{t}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1", str(png)], check=True)
        im = Image.open(png).convert("RGB")
        return im.getpixel((int(_red_centroid(im)[0] or 320), int(_red_centroid(im)[1] or 180)))[0] if _red_centroid(im)[2] else \
            max(p[0] for p in im.getdata())
    assert redness(1.0) > 200
    im = Image.open(io.BytesIO(client.post(f"/api/projects/{pid}/frame", json={"t": 2.4, "height": 360}).content)).convert("RGB")
    assert max(p[0] for p in im.getdata()) < 110  # ~0.25 opacity in the single frame too

    # Volume: silent for the first second, audible after.
    def level(start):
        out = subprocess.run(["ffmpeg", "-v", "info", "-ss", str(start), "-t", "0.5", "-i", str(mp4), "-af", "volumedetect",
                              "-f", "null", "-"], capture_output=True, text=True).stderr
        return float(out.split("mean_volume:")[1].split("dB")[0])
    assert level(0.2) < -60 and level(1.5) > -30
