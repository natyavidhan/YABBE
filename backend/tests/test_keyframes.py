"""Keyframes: interpolation maths and per-frame rendering vs single frames."""

from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from app.engine import keyframes
from app.models import Clip, Keyframe

from conftest import _upload, _wait_job, _wait_ready


def K(t, v, ease="linear"):
    return Keyframe(t=t, v=v, ease=ease)


def test_curve_fixture_is_current():
    """The shared fixture (also used by the frontend tests) matches Python."""
    from gen_curve_fixture import build
    committed = json.loads((Path(__file__).parent / "fixtures" / "curves.json").read_text())
    assert committed == build(), "run: uv run python tests/gen_curve_fixture.py"


@pytest.mark.parametrize("ease", ["linear", "ease_in", "ease_out", "ease_in_out", "back_in", "back_out",
                                  "back_in_out", "elastic_in", "elastic_out", "elastic_in_out",
                                  "bounce_in", "bounce_out", "bounce_in_out"])
def test_named_eases_hit_endpoints(ease):
    from app.engine.curves import named_ease
    assert named_ease(ease, 0) == pytest.approx(0, abs=1e-9)
    assert named_ease(ease, 1) == pytest.approx(1, abs=1e-9)


def test_bezier_segments():
    from app.engine.curves import value_at
    # Default handles (none given) = straight line.
    lin = [K(0, 0, "bezier"), K(2, 100)]
    assert value_at(lin, 0.5) == pytest.approx(25, abs=1e-6)
    # Flat handles (easy ease): slow at both ends, symmetric.
    ease = [Keyframe(t=0, v=0, ease="bezier", ho=(2 / 3, 0)), Keyframe(t=2, v=100, hi=(-2 / 3, 0))]
    assert value_at(ease, 1) == pytest.approx(50, abs=1e-6)
    assert value_at(ease, 0.2) < 5 and value_at(ease, 1.8) > 95
    # A bump between equal values (impossible with named eases).
    bump = [Keyframe(t=0, v=0, ease="bezier", ho=(0.5, 80)), Keyframe(t=2, v=0, hi=(-0.5, 80))]
    assert value_at(bump, 1) > 50
    # Over-long handles are clamped so time never runs backwards.
    wild = [Keyframe(t=0, v=0, ease="bezier", ho=(10, 0)), Keyframe(t=1, v=1, hi=(-10, 0))]
    vals = [value_at(wild, u / 20) for u in range(21)]
    assert vals == sorted(vals)


def test_ease_shapes():
    assert keyframes.ease("linear", 0.25) == pytest.approx(0.25)
    assert keyframes.ease("back_out", 0.6) > 1  # overshoots
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


def _ink_box(img: Image.Image):
    """Bounding box of non-black pixels and the average colour inside it."""
    im = img.convert("RGB")
    mask = im.convert("L").point(lambda v: 255 if v > 40 else 0)
    box = mask.getbbox()
    return box


def _mean_rgb(img: Image.Image, box):
    crop = img.convert("RGB").crop(box)
    px = list(crop.getdata())
    lit = [p for p in px if sum(p) > 120] or px
    return tuple(sum(c[i] for c in lit) / len(lit) for i in range(3))


