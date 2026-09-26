"""Multiple sequences per project (phase 1: no nesting)."""

from __future__ import annotations

import io
import json
import subprocess

from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


def _colour_image(tmp_path, name, rgb):
    p = tmp_path / name
    Image.new("RGB", (320, 180), rgb).save(p)
    return p


def test_legacy_project_file_is_upgraded(client):
    from app import config, storage
    pid = "p_legacy0001"
    d = config.PROJECTS_DIR / pid
    (d / "media").mkdir(parents=True, exist_ok=True)
    legacy = {
        "id": pid, "name": "Old one", "settings": {"width": 1280, "height": 720, "fps": 25, "background": "#112233"},
        "assets": [], "tracks": [{"id": "t_a", "kind": "video", "name": "V"}],
        "clips": [{"id": "c_1", "track_id": "t_a", "type": "text", "start": 0, "duration": 2, "text": {"content": "x"}}],
    }
    (d / "project.json").write_text(json.dumps(legacy))
    p = client.get(f"/api/projects/{pid}").json()
    assert len(p["sequences"]) == 1 and p["main_sequence_id"] == p["sequences"][0]["id"]
    main = main_seq(p)
    assert main["name"] == "Main" and main["settings"]["width"] == 1280 and main["clips"][0]["id"] == "c_1"
    summary = next(s for s in client.get("/api/projects").json() if s["id"] == pid)
    assert summary["duration"] == 2 and summary["width"] == 1280
    # The upgrade is stable and saved: every later read sees the same sequence,
    # and render requests naming it work (regression: random ids per read).
    again = client.get(f"/api/projects/{pid}").json()
    assert again["sequences"][0]["id"] == main["id"] == "s_main"
    assert '"sequences"' in (d / "project.json").read_text()
    r = client.post(f"/api/projects/{pid}/frame", json={"t": 0.5, "timeline": {"sequence_id": main["id"]}})
    assert r.status_code == 200, r.text
    storage.delete(pid)


def test_sequences_render_independently(client, tmp_path):
    pid = client.post("/api/projects", json={"name": "multi", "width": 640, "height": 360, "fps": 25}).json()["id"]
    red = _upload(client, pid, _colour_image(tmp_path, "red.png", (220, 30, 30)))
    blue = _upload(client, pid, _colour_image(tmp_path, "blue.png", (30, 30, 220)))
    project = _wait_ready(client, pid)
    main = main_seq(project)
    intro = {
        "id": "s_intro", "name": "Intro",
        "settings": {"width": 400, "height": 400, "fps": 30, "background": "#000000"},
        "tracks": [{"id": "t_i", "kind": "video", "name": "V1"}],
        "clips": [{"track_id": "t_i", "type": "image", "asset_id": blue["id"], "start": 0, "duration": 1.5}],
    }
    main["clips"] = [{"track_id": main["tracks"][1]["id"], "type": "image", "asset_id": red["id"], "start": 0, "duration": 3}]
    r = client.put(f"/api/projects/{pid}", json={"sequences": [main, intro]})
    assert r.status_code == 200, r.text
    assert [s["name"] for s in r.json()["sequences"]] == ["Main", "Intro"]

    def frame(seq_id=None):
        body = {"t": 0.5, "height": 400}
        if seq_id:
            body["timeline"] = {"sequence_id": seq_id}
        r = client.post(f"/api/projects/{pid}/frame", json=body)
        assert r.status_code == 200, r.text
        return Image.open(io.BytesIO(r.content)).convert("RGB")

    m, i = frame(), frame("s_intro")
    assert m.size == (640, 360) and m.getpixel((320, 180))[0] > 180  # main: red, 16:9
    assert i.size == (400, 400) and i.getpixel((200, 200))[2] > 180  # intro: blue, square
    # unsaved editor state for a non-main sequence overrides only that sequence
    over = client.post(f"/api/projects/{pid}/frame", json={"t": 0.5, "height": 400, "timeline": {
        "sequence_id": "s_intro", "clips": []}})
    assert max(Image.open(io.BytesIO(over.content)).convert("L").getextrema()) < 20
    assert client.post(f"/api/projects/{pid}/frame", json={"t": 0, "timeline": {"sequence_id": "nope"}}).status_code == 404

    s = client.post(f"/api/projects/{pid}/preview", json={"height": 400, "timeline": {"sequence_id": "s_intro"}}).json()
    assert s["count"] == 1 and client.get(f"/api/preview/{s['key']}/seg_0.ts").status_code == 200

    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low", "sequence_id": "s_intro"})
    assert r.status_code == 200, r.text
    rec = r.json()["export"]
    assert rec["sequence_id"] == "s_intro" and "Intro" in rec["name"] and rec["width"] == 400
    assert _wait_job(client, r.json()["job"]["id"])["status"] == "done"
    mp4 = tmp_path / "intro.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{rec['id']}/download").content)
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          "stream=width,height:format=duration", "-of", "json", str(mp4)], capture_output=True, text=True).stdout
    info = json.loads(out)
    assert (info["streams"][0]["width"], info["streams"][0]["height"]) == (400, 400)
    assert abs(float(info["format"]["duration"]) - 1.5) < 0.1

    # switching the main sequence changes what the dashboard shows
    client.put(f"/api/projects/{pid}", json={"main_sequence_id": "s_intro"})
    summary = next(x for x in client.get("/api/projects").json() if x["id"] == pid)
    assert (summary["width"], summary["duration"]) == (400, 1.5)

    # deleting media removes its clips from every sequence
    client.delete(f"/api/projects/{pid}/media/{blue['id']}")
    p = client.get(f"/api/projects/{pid}").json()
    assert all(c["asset_id"] != blue["id"] for s in p["sequences"] for c in s["clips"])

    # .yabbe round trip keeps every sequence
    pkg = client.get(f"/api/projects/{pid}/package").content
    imported = client.post("/api/projects/import", content=pkg).json()
    assert [s["name"] for s in imported["sequences"]] == ["Main", "Intro"]
    assert imported["main_sequence_id"] == "s_intro"


def test_single_timeline_saves_target_a_sequence(client):
    pid = client.post("/api/projects", json={"name": "legacy api"}).json()["id"]
    p = client.get(f"/api/projects/{pid}").json()
    main = main_seq(p)
    other = {"id": "s_b", "name": "B", "tracks": [{"id": "t_b", "kind": "video"}], "clips": []}
    client.put(f"/api/projects/{pid}", json={"sequences": [main, other]})
    clip = {"track_id": "t_b", "type": "text", "start": 0, "duration": 1, "text": {"content": "b"}}
    r = client.put(f"/api/projects/{pid}", json={"sequence_id": "s_b", "clips": [clip]}).json()
    assert len(next(s for s in r["sequences"] if s["id"] == "s_b")["clips"]) == 1
    assert main_seq(r)["clips"] == []
