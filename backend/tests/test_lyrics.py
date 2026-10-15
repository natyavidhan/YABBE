"""Lyrics: parsing, word timing (on synthetic aligner output), the API, and
drawing lyrics clips in every layout / word effect / box style."""

from __future__ import annotations

import io
import itertools
import subprocess

import numpy as np
import pytest
from PIL import Image

from conftest import _upload, _wait_job, _wait_ready, main_seq


def _models():
    from app.engine.lyrics import pipeline

    return pipeline.available()


needs_models = pytest.mark.skipif(not _models(), reason="lyrics models not installed (models/lyrics)")


# -- parsing / guessing ------------------------------------------------------------------------

def test_parse_lrc_and_plain():
    from app.engine.lyrics.pipeline import parse

    lines, synced = parse("[ar: Someone]\n[00:12.50]First line\n[00:20.00][01:00.00]Chorus <00:20.40>word\n\n[00:15.1]Second")
    assert synced
    assert lines == [(12.5, "First line"), (15.1, "Second"), (20.0, "Chorus word"), (60.0, "Chorus word")]
    lines, synced = parse("Just\nplain lyrics\n")
    assert not synced and lines == [(None, "Just"), (None, "plain lyrics")]


def test_guesses_from_titles():
    from app.engine.lyrics.pipeline import guesses
    from app.models import Asset

    def g(name, title=None, artist=None):
        return guesses(Asset(id="a", kind="audio", filename="a.mp3", original_name=name, song_title=title,
                             song_artist=artist))

    assert g("x.mp3", "Never Gonna Give You Up (2022 Remaster)", "Rick Astley")[0] == \
        {"track": "Never Gonna Give You Up", "artist": "Rick Astley"}
    assert g("The Weeknd - Blinding Lights (Official Video).mp3")[0] == {"track": "Blinding Lights", "artist": "The Weeknd"}
    k = g("k.mp3", "Kesariya - Brahmāstra | Ranbir Kapoor | Pritam | Arijit Singh | 4K")
    assert {"query": "Kesariya"} in k and all("4K" not in str(x) for x in k)


def test_split_words_and_spelling():
    from app.engine.lyrics import align

    assert align.split_words("Hello,  world!") == ["Hello,", "world!"]
    assert align.split_words("ありがとう") == ["あ", "り", "が", "と", "う"]  # no spaces: per character
    if _models():
        assert align.spell("Héllo,") == "hello"
        assert align.spell("तेरे") == "tere"


# -- word timing on synthetic aligner output -----------------------------------------------------

def _fake_logp(seconds: float, words_at: list[tuple[str, float]]):
    """Aligner output where each word's letters are heard (one per frame) from its time."""
    from app.engine.lyrics import align

    vocab = align._vocab()
    T = int(seconds * align.FPS)
    logp = np.full((T, len(vocab)), -12.0, np.float32)
    logp[:, 0] = 0.0  # blank
    for word, t in words_at:
        f = int(t * align.FPS)
        for c in align.spell(word):
            logp[f, :] = -12.0
            logp[f, vocab[c]] = 0.0
            f += 2
    return logp


@needs_models
def test_time_words_synced_with_shift_and_repeats():
    from app.engine.lyrics.pipeline import time_words

    # the recording is 2 s later than the LRC; the chorus line repeats
    sung = [("never", 12.0), ("gonna", 12.6), ("stop", 13.4),
            ("we", 18.0), ("keep", 18.5), ("going", 19.0),
            ("never", 24.0), ("gonna", 24.6), ("stop", 25.4)]
    logp = _fake_logp(40, sung)
    lines = [(10.0, "Never gonna stop"), (16.0, "We keep going"), (22.0, "Never gonna stop"), (30.0, "la la la")]
    out = time_words(logp, lines, synced=True)
    starts = [round(w.start, 1) for ln in out[:3] for w in ln.words]
    assert starts == [12.0, 12.6, 13.4, 18.0, 18.5, 19.0, 24.0, 24.6, 25.4], starts
    assert all(w.conf > 0.9 for ln in out[:3] for w in ln.words)
    # nothing sung for the last line: it keeps its (shifted) LRC time, words spread, marked as guessed
    last = out[3]
    assert abs(last.start - 32.0) < 0.2 and all(w.conf == 0 for w in last.words)
    assert last.words[0].start < last.words[1].start < last.words[2].start


