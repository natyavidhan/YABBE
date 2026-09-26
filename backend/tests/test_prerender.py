"""Pre-rendered sequences (phase 3)."""

from __future__ import annotations

import time

from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq
from test_nesting import _frame, _seq


def _status(client, pid, sid):
    rows = client.get(f"/api/projects/{pid}/prerenders").json()
    row = next(r for r in rows if r["sequence_id"] == sid)
    return {q["quality"]: q for q in row["qualities"]}, row["used"]


def _setup(client, tmp_path, name):
    blue = tmp_path / f"{name}_b.png"
    Image.new("RGB", (320, 180), (30, 30, 220)).save(blue)
    pid = client.post("/api/projects", json={"name": name, "width": 320, "height": 180, "fps": 25}).json()["id"]
    b = _upload(client, pid, blue)
    project = _wait_ready(client, pid)
    main = main_seq(project)
    vt = main["tracks"][1]["id"]
    inner = _seq("s_in", "Inner", [{"track_id": "s_in_v", "type": "image", "asset_id": b["id"], "start": 0, "duration": 2}])
    mid = _seq("s_mid", "Mid", [{"track_id": "s_mid_v", "type": "sequence", "sequence_id": "s_in", "start": 0, "duration": 2}])
    main["clips"] = [{"track_id": vt, "type": "sequence", "sequence_id": "s_mid", "start": 0, "duration": 2}]
    r = client.put(f"/api/projects/{pid}", json={"sequences": [main, inner, mid]})
    assert r.status_code == 200, r.text
    return pid, main, inner, mid


def test_prerender(client, tmp_path):
    from app.engine import prerender

    pid, main, inner, mid = _setup(client, tmp_path, "pre")
    st, used = _status(client, pid, "s_mid")
    assert used and st["draft"]["state"] == "none"
    assert not _status(client, pid, main["id"])[1]

    # Pre-rendering Mid also pre-renders Inner (deepest first).
    job = client.post(f"/api/projects/{pid}/sequences/s_mid/prerender", json={"quality": "draft"}).json()
    assert job["kind"] == "prerender"
    _wait_job(client, job["id"])
    for sid in ("s_in", "s_mid"):
        st, _ = _status(client, pid, sid)
        assert st["draft"]["state"] == "fresh", st
        assert st["draft"]["height"] == 180 and st["full"]["state"] == "none"
    # Up to date: nothing to do.
    assert client.post(f"/api/projects/{pid}/sequences/s_mid/prerender", json={"quality": "draft"}).json() is None

    project = client.get(f"/api/projects/{pid}").json()
    from app.models import Project
    p = Project.model_validate(project)
    assert prerender.usable(p, "s_mid", 180, draft=True) is not None
    assert prerender.usable(p, "s_mid", 180, draft=False) is None  # drafts come from proxies
    # Previews read from it: the picture is the same.
    px = _frame(client, pid, 1.0, (160, 90))
    assert px[2] > 150 and px[0] < 90, px

    # Editing Inner makes both stale (and deletes the files).
    inner["clips"][0]["transform"] = {"scale": 0.5}
    assert client.put(f"/api/projects/{pid}", json={"sequences": [main, inner, mid]}).status_code == 200
    for sid in ("s_in", "s_mid"):
        assert _status(client, pid, sid)[0]["draft"]["state"] == "stale"
    p = Project.model_validate(client.get(f"/api/projects/{pid}").json())
    assert prerender.usable(p, "s_mid", 180, draft=True) is None
    px = _frame(client, pid, 1.0, (10, 10))
    assert max(px) < 40, px  # the edit shows (corner is now empty)

    # Clearing
    client.delete(f"/api/projects/{pid}/sequences/s_mid/prerender")
    assert _status(client, pid, "s_mid")[0]["draft"]["state"] == "none"

    # Export makes full-quality pre-renders of nested sequences first.
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low"})
    assert r.status_code == 200, r.text
    _wait_job(client, r.json()["job"]["id"])
    for sid in ("s_in", "s_mid"):
        st, _ = _status(client, pid, sid)
        assert st["full"]["state"] == "fresh", st
    p = Project.model_validate(client.get(f"/api/projects/{pid}").json())
    assert prerender.usable(p, "s_mid", 180, draft=False) is not None


