"""End-to-end API test with generated media (requires ffmpeg on PATH)."""

from __future__ import annotations

import io
import subprocess
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image


@pytest.fixture(scope="module")
def media_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("media")
    ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run([*ff, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4",
                    "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(d / "clip.mp4")], check=True)
    subprocess.run([*ff, "-f", "lavfi", "-i", "sine=f=220:d=3", str(d / "tone.wav")], check=True)
    Image.new("RGB", (800, 600), (200, 30, 30)).save(d / "photo.png")
    return d


@pytest.fixture(scope="module")
def client(tmp_path_factory, media_dir):
    import os
    os.environ["YABBE_DATA_DIR"] = str(tmp_path_factory.mktemp("data"))
    os.environ["YABBE_STATIC_DIR"] = str(tmp_path_factory.mktemp("nostatic") / "none")
    from app.main import app
    with TestClient(app) as c:
        yield c


def _upload(client, pid, path: Path) -> dict:
    r = client.post(f"/api/projects/{pid}/media", params={"filename": path.name}, content=path.read_bytes())
    assert r.status_code == 200, r.text
    return r.json()


def _wait_ready(client, pid, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        project = client.get(f"/api/projects/{pid}").json()
        statuses = {a["status"] for a in project["assets"]}
        if statuses <= {"ready", "error"}:
            assert "error" not in statuses, project["assets"]
            return project
        time.sleep(0.3)
    raise AssertionError("media processing timed out")


def _wait_job(client, jid, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{jid}").json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.3)
    raise AssertionError("job timed out")


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

    vt_top, vt_bottom, at = [t["id"] for t in project["tracks"]]
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
    assert len(r.json()["clips"]) == 4

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
    assert imported["id"] != pid and len(imported["clips"]) == 4
    _wait_ready(client, imported["id"])

    # Delete asset removes its clips
    client.delete(f"/api/projects/{pid}/media/{photo['id']}")
    assert len(client.get(f"/api/projects/{pid}").json()["clips"]) == 3

    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_fonts_and_measure(client):
    fonts = client.get("/api/fonts").json()
    assert fonts
    r = client.post("/api/text/measure", json={"content": "Hi", "size": 50})
    small = r.json()
    r = client.post("/api/text/measure", json={"content": "Hi", "size": 100})
    assert r.json()["width"] > small["width"]
