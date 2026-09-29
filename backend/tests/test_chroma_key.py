"""Chroma key: green screen removed, spill cleaned, matte view, toggling."""

from __future__ import annotations

import io
import subprocess

import pytest
from PIL import Image, ImageDraw

from conftest import _upload, _wait_ready, main_seq

SCREEN = (0, 177, 64)
BLUE = (30, 30, 220)
SUBJECT = (200, 40, 40)
SPILLED = (128, 165, 120)  # grey with a green cast


def _screen_shot(path, w=320, h=180):
    im = Image.new("RGB", (w, h), SCREEN)
    d = ImageDraw.Draw(im)
    d.rectangle([110, 50, 210, 130], fill=SUBJECT)
    d.rectangle([230, 60, 290, 120], fill=SPILLED)
    im.save(path)


@pytest.fixture(scope="module")
def keyed(client, tmp_path_factory):
    d = tmp_path_factory.mktemp("key")
    _screen_shot(d / "gs.png")
    Image.new("RGB", (320, 180), BLUE).save(d / "bg.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-loop", "1", "-i", str(d / "gs.png"), "-t", "3", "-r", "25",
                    "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "10", str(d / "gs.mp4")], check=True)
    pid = client.post("/api/projects", json={"name": "key", "width": 320, "height": 180, "fps": 25}).json()["id"]
    gs = _upload(client, pid, d / "gs.png")
    gsv = _upload(client, pid, d / "gs.mp4")
    bg = _upload(client, pid, d / "bg.png")
    main = main_seq(_wait_ready(client, pid))
    return pid, main, gs["id"], gsv["id"], bg["id"]


def _render(client, pid, main, fg, bg, key, kind="image", t=1.0):
    v2, v1 = main["tracks"][0]["id"], main["tracks"][1]["id"]
    clips = [
        {"track_id": v1, "type": "image", "asset_id": bg, "start": 0, "duration": 3},
        {"track_id": v2, "type": kind, "asset_id": fg, "start": 0, "duration": 3, "chroma_key": key},
    ]
    r = client.post(f"/api/projects/{pid}/frame",
                    json={"t": t, "height": 180, "timeline": {"sequence_id": main["id"], "clips": clips}})
    assert r.status_code == 200, r.text
    return Image.open(io.BytesIO(r.content)).convert("RGB")


def _near(got, want, tol=18):
    assert all(abs(a - b) <= tol for a, b in zip(got, want)), (got, want)


def test_key_removes_screen_and_spill(client, keyed):
    pid, main, gs, gsv, bg = keyed
    for kind, src in (("image", gs), ("video", gsv)):
        im = _render(client, pid, main, src, bg, {"spill": 1.0}, kind)
        _near(im.getpixel((20, 20)), BLUE)        # screen gone: background shows
        _near(im.getpixel((160, 90)), SUBJECT)    # subject kept
        g = im.getpixel((260, 90))                # spill: green no longer above red/blue
        assert g[1] <= max(g[0], g[2]) + 12, (kind, g)


def test_key_off_matte_and_strength(client, keyed):
    pid, main, gs, gsv, bg = keyed
    off = _render(client, pid, main, gs, bg, {"enabled": False})
    _near(off.getpixel((20, 20)), SCREEN)
    none = _render(client, pid, main, gs, bg, None)
    _near(none.getpixel((20, 20)), SCREEN)

    matte = _render(client, pid, main, gs, bg, {"matte": True})
    assert max(matte.getpixel((20, 20))) < 30 and min(matte.getpixel((160, 90))) > 225

    # No spill suppression: the green cast stays.
    kept = _render(client, pid, main, gs, bg, {"spill": 0})
    g = kept.getpixel((260, 90))
    assert g[1] > max(g[0], g[2]) + 25, g
    half = _render(client, pid, main, gs, bg, {"spill": 0.5}).getpixel((260, 90))
    full = _render(client, pid, main, gs, bg, {"spill": 1.0}).getpixel((260, 90))
    assert g[1] - 5 > half[1] > full[1] + 5, (g, half, full)  # strength crossfades


def test_choke_shrinks_the_matte(client, keyed):
    pid, main, gs, gsv, bg = keyed
    edge = (111, 90)  # just inside the subject's left edge
    plain = _render(client, pid, main, gs, bg, {"matte": True}).getpixel(edge)
    choked = _render(client, pid, main, gs, bg, {"matte": True, "choke": 3}).getpixel(edge)
    assert min(plain) > 200 and max(choked) < 60, (plain, choked)
    soft = _render(client, pid, main, gs, bg, {"matte": True, "feather": 4}).getpixel(edge)
    assert 40 < soft[0] < 240, soft
