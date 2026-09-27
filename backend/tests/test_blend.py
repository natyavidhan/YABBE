"""Blend modes match the Photoshop formulas (a = layer on top, b = what's below)."""

from __future__ import annotations

import io
import math

import pytest
from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


def _sl(a, b):  # soft light (W3C)
    d = ((16 * b - 12) * b + 4) * b if b <= 0.25 else math.sqrt(b)
    return b - (1 - 2 * a) * b * (1 - b) if a <= 0.5 else b + (2 * a - 1) * (d - b)


F = {
    "normal": lambda a, b: a,
    "darken": min,
    "multiply": lambda a, b: a * b,
    "color_burn": lambda a, b: 0 if a == 0 else max(0, 1 - (1 - b) / a),
    "linear_burn": lambda a, b: max(0, a + b - 1),
    "lighten": max,
    "screen": lambda a, b: 1 - (1 - a) * (1 - b),
    "color_dodge": lambda a, b: 1 if a >= 1 else min(1, b / (1 - a)),
    "add": lambda a, b: min(1, a + b),
    "overlay": lambda a, b: 2 * a * b if b < 0.5 else 1 - 2 * (1 - a) * (1 - b),
    "soft_light": _sl,
    "hard_light": lambda a, b: 2 * a * b if a < 0.5 else 1 - 2 * (1 - a) * (1 - b),
    "vivid_light": lambda a, b: (max(0, 1 - (1 - b) / (2 * a)) if a < 0.5 else min(1, b / (2 * (1 - a)))),
    "linear_light": lambda a, b: min(1, max(0, b + 2 * a - 1)),
    "pin_light": lambda a, b: min(b, 2 * a) if a < 0.5 else max(b, 2 * a - 1),
    "hard_mix": lambda a, b: 1 if a + b >= 1 else 0,
    "difference": lambda a, b: abs(a - b),
    "exclusion": lambda a, b: a + b - 2 * a * b,
    "subtract": lambda a, b: max(0, b - a),
    "divide": lambda a, b: 1 if a == 0 else min(1, b / a),
}
TOP = (200, 110, 40)
BASE = (70, 150, 210)


def expected(mode, opacity=1.0):
    out = []
    for a, b in zip(TOP, BASE):
        v = F[mode](a / 255, b / 255)
        out.append(round((v * opacity + b / 255 * (1 - opacity)) * 255))
    return tuple(out)


@pytest.fixture(scope="module")
def blend_project(client, tmp_path_factory):
    d = tmp_path_factory.mktemp("blend")
    Image.new("RGB", (320, 180), TOP).save(d / "top.png")
    Image.new("RGB", (320, 180), BASE).save(d / "base.png")
    pid = client.post("/api/projects", json={"name": "blend", "width": 320, "height": 180, "fps": 25}).json()["id"]
    top = _upload(client, pid, d / "top.png")
    base = _upload(client, pid, d / "base.png")
    main = main_seq(_wait_ready(client, pid))
    return pid, main, top["id"], base["id"]


def _clips(main, top, base, mode, opacity=1.0):
    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]
    return [
        {"track_id": v1, "type": "image", "asset_id": base, "start": 0, "duration": 2},
        {"track_id": v2, "type": "image", "asset_id": top, "start": 0, "duration": 2, "blend": mode,
         "transform": {"scale": 0.5, "opacity": opacity}},
    ]


def _frame(client, pid, timeline, t=1.0):
    r = client.post(f"/api/projects/{pid}/frame", json={"t": t, "height": 180, "timeline": timeline})
    assert r.status_code == 200, r.text
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def _close(got, want, tol=12):
    assert all(abs(g - w) <= tol for g, w in zip(got, want)), (got, want)


@pytest.mark.parametrize("mode", list(F))
def test_blend_modes(client, blend_project, mode):
    pid, main, top, base = blend_project
    im = _frame(client, pid, {"sequence_id": main["id"], "clips": _clips(main, top, base, mode)})
    _close(im.getpixel((160, 90)), expected(mode))
    _close(im.getpixel((10, 10)), BASE)  # outside the layer: untouched


def test_blend_opacity_and_export(client, blend_project):
    pid, main, top, base = blend_project
    im = _frame(client, pid, {"sequence_id": main["id"], "clips": _clips(main, top, base, "multiply", 0.5)})
    _close(im.getpixel((160, 90)), expected("multiply", 0.5))

    main = {**main, "clips": _clips(main, top, base, "screen")}
    assert client.put(f"/api/projects/{pid}", json={"sequences": [main]}).status_code == 200
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    _wait_job(client, r.json()["job"]["id"])
    import subprocess
    from app import storage
    path = storage.exports_dir(pid) / r.json()["export"]["filename"]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", "1", "-i", str(path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    px = Image.frombytes("RGB", (320, 180), raw).getpixel((160, 90))
    _close(px, expected("screen"))


def test_blend_inside_nested_sequence(client, blend_project):
    """In a nested sequence a blended layer with nothing below it shows as
    normal (the parent's picture isn't part of the nested sequence)."""
    pid, main, top, base = blend_project
    child = {"id": "s_blend", "name": "Child", "settings": main["settings"],
             "tracks": [{"id": "cv", "kind": "video"}],
             "clips": [{"track_id": "cv", "type": "image", "asset_id": top, "start": 0, "duration": 2,
                        "blend": "multiply", "transform": {"scale": 0.5}}]}
    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]
    parent = {**main, "clips": [
        {"track_id": v1, "type": "image", "asset_id": base, "start": 0, "duration": 2},
        {"track_id": v2, "type": "sequence", "sequence_id": "s_blend", "start": 0, "duration": 2}]}
    im = _frame(client, pid, {"sequence_id": main["id"], "sequences": [parent, child]})
    _close(im.getpixel((160, 90)), TOP)
    _close(im.getpixel((10, 10)), BASE)