@needs_models
def test_time_words_plain_and_retime():
    from app.engine.lyrics.pipeline import retime_line, time_words

    logp = _fake_logp(20, [("hello", 3.0), ("there", 4.0), ("good", 9.0), ("bye", 9.8)])
    out = time_words(logp, [(None, "Hello there"), (None, "Good bye")], synced=False)
    assert [round(w.start, 1) for ln in out for w in ln.words] == [3.0, 4.0, 9.0, 9.8]
    assert out[0].start == out[0].words[0].start and out[1].end == out[1].words[-1].end
    # an edited line is re-timed inside its window
    line = retime_line(logp, "good bye", 8.0, 11.0)
    assert [round(w.start, 1) for w in line.words] == [9.0, 9.8]


# -- API --------------------------------------------------------------------------------------------

@needs_models
def test_lyrics_job_and_retime(client, media_dir, monkeypatch):
    from app.engine.lyrics import pipeline

    pid = client.post("/api/projects", json={"name": "lyr"}).json()["id"]
    song = _upload(client, pid, media_dir / "tone.wav")
    _wait_ready(client, pid)
    logp = _fake_logp(3, [("la", 0.5), ("di", 1.0), ("da", 1.6)])
    calls = []

    def fake_emissions(project_id, asset, isolate, progress):
        calls.append(isolate)
        np.save(pipeline._cache_dir(project_id) / f"{asset.id}.mix.{pipeline.VERSION}.npy", logp.astype(np.float16))
        return logp

    monkeypatch.setattr(pipeline, "emissions", fake_emissions)
    monkeypatch.setattr(pipeline, "find_best", lambda asset: {
        "id": 7, "trackName": "Tone", "artistName": "Test", "syncedLyrics": "[00:00.40]la di da", "instrumental": False})

    job = _wait_job(client, client.post(f"/api/projects/{pid}/lyrics/{song['id']}", json={}).json()["id"])
    assert job["status"] == "done", job
    [line] = job["result"]["lines"]
    assert [round(w["start"], 1) for w in line["words"]] == [0.5, 1.0, 1.6]
    assert job["result"]["source"].startswith("Tone — Test")

    # pasted lyrics, vocals isolated
    job = _wait_job(client, client.post(f"/api/projects/{pid}/lyrics/{song['id']}",
                                        json={"text": "la di\nda", "isolate": True}).json()["id"])
    assert job["status"] == "done" and len(job["result"]["lines"]) == 2 and calls[-1] is True

    r = client.post(f"/api/projects/{pid}/lyrics/{song['id']}/retime", json={"text": "di da", "start": 0.8, "end": 2.5})
    assert r.status_code == 200 and [round(w["start"], 1) for w in r.json()["words"]] == [1.0, 1.6]

    monkeypatch.setattr(pipeline, "find_best", lambda asset: None)
    job = _wait_job(client, client.post(f"/api/projects/{pid}/lyrics/{song['id']}", json={"isolate": False}).json()["id"])
    assert job["status"] == "error" and "No lyrics found" in job["error"]


# -- drawing ----------------------------------------------------------------------------------------

def _frame(client, pid, main, clips, t, h=180):
    r = client.post(f"/api/projects/{pid}/frame",
                    json={"t": t, "height": h, "timeline": {"sequence_id": main["id"], "clips": clips}})
    assert r.status_code == 200, r.text
    return np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")).astype(int)


def _count(im, rgb, tol=60):
    return int((np.abs(im - rgb).max(-1) < tol).sum())


def _lyrics(lines, **style):
    return {"lines": lines, "style": {"size": 40, "outline": 0, "shadow": 0, **style}}


LINES = [
    {"text": "HELLO WORLD", "start": 0.5, "end": 1.6, "words": [
        {"text": "HELLO", "start": 0.5, "end": 1.0}, {"text": "WORLD", "start": 1.1, "end": 1.6}]},
    {"text": "AGAIN", "start": 3.0, "end": 3.6, "words": [{"text": "AGAIN", "start": 3.0, "end": 3.6}]},
]


