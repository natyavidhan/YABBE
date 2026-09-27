"""Storage limits: clear refusals instead of half-written files."""

from __future__ import annotations

from conftest import _upload, _wait_ready


def test_storage_limits(client, media_dir, monkeypatch):
    from app import storage

    info = client.get("/api/storage").json()
    assert info["total"] > 0 and info["free"] <= info["total"]

    pid = client.post("/api/projects", json={"name": "space"}).json()["id"]
    _upload(client, pid, media_dir / "photo.png")
    _wait_ready(client, pid)

    gb = 1024**3
    free = {"n": 150 * 1024**2}  # a 1 GB disk with 150 MB left (100 MB reserve)
    monkeypatch.setattr(storage, "disk", lambda: (gb, gb - free["n"], free["n"]))
    monkeypatch.setattr(storage, "reclaim", lambda want: free["n"])

    # Small upload fits; one that would eat into the reserve is refused up front.
    assert client.post(f"/api/projects/{pid}/media", params={"filename": "clip.mp4"},
                       content=(media_dir / "clip.mp4").read_bytes()).status_code == 200
    big = b"\0" * (80 * 1024**2)
    r = client.post(f"/api/projects/{pid}/media", params={"filename": "big.mp4"}, content=big)
    assert r.status_code == 507, r.text
    assert "Not enough storage for this upload: 150 MB free of 1.0 GB" in r.json()["detail"]
    assert len(client.get(f"/api/projects/{pid}").json()["assets"]) == 2  # nothing half-stored

    # Exports are refused when they can't fit either.
    free["n"] = 101 * 1024**2
    project = client.get(f"/api/projects/{pid}").json()
    seq = project["sequences"][0]
    seq["clips"] = [{"track_id": seq["tracks"][1]["id"], "type": "image", "asset_id": project["assets"][0]["id"],
                     "start": 0, "duration": 60}]
    client.put(f"/api/projects/{pid}", json={"sequences": [seq]})
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low"})
    assert r.status_code == 507 and "this export" in r.json()["detail"]


def test_reclaim_removes_old_previews(client, tmp_path):
    import os
    import time

    from app import config, storage

    old = config.PREVIEW_DIR / ("0" * 16 + "_1")
    old.mkdir(parents=True, exist_ok=True)
    (old / "session.json").write_text("{}")
    past = time.time() - 3600
    os.utime(old / "session.json", (past, past))
    # Ask for more than the disk has: everything disposable and old goes.
    storage.reclaim(storage.disk()[0] * 2)
    assert not old.exists()


def test_storage_limit_setting(client, media_dir, monkeypatch):
    """YABBE_STORAGE_LIMIT_MB caps the data folder (no special filesystem needed)."""
    from app import config, storage

    used = storage._dir_size(config.DATA_DIR, max_age=0)
    monkeypatch.setattr(config, "STORAGE_LIMIT_MB", used // 1024**2 + 102)  # ~2 MB above the reserve
    storage._forget_size()
    total, now_used, free = storage.disk()
    assert total == config.STORAGE_LIMIT_MB * 1024**2 and abs(now_used - used) < 1024**2
    info = client.get("/api/storage").json()
    assert info["total"] == total

    pid = client.post("/api/projects", json={"name": "limit"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/media", params={"filename": "big.mp4"}, content=b"\0" * (8 * 1024**2))
    assert r.status_code == 507, r.text
    storage._forget_size()
    r = client.post(f"/api/projects/{pid}/media", params={"filename": "photo.png"},
                    content=(media_dir / "photo.png").read_bytes())
    assert r.status_code == 200, r.text