def test_auto_prerender(client, tmp_path, monkeypatch):
    from app import config
    from app.engine import prerender

    monkeypatch.setattr(config, "AUTO_PRERENDER", True)
    monkeypatch.setattr(prerender, "AUTO_DELAY", 0.3)
    pid, main, inner, mid = _setup(client, tmp_path, "auto")
    deadline = time.time() + 60
    while time.time() < deadline:
        if all(_status(client, pid, s)[0]["draft"]["state"] == "fresh" for s in ("s_in", "s_mid")):
            break
        time.sleep(0.3)
    else:
        raise AssertionError(client.get(f"/api/projects/{pid}/prerenders").json())
    # The main sequence isn't nested anywhere: not pre-rendered.
    assert _status(client, pid, main["id"])[0]["draft"]["state"] == "none"

    # Turned off per project.
    assert client.put(f"/api/projects/{pid}", json={"auto_prerender": False}).json()["auto_prerender"] is False
    inner["clips"][0]["duration"] = 1
    client.put(f"/api/projects/{pid}", json={"sequences": [main, inner, mid]})
    time.sleep(1.5)
    assert _status(client, pid, "s_in")[0]["draft"]["state"] == "stale"


def test_package_and_duplicate_keep_sequences(client, tmp_path):
    """.yabbe export/import and duplicate keep sequences + nesting working,
    and never carry over renders (they're keyed to the original project)."""
    from app import storage

    pid, main, inner, mid = _setup(client, tmp_path, "pkg")
    job = client.post(f"/api/projects/{pid}/sequences/s_mid/prerender", json={"quality": "draft"}).json()
    _wait_job(client, job["id"])
    before = _frame(client, pid, 1.0, (160, 90))

    def check(new_id):
        p = client.get(f"/api/projects/{new_id}").json()
        assert {s["id"] for s in p["sequences"]} == {main["id"], "s_in", "s_mid"}
        assert p["main_sequence_id"] == main["id"]
        assert main_seq(p)["clips"][0]["sequence_id"] == "s_mid"
        assert not (storage.cache_dir(new_id) / "prerender").exists()
        assert not (storage.cache_dir(new_id) / "nested").exists()
        st, used = _status(client, new_id, "s_mid")
        assert used and st["draft"]["state"] == "none"
        assert _frame(client, new_id, 1.0, (160, 90)) == before

    dup = client.post(f"/api/projects/{pid}/duplicate").json()
    check(dup["id"])

    pkg = client.get(f"/api/projects/{pid}/package")
    assert pkg.status_code == 200
    imported = client.post("/api/projects/import", content=pkg.content).json()
    _wait_ready(client, imported["id"])
    check(imported["id"])


def test_preview_uses_unsaved_sequences(client, tmp_path):
    """Render requests carry every sequence's live state: a sequence created and
    nested moments ago (not saved yet) already shows in the preview."""
    pid, main, inner, mid = _setup(client, tmp_path, "unsaved")
    fresh = _seq("s_new", "New", [{"track_id": "s_new_v", "type": "sequence", "sequence_id": "s_in",
                                   "start": 0, "duration": 2, "transform": {"scale": 0.5}}])
    live_main = {**main, "clips": [{**main["clips"][0], "sequence_id": "s_new"}]}
    r = client.post(f"/api/projects/{pid}/frame", json={
        "t": 1.0, "height": 180, "timeline": {"sequence_id": main["id"], "sequences": [live_main, inner, mid, fresh]}})
    assert r.status_code == 200, r.text
    im = Image.open(__import__("io").BytesIO(r.content)).convert("RGB")
    assert im.getpixel((160, 90))[2] > 150  # blue inside
    assert max(im.getpixel((10, 10))) < 40  # half size: corner empty
