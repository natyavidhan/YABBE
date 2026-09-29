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

    # A strongly green-tinted grey reads as partly screen; clip white makes it
    # solid. Without spill suppression its cast then stays.
    solid = {"clip_white": 0.7}
    kept = _render(client, pid, main, gs, bg, {**solid, "spill": 0})
    g = kept.getpixel((260, 90))
    assert g[1] > max(g[0], g[2]) + 25, g
    half = _render(client, pid, main, gs, bg, {**solid, "spill": 0.5}).getpixel((260, 90))
    full = _render(client, pid, main, gs, bg, {**solid, "spill": 1.0}).getpixel((260, 90))
    assert g[1] - 5 > half[1] > full[1] + 5, (g, half, full)  # strength crossfades


def test_choke_shrinks_the_matte(client, keyed):
    pid, main, gs, gsv, bg = keyed
    edge = (111, 90)  # just inside the subject's left edge
    plain = _render(client, pid, main, gs, bg, {"matte": True}).getpixel(edge)
    choked = _render(client, pid, main, gs, bg, {"matte": True, "choke": 3}).getpixel(edge)
    assert min(plain) > 200 and max(choked) < 60, (plain, choked)
    soft = _render(client, pid, main, gs, bg, {"matte": True, "feather": 4}).getpixel(edge)
    assert 40 < soft[0] < 240, soft


def _soft_shot(path, screen, w=320, h=180):
    """Subject with a soft edge and a 50 % see-through band over ``screen``;
    returns the true alpha and foreground colour for checking."""
    import numpy as np
    from PIL import ImageFilter

    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).ellipse([100, 30, 220, 150], fill=255)
    alpha = np.asarray(m.filter(ImageFilter.GaussianBlur(4)), np.float32) / 255
    alpha[80:100, 230:300] = 0.5  # e.g. motion blur / thin fabric
    fg = np.array([224, 172, 140], np.float32)
    img = alpha[..., None] * fg + (1 - alpha[..., None]) * np.array(screen, np.float32)
    Image.fromarray(img.round().astype(np.uint8)).save(path)
    return alpha, fg


@pytest.mark.parametrize("screen,color", [((0, 177, 64), "#00b140"), ((20, 60, 200), "#143cc8")])
def test_key_accuracy_against_ground_truth(client, keyed, tmp_path, screen, color):
    """Edges and see-through areas come out right: over a new background the
    result matches the true composite (no fringe of the screen colour)."""
    import numpy as np

    pid, main, _, _, bg = keyed
    alpha, fg = _soft_shot(tmp_path / "soft.png", screen)
    src = _upload(client, pid, tmp_path / "soft.png")
    _wait_ready(client, pid)
    im = np.asarray(_render(client, pid, main, src["id"], bg, {"color": color, "spill": 0}), np.float32)
    truth = alpha[..., None] * fg + (1 - alpha[..., None]) * np.array(BLUE, np.float32)
    err = np.abs(im - truth).mean(-1)
    band = (alpha > 0.05) & (alpha < 0.95)
    assert err.mean() < 4, err.mean()
    assert err[band].mean() < 14, err[band].mean()  # was ~2x worse with a colour-distance key
    see_through = im[90, 265]
    assert all(abs(a - b) < 20 for a, b in zip(see_through, truth[90, 265])), (see_through, truth[90, 265])


@pytest.mark.parametrize("color", ["#006428", "#0e0f11", "#808080"])
def test_dark_or_unsaturated_screen_colours_render(client, keyed, color):
    """A dark green screen keys; a colour that isn't a screen at all (near
    black / grey) mustn't break rendering (it just keys nothing useful)."""
    pid, main, gs, gsv, bg = keyed
    _render(client, pid, main, gs, bg, {"color": color})
