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

    # frame: blue in the centre (half scale), black at the corner
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
