"""Separating a video clip's audio into its own clip."""

from __future__ import annotations

import subprocess

from conftest import _upload, _wait_job, _wait_ready, main_seq


def test_separated_audio(client, media_dir):
    """A video clip with its audio separated is silent; the audio clip made from
    the same video file (with its own volume/fade/speed) carries the sound."""
    from app import storage

    pid = client.post("/api/projects", json={"name": "sep", "width": 320, "height": 180, "fps": 25}).json()["id"]
    vid = _upload(client, pid, media_dir / "clip.mp4")
    main = main_seq(_wait_ready(client, pid))
    v1 = main["tracks"][1]["id"]
    a1 = next(t["id"] for t in main["tracks"] if t["kind"] == "audio")

    def loudness(clips):
        seq = {**main, "clips": clips}
        assert client.put(f"/api/projects/{pid}", json={"sequences": [seq]}).status_code == 200
        r = client.post(f"/api/projects/{pid}/exports", json={"quality": "low"})
        _wait_job(client, r.json()["job"]["id"])
        path = storage.exports_dir(pid) / r.json()["export"]["filename"]
        out = subprocess.run(["ffmpeg", "-v", "info", "-i", str(path), "-af", "volumedetect", "-vn", "-f", "null", "-"],
                             capture_output=True, text=True).stderr
        return float(out.split("mean_volume:")[1].split("dB")[0])

    video = {"track_id": v1, "type": "video", "asset_id": vid["id"], "start": 0, "duration": 3}
    whole = loudness([video])
    silent = loudness([{**video, "audio_detached": True}])
    separated = loudness([{**video, "audio_detached": True},
                          {"track_id": a1, "type": "audio", "asset_id": vid["id"], "start": 0, "duration": 3}])
    assert whole > -40 and silent < -80 and abs(separated - whole) < 1.5, (whole, silent, separated)
