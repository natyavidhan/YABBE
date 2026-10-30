"""Shared fixtures: one app instance with a temporary data dir per test session."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))

# Before any test module imports app.config, so nothing ever lands in the real data dir.
_DATA = tempfile.mkdtemp(prefix="yabbe-tests-")
os.environ["YABBE_DATA_DIR"] = os.path.join(_DATA, "data")
os.environ["YABBE_STATIC_DIR"] = os.path.join(_DATA, "nostatic")
os.environ["YABBE_AUTO_PRERENDER"] = "0"  # tests that want it turn it on


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_DATA, ignore_errors=True)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("media")
    ff = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    subprocess.run([*ff, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=4",
                    "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(d / "clip.mp4")], check=True)
    subprocess.run([*ff, "-f", "lavfi", "-i", "sine=f=220:d=3", str(d / "tone.wav")], check=True)
    Image.new("RGB", (800, 600), (200, 30, 30)).save(d / "photo.png")
    return d


@pytest.fixture(scope="session")
def client(media_dir):
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




def main_seq(project: dict) -> dict:
    """The main sequence of a project JSON (tracks / clips / settings live there)."""
    return next(s for s in project["sequences"] if s["id"] == project["main_sequence_id"])