def test_text_style_keyframes(client, tmp_path):
    pid = client.post("/api/projects", json={"name": "text kf", "width": 640, "height": 360, "fps": 25}).json()["id"]
    project = client.get(f"/api/projects/{pid}").json()
    clip = {
        "track_id": project["tracks"][0]["id"], "type": "text", "start": 0, "duration": 2.5,
        "text": {"content": "YABBE", "size": 60, "color": "#ffffff", "background": "#00c0ff00", "padding": 10},
        "keyframes": {
            "text_size": [{"t": 0, "v": 60}, {"t": 2, "v": 140}],
            "text_color": [{"t": 0, "c": "#ffffff"}, {"t": 2, "c": "#ff0000"}],
            "text_background": [{"t": 0, "c": "#00c0ff00"}, {"t": 2, "c": "#00c0ffff"}],
        },
    }
    r = client.put(f"/api/projects/{pid}", json={"clips": [clip]})
    assert r.status_code == 200, r.text
    assert set(r.json()["clips"][0]["keyframes"]) == {"text_size", "text_color", "text_background"}

    singles = {t: Image.open(io.BytesIO(client.post(f"/api/projects/{pid}/frame", json={"t": t, "height": 360}).content))
               for t in (0.2, 1.0, 2.0)}
    widths = {t: (lambda b: b[2] - b[0])(_ink_box(im)) for t, im in singles.items()}
    assert widths[0.2] < widths[1.0] < widths[2.0]  # growing font
    # at 2 s: box fully blue, text red
    b = _ink_box(singles[2.0])
    corner = singles[2.0].convert("RGB").getpixel((b[0] + 2, b[1] + 2))
    assert corner[2] > 180 and corner[0] < 60, corner
    # at 0.2 s: box nearly transparent, text still nearly white
    r0, g0, b0 = _mean_rgb(singles[0.2], _ink_box(singles[0.2]))
    assert min(r0, g0, b0) > 150

    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    job = _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    mp4 = tmp_path / "text.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
    for t, single in singles.items():
        png = tmp_path / f"t{t}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1", str(png)], check=True)
        eb, sb = _ink_box(Image.open(png)), _ink_box(single)
        assert all(abs(x - y) <= 4 for x, y in zip(eb, sb)), (t, eb, sb)
        ec, sc = _mean_rgb(Image.open(png), eb), _mean_rgb(single, sb)
        assert all(abs(x - y) < 25 for x, y in zip(ec, sc)), (t, ec, sc)


def test_new_curves_render_exactly(client, tmp_path):
    """Back / elastic / bounce / Bézier curves: export (per-frame commands)
    matches single-frame renders (Python evaluation) at the same instants."""
    photo = tmp_path / "red2.png"
    Image.new("RGB", (300, 300), (230, 20, 20)).save(photo)
    pid = client.post("/api/projects", json={"name": "curves", "width": 640, "height": 360, "fps": 25}).json()["id"]
    img = _upload(client, pid, photo)
    project = _wait_ready(client, pid)
    clip = {
        "track_id": project["tracks"][1]["id"], "type": "image", "asset_id": img["id"], "start": 0, "duration": 3.2,
        "transform": {"scale": 0.25},
        "keyframes": {
            "x": [{"t": 0, "v": -250, "ease": "back_out"}, {"t": 1, "v": 150, "ease": "elastic_out", "ep": [2, 8]},
                  {"t": 2, "v": -100, "ease": "bezier", "ho": [0.2, 300]}, {"t": 3, "v": 100, "hi": [-0.3, 0]}],
            "scale": [{"t": 0, "v": 0.15, "ease": "bounce_out"}, {"t": 1.5, "v": 0.4}],
            "rotation": [{"t": 0, "v": 0, "ease": "bezier", "ho": [1, 120]}, {"t": 3, "v": 0, "hi": [-1, 120]}],
        },
    }
    assert client.put(f"/api/projects/{pid}", json={"clips": [clip]}).status_code == 200
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    job = _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    mp4 = tmp_path / "curves.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
    for t in (0.2, 0.4, 0.72, 1.12, 1.4, 2.2, 2.6, 3.0):
        single = Image.open(io.BytesIO(client.post(f"/api/projects/{pid}/frame", json={"t": t, "height": 360}).content))
        png = tmp_path / f"c{t}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(mp4), "-frames:v", "1", str(png)], check=True)
        ecx, ecy, en = _red_centroid(Image.open(png))
        scx, scy, sn = _red_centroid(single)
        assert en and sn, t
        assert abs(ecx - scx) < 4 and abs(ecy - scy) < 4, (t, ecx, scx)
        assert abs(en - sn) / sn < 0.12, (t, en, sn)
