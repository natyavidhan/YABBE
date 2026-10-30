"""Music search: YouTube search results and adding a song's audio as an MP3 asset.

yt-dlp is replaced with stand-ins, so these run offline; set YABBE_NET_TESTS=1
to also run one real search + download."""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from conftest import _wait_job, _wait_ready


@pytest.fixture
def fake_youtube(monkeypatch, media_dir):
    from app.engine import youtube

    mp3 = media_dir / "song.mp3"
    if not mp3.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=330:d=5", "-q:a", "0", str(mp3)],
                       check=True)
    metas = {
        "dQw4w9WgXcQ": {"id": "dQw4w9WgXcQ", "title": "A / great: song?", "duration": 5},
        "LongLongLon": {"id": "LongLongLon", "title": "10 hour mix", "duration": 36000},
        "LiveStream1": {"id": "LiveStream1", "title": "radio", "duration": None, "is_live": True},
    }
    monkeypatch.setattr(youtube, "search", lambda q, limit: [
        {"id": "dQw4w9WgXcQ", "title": f"{q} result", "channel": "Someone", "duration": 5.0,
         "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"}])

    def info(vid):
        if vid not in metas:
            raise youtube.YouTubeError("Video unavailable")
        return metas[vid]

    def download(meta, out_dir, on_progress):
        on_progress(0.5, "Downloading")
        shutil.copy(mp3, out_dir / "audio.mp3")
        return out_dir / "audio.mp3"

    monkeypatch.setattr(youtube, "info", info)
    monkeypatch.setattr(youtube, "download_mp3", download)


def test_search_and_add(client, fake_youtube):
    pid = client.post("/api/projects", json={"name": "music"}).json()["id"]
    assert client.get("/api/music/info").json()["available"] is True
    r = client.get("/api/music/search", params={"q": "lofi"})
    assert r.status_code == 200 and r.json()[0]["title"] == "lofi result"

    job = _wait_job(client, client.post(f"/api/projects/{pid}/media/youtube",
                                        json={"video_id": "dQw4w9WgXcQ"}).json()["id"])
    assert job["status"] == "done", job
    project = _wait_ready(client, pid)
    [asset] = project["assets"]
    assert asset["id"] == job["result"]["asset_id"]
    assert asset["kind"] == "audio" and asset["original_name"] == "A great song.mp3"
    assert asset["filename"].endswith(".mp3") and 4.5 < asset["duration"] < 5.5
    assert client.get(f"/api/projects/{pid}/media/{asset['id']}/waveform").status_code == 200


def test_refused_downloads(client, fake_youtube):
    pid = client.post("/api/projects", json={"name": "music2"}).json()["id"]
    assert client.post(f"/api/projects/{pid}/media/youtube", json={"video_id": "not an id"}).status_code == 422
    for vid, why in (("LongLongLon", "Too long"), ("LiveStream1", "Live"), ("Missing0000", "unavailable")):
        job = _wait_job(client, client.post(f"/api/projects/{pid}/media/youtube", json={"video_id": vid}).json()["id"])
        assert job["status"] == "error" and why in job["error"], job
    assert client.get(f"/api/projects/{pid}").json()["assets"] == []


def test_turned_off(client, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "MUSIC_SEARCH", False)
    assert client.get("/api/music/info").json()["available"] is False
    assert client.get("/api/music/search", params={"q": "x"}).status_code == 404


@pytest.mark.skipif(os.environ.get("YABBE_NET_TESTS") != "1", reason="needs the internet (YABBE_NET_TESTS=1)")
def test_real_youtube(client):
    pid = client.post("/api/projects", json={"name": "real"}).json()["id"]
    results = client.get("/api/music/search", params={"q": "free lofi beat no copyright"}).json()
    vid = next(r["id"] for r in results if r["duration"] < 300)
    job = _wait_job(client, client.post(f"/api/projects/{pid}/media/youtube", json={"video_id": vid}).json()["id"],
                    timeout=300)
    assert job["status"] == "done", job
    asset = _wait_ready(client, pid)["assets"][0]
    assert asset["kind"] == "audio" and asset["filename"].endswith(".mp3")


def test_song_and_artist_from_video_titles():
    from app.engine.youtube import song_of
    assert song_of({"title": "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
                    "channel": "Rick Astley"}) == ("Never Gonna Give You Up", "Rick Astley")
    assert song_of({"title": "Daft Punk - One More Time (Official Video)", "channel": "DaftPunkVEVO"}) == \
        ("One More Time", "Daft Punk")
    assert song_of({"title": "Blinding Lights", "channel": "The Weeknd - Topic"}) == ("Blinding Lights", "The Weeknd")
    assert song_of({"title": "x", "track": "Kesariya", "artist": "Arijit Singh"}) == ("Kesariya", "Arijit Singh")
    # someone else's upload: the title stays as it is, artist unknown
    assert song_of({"title": "Rick Astley - Never Gonna Give You Up [Lyrics]", "channel": "Lyric Vibes"}) == \
        ("Rick Astley - Never Gonna Give You Up", None)
