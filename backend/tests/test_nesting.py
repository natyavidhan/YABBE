"""Sequences inside sequences (phase 2)."""

from __future__ import annotations

import io
import json
import subprocess

from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


def _seq(sid, name, clips, w=320, h=180, tracks=None):
    return {"id": sid, "name": name, "settings": {"width": w, "height": h, "fps": 25, "background": "#000000"},
            "tracks": tracks or [{"id": f"{sid}_v", "kind": "video"}, {"id": f"{sid}_a", "kind": "audio"}], "clips": clips}


def _frame(client, pid, t, xy=None, seq=None, height=180):
    body = {"t": t, "height": height}
    if seq:
        body["timeline"] = {"sequence_id": seq}
    r = client.post(f"/api/projects/{pid}/frame", json=body)
    assert r.status_code == 200, r.text
    im = Image.open(io.BytesIO(r.content)).convert("RGB")
    return im if xy is None else im.getpixel(xy)


def test_nesting(client, tmp_path):
    blue, red = tmp_path / "b.png", tmp_path / "r.png"
    Image.new("RGB", (320, 180), (30, 30, 220)).save(blue)
    Image.new("RGB", (320, 180), (220, 30, 30)).save(red)
    tone = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=500:d=4", str(tone)], check=True)
    pid = client.post("/api/projects", json={"name": "nest", "width": 320, "height": 180, "fps": 25}).json()["id"]
    b = _upload(client, pid, blue)
    r_ = _upload(client, pid, red)
    snd = _upload(client, pid, tone)
    project = _wait_ready(client, pid)
    main = main_seq(project)
    vt = main["tracks"][1]["id"]

    inner = _seq("s_inner", "Inner", [
        {"track_id": "s_inner_v", "type": "image", "asset_id": b["id"], "start": 0, "duration": 2},
        {"track_id": "s_inner_v", "type": "image", "asset_id": r_["id"], "start": 2, "duration": 2},
        {"track_id": "s_inner_a", "type": "audio", "asset_id": snd["id"], "start": 0, "duration": 4},
    ])
    middle = _seq("s_mid", "Middle", [
        {"track_id": "s_mid_v", "type": "sequence", "sequence_id": "s_inner", "start": 0, "duration": 4},
    ])
    main["clips"] = [
        # nested at half scale from 0-4 s
        {"track_id": vt, "type": "sequence", "sequence_id": "s_inner", "start": 0, "duration": 4,
         "transform": {"scale": 0.5}},
        # two levels deep, trimmed (in 2 s) and double speed, 4-5 s -> red section
        {"track_id": vt, "type": "sequence", "sequence_id": "s_mid", "start": 4, "duration": 1, "in_point": 2, "speed": 2},
    ]
    r = client.put(f"/api/projects/{pid}", json={"sequences": [main, inner, middle]})
    assert r.status_code == 200, r.text
    assert len(main_seq(r.json())["clips"]) == 2

    # frame: blue in the centre (half scale), black (parent background) at the corner
    assert _frame(client, pid, 1.0, (160, 90))[2] > 180
    assert max(_frame(client, pid, 1.0, (10, 10))) < 30
    # inner switches to red at its 2 s
    assert _frame(client, pid, 2.5, (160, 90))[0] > 180
    # two levels deep with in-point + speed: parent 4.2 s -> inner 2.4 s -> red, full frame
    assert _frame(client, pid, 4.2, (10, 10))[0] > 180

    # editing the inner sequence changes the parent's render (fingerprint includes it)
    inner["clips"][0]["asset_id"] = r_["id"]
    client.put(f"/api/projects/{pid}", json={"sequences": [main, inner, middle]})
    assert _frame(client, pid, 1.0, (160, 90))[0] > 180

    # a sequence inside itself is refused (directly and through another)
    loop_inner = json.loads(json.dumps(inner))
    loop_inner["clips"].append({"track_id": "s_inner_v", "type": "sequence", "sequence_id": "s_mid", "start": 5, "duration": 1})
    r = client.put(f"/api/projects/{pid}", json={"sequences": [main, loop_inner, middle]})
    assert r.status_code == 400 and "inside itself" in r.text
    self_ref = json.loads(json.dumps(inner))
    self_ref["clips"].append({"track_id": "s_inner_v", "type": "sequence", "sequence_id": "s_inner", "start": 5, "duration": 1})
    r = client.put(f"/api/projects/{pid}", json={"sequences": [main, self_ref, middle]})
    saved_inner = next(s for s in r.json()["sequences"] if s["id"] == "s_inner")
    assert all(c["type"] != "sequence" for c in saved_inner["clips"])  # dropped

    # HLS preview across the nested clips
    s = client.post(f"/api/projects/{pid}/preview", json={"height": 180}).json()
    for n in range(s["count"]):
        assert client.get(f"/api/preview/{s['key']}/seg_{n}.ts").status_code == 200

    # export: picture and the nested sequence's sound come through
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low"})
    job = _wait_job(client, r.json()["job"]["id"], timeout=240)
    assert job["status"] == "done", job
    mp4 = tmp_path / "nest.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                                      "-of", "json", str(mp4)], capture_output=True, text=True).stdout)
    assert abs(float(info["format"]["duration"]) - 5) < 0.15
    level = subprocess.run(["ffmpeg", "-v", "info", "-ss", "0.5", "-t", "1", "-i", str(mp4), "-af", "volumedetect",
                            "-f", "null", "-"], capture_output=True, text=True).stderr
    assert float(level.split("mean_volume:")[1].split("dB")[0]) > -40  # tone from the nested sequence
    still = tmp_path / "s.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(mp4), "-frames:v", "1", str(still)], check=True)
    assert Image.open(still).convert("RGB").getpixel((160, 90))[0] > 150