def test_lyrics_clip_draws_sung_words(client, media_dir):
    pid = client.post("/api/projects", json={"name": "lyrics", "width": 320, "height": 180, "fps": 25}).json()["id"]
    song = _upload(client, pid, media_dir / "tone.wav")
    main = main_seq(_wait_ready(client, pid))
    v = main["tracks"][1]["id"]
    red, blue = "#ff0000", "#0000ff"

    def clip(**kw):
        return {"track_id": v, "type": "lyrics", "asset_id": song["id"], "start": 0, "duration": 3,
                "lyrics": _lyrics(LINES, word_fx="highlight", color=red, past_color=red, upcoming_color=blue,
                                  lead_ms=200, hold_ms=300), **kw}

    im = _frame(client, pid, main, [clip()], t=0.7)  # HELLO sung, WORLD not yet
    assert _count(im, (255, 0, 0)) > 30 and _count(im, (0, 0, 255)) > 30
    im = _frame(client, pid, main, [clip()], t=1.4)  # both sung
    assert _count(im, (255, 0, 0)) > 60 and _count(im, (0, 0, 255)) < 5
    im = _frame(client, pid, main, [clip()], t=2.5)  # between lines: nothing
    assert _count(im, (255, 0, 0)) + _count(im, (0, 0, 255)) < 5

    # the clip maps timeline → song time like an audio clip (in point, speed)
    im = _frame(client, pid, main, [clip(in_point=1.0, speed=2.0)], t=0.0)  # song 1.0: HELLO sung
    assert _count(im, (255, 0, 0)) > 30
    im = _frame(client, pid, main, [clip(start=1.0)], t=0.7)  # before the clip starts
    assert _count(im, (255, 0, 0)) + _count(im, (0, 0, 255)) < 5

    # moved by its transform like any layer: shifted to the right edge
    im = _frame(client, pid, main, [clip(transform={"x": 130})], t=1.4)
    xs = np.nonzero(np.abs(im - (255, 0, 0)).max(-1) < 60)[1]
    assert xs.min() > 170

    # untimed words are spread over the line
    untimed = [{"text": "PLAIN TEXT", "start": 0.0, "end": 2.0, "words": []}]
    im = _frame(client, pid, main, [clip(lyrics=_lyrics(untimed, word_fx="none", color=red))], t=1.0)
    assert _count(im, (255, 0, 0)) > 30


def test_every_style_renders():
    """Every layout × word effect × box × transition makes a script libass draws."""
    from app.engine.lyrics import ass
    from app.models import LyricLine, LyricWord, Lyrics, LyricsStyle

    words = "one two three four five six seven eight nine ten".split()
    lines = []
    t = 0.2
    for n in range(4):
        ws = [LyricWord(text=w, start=t + i * 0.25, end=t + i * 0.25 + 0.2) for i, w in enumerate(words[: 3 + n])]
        lines.append(LyricLine(text=" ".join(w.text for w in ws), start=ws[0].start, end=ws[-1].end, words=ws))
        t = ws[-1].end + 0.3
    combos = itertools.product(
        ("line", "stack", "scroll", "words", "page"),
        ("fill", "highlight", "reveal", "pop", "fade", "bounce", "glow", "none"),
    )
    extras = itertools.cycle([
        dict(box="none", line_in="fade", line_out="fade"),
        dict(box="line", line_in="slide_up", line_out="slide_down", case="upper"),
        dict(box="words", line_in="zoom", line_out="zoom", active_scale=1.2),
        dict(box="active", line_in="drop", line_out="blur", blur=1, anchor="top", align="left"),
        dict(box="none", line_in="slide_left", line_out="none", anchor="middle", align="right", letter_spacing=4),
    ])
    for (layout, fx), extra in zip(combos, extras):
        style = LyricsStyle(layout=layout, word_fx=fx, lines_shown=3, words_shown=2, size=24, **extra)
        script = ass.build(Lyrics(lines=lines, style=style), 320, 180)
        assert script.count("Dialogue:") > 0, (layout, fx)
        path = ass.write(Lyrics(lines=lines, style=style), 320, 180)
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=10:d=6",
             "-vf", f"ass={path}", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            capture_output=True)
        assert out.returncode == 0, (layout, fx, out.stderr[-300:])
        frames = np.frombuffer(out.stdout, np.uint8).reshape(-1, 180, 320)
        assert frames.max() > 100, (layout, fx)  # something was drawn
