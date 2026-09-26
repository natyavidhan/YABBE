"""End-to-end API test with generated media (requires ffmpeg on PATH)."""
# Fixtures and helpers live in conftest.py.

from __future__ import annotations

import io
import subprocess
import time
import zipfile
from pathlib import Path

import pytest  # noqa: F401
from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


def test_full_flow(client, media_dir):
    r = client.post("/api/projects", json={"name": "Test", "width": 1280, "height": 720, "fps": 25})
    assert r.status_code == 200
    project = r.json()
    pid = project["id"]
    assert client.get("/api/projects").json()[0]["id"] == pid

    video = _upload(client, pid, media_dir / "clip.mp4")
    audio = _upload(client, pid, media_dir / "tone.wav")
    photo = _upload(client, pid, media_dir / "photo.png")
    assert (video["kind"], audio["kind"], photo["kind"]) == ("video", "audio", "image")
    assert video["width"] == 640 and video["has_audio"]
    project = _wait_ready(client, pid)

    vt_top, vt_bottom, at = [t["id"] for t in main_seq(project)["tracks"]]
    clips = [
        {"track_id": vt_bottom, "type": "video", "asset_id": video["id"], "start": 0, "duration": 4,
         "fade_in": 0.5, "volume": 0.8},
        {"track_id": vt_top, "type": "image", "asset_id": photo["id"], "start": 1, "duration": 2,
         "transform": {"x": 300, "y": -100, "scale": 0.3, "rotation": 15, "opacity": 0.8},
         "crop": {"left": 0.1, "right": 0.1}},
        {"track_id": vt_top, "type": "text", "start": 3, "duration": 2,
         "text": {"content": "Hello\nYABBE", "size": 80, "stroke_width": 3, "background": "#00000080"}},
        {"track_id": at, "type": "audio", "asset_id": audio["id"], "start": 0.5, "duration": 2,
         "in_point": 0.5, "speed": 1.5, "fade_out": 1},
    ]
    r = client.put(f"/api/projects/{pid}", json={"clips": clips})
    assert r.status_code == 200, r.text
    assert len(main_seq(r.json())["clips"]) == 4

    # Frame render (photo layer visible at t=1.5)
    r = client.post(f"/api/projects/{pid}/frame", json={"t": 1.5, "height": 360})
    assert r.status_code == 200, r.text
    img = Image.open(io.BytesIO(r.content))
    assert img.size == (640, 360)
    # Photo is red and sits right of centre, above the middle.
    px = img.getpixel((320 + 150, 180 - 50))
    assert px[0] > 150 and px[1] < 120, px

    # Unsaved timeline override: empty timeline gives plain background.
    r = client.post(f"/api/projects/{pid}/frame", json={"t": 1.5, "height": 360, "timeline": {"clips": []}})
    assert max(Image.open(io.BytesIO(r.content)).convert("L").getextrema()) < 20

    # Lazy HLS preview
    r = client.post(f"/api/projects/{pid}/preview", json={"height": 360})
    session = r.json()
    assert session["count"] == 3  # 5s timeline in 2s segments
    pl = client.get(f"/api/preview/{session['key']}/index.m3u8").text
    assert "seg_2.ts" in pl and "#EXT-X-ENDLIST" in pl
    r = client.get(f"/api/preview/{session['key']}/seg_1.ts")
    assert r.status_code == 200 and len(r.content) > 1000

    # Export
    r = client.post(f"/api/projects/{pid}/exports", json={"height": 360, "quality": "low"})
    assert r.status_code == 200, r.text
    job = _wait_job(client, r.json()["job"]["id"])
    assert job["status"] == "done", job
    exports = client.get(f"/api/projects/{pid}/exports").json()
    assert exports[0]["status"] == "done"
    r = client.get(f"/api/projects/{pid}/exports/{exports[0]['id']}/download")
    assert r.status_code == 200
    out = media_dir / "export.mp4"
    out.write_bytes(r.content)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width",
                            "-of", "csv=p=0", str(out)], capture_output=True, text=True).stdout
    assert "640" in probe and "audio" in probe
    dur = float(probe.strip().splitlines()[-1])
    assert abs(dur - 5.0) < 0.15, probe

    # Package round trip
    r = client.get(f"/api/projects/{pid}/package")
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert "project.json" in names and sum(n.startswith("media/") for n in names) == 3
    r = client.post("/api/projects/import", content=r.content)
    assert r.status_code == 200, r.text
    imported = r.json()
    assert imported["id"] != pid and len(main_seq(imported)["clips"]) == 4
    _wait_ready(client, imported["id"])

    # Delete asset removes its clips
    client.delete(f"/api/projects/{pid}/media/{photo['id']}")
    assert len(main_seq(client.get(f"/api/projects/{pid}").json())["clips"]) == 3

    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_fonts_and_measure(client):
    fonts = client.get("/api/fonts").json()
    assert fonts
    r = client.post("/api/text/measure", json={"content": "Hi", "size": 50})
    small = r.json()
    r = client.post("/api/text/measure", json={"content": "Hi", "size": 100})
    assert r.json()["width"] > small["width"]


def test_exif_orientation_is_baked_in(client, tmp_path):
    img = Image.new("RGB", (400, 200), (10, 200, 10))
    exif = img.getexif()
    exif[0x0112] = 6  # rotate 90° CW on display
    path = tmp_path / "phone.jpg"
    img.save(path, exif=exif)
    pid = client.post("/api/projects", json={"name": "exif"}).json()["id"]
    asset = _upload(client, pid, path)
    assert (asset["kind"], asset["width"], asset["height"]) == ("image", 200, 400)


def test_clip_markers_round_trip(client):
    pid = client.post("/api/projects", json={"name": "markers"}).json()["id"]
    track = main_seq(client.get(f"/api/projects/{pid}").json())["tracks"][0]["id"]
    clip = {"track_id": track, "type": "text", "start": 1, "duration": 4, "text": {"content": "m"},
            "link": "l_group1",
            "markers": [{"id": "m_a", "t": 1.5, "label": "Beat", "color": "#3fcf8e"},
                        {"t": 3, "color": "not-a-colour"}]}
    r = client.put(f"/api/projects/{pid}", json={"clips": [clip]})
    assert r.status_code == 200, r.text
    saved = main_seq(client.get(f"/api/projects/{pid}").json())["clips"][0]
    assert saved["link"] == "l_group1"
    markers = saved["markers"]
    assert markers[0] == {"id": "m_a", "t": 1.5, "label": "Beat", "color": "#3fcf8e"}
    assert markers[1]["id"].startswith("m_") and markers[1]["color"] == "#f2b84b"
    # markers don't affect rendering
    assert client.post(f"/api/projects/{pid}/frame", json={"t": 2}).status_code == 200