def test_nested_background_is_transparent(client, tmp_path):
    """Like an After Effects precomp: only the nested sequence's content shows;
    its background colour doesn't cover what's underneath."""
    green = tmp_path / "g.png"
    Image.new("RGB", (320, 180), (30, 200, 30)).save(green)
    pid = client.post("/api/projects", json={"name": "alpha", "width": 320, "height": 180, "fps": 25}).json()["id"]
    g = _upload(client, pid, green)
    main = main_seq(_wait_ready(client, pid))
    top, bottom = main["tracks"][0]["id"], main["tracks"][1]["id"]
    overlay = _seq("s_ov", "Lower third", [
        {"track_id": "s_ov_v", "type": "text", "start": 0, "duration": 3, "text": {"content": "LOWER", "size": 40},
         "transform": {"y": 60}},
    ])
    overlay["settings"]["background"] = "#ff00ff"  # must NOT show when nested
    main["clips"] = [
        {"track_id": bottom, "type": "image", "asset_id": g["id"], "start": 0, "duration": 3},
        {"track_id": top, "type": "sequence", "sequence_id": "s_ov", "start": 0, "duration": 3},
    ]
    assert client.put(f"/api/projects/{pid}", json={"sequences": [main, overlay]}).status_code == 200
    corner = _frame(client, pid, 1.0, (20, 20))
    assert corner[1] > 150 and corner[0] < 90, corner  # green photo shows through, no magenta
    text_px = _frame(client, pid, 1.0)
    assert max(p[0] + p[1] + p[2] for p in text_px.crop((100, 130, 220, 170)).getdata()) > 600  # white text drawn
    # also in rendered playback segments / exports (FFV1 with alpha)
    r = client.post(f"/api/projects/{pid}/exports", json={"quality": "high"})
    assert _wait_job(client, r.json()["job"]["id"])["status"] == "done"
    mp4 = tmp_path / "a.mp4"
    mp4.write_bytes(client.get(f"/api/projects/{pid}/exports/{r.json()['export']['id']}/download").content)
    png = tmp_path / "a.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(mp4), "-frames:v", "1", str(png)], check=True)
    px = Image.open(png).convert("RGB").getpixel((20, 20))
    assert px[1] > 150 and px[0] < 90, px
    # opened on its own, the sequence still uses its background colour
    own = _frame(client, pid, 1.0, (20, 20), seq="s_ov")
    assert own[0] > 200 and own[2] > 200 and own[1] < 60, own
