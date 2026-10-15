"""Lyrics for a song: find them, time every word, keep the result.

1. Lyrics come from LRCLIB (free, open database, line-synced LRC), found from
   the song's title / artist (YouTube metadata, file tags or the file name) and
   its length - or the user picks a search result or pastes their own (plain
   text or LRC).
2. Optionally the vocals are isolated first (:mod:`separate`; slower).
3. The aligner (:mod:`align`) hears the song once (its output is cached, so
   re-timing after an edit takes seconds), then every line's words are aligned
   inside that line's LRC time window (repeated choruses can't swap places).
   The whole song is aligned once first to measure how far the LRC is shifted
   against this recording (e.g. a music video with an intro). Lines the
   audio doesn't support keep their LRC timing, words spread by length.
   Plain lyrics (no times) are aligned over the whole song.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from ... import config, storage
from ...models import Asset, LyricLine, LyricWord
from .. import media
from . import align, separate

LRCLIB = "https://lrclib.net/api"
USER_AGENT = "YABBE video editor (https://github.com/natyavidhan/YABBE)"
VERSION = "a1"
MIN_CONF = 0.2  # lines aligned less surely than this keep their LRC timing

Progress = Callable[[float, Optional[str]], None]


class LyricsError(Exception):
    pass


def available() -> bool:
    d = config.MODELS_DIR / "lyrics"
    return all((d / f).is_file() for f in ("aligner.onnx", "vocab.json", "vocals.onnx"))


# -- finding lyrics --------------------------------------------------------------------------

def _get(path: str, params: dict, tries: int = 3) -> object:
    url = f"{LRCLIB}/{path}?{urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, '')})}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.loads(res.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if (exc.code >= 500 or exc.code == 429) and attempt + 1 < tries:
                try:
                    wait = float(exc.headers.get("Retry-After") or 0)
                except ValueError:
                    wait = 0
                time.sleep(min(10.0, wait or 2.0 * (attempt + 1)))
                continue
            raise LyricsError(f"LRCLIB is having trouble ({exc.code} {exc.reason}); try again in a bit") from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            if attempt + 1 < tries:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise LyricsError(f"Couldn't reach LRCLIB ({getattr(exc, 'reason', exc)})") from None
    return None


@dataclass
class Candidate:
    id: int
    track: str
    artist: str
    album: str
    duration: float
    synced: bool
    instrumental: bool
    preview: str

    def dict(self) -> dict:
        return self.__dict__.copy()


def _candidate(e: dict) -> Candidate:
    plain = e.get("plainLyrics") or ""
    return Candidate(
        id=int(e["id"]), track=e.get("trackName") or "", artist=e.get("artistName") or "",
        album=e.get("albumName") or "", duration=float(e.get("duration") or 0),
        synced=bool(e.get("syncedLyrics")), instrumental=bool(e.get("instrumental")),
        preview=" / ".join([ln for ln in plain.splitlines() if ln.strip()][:2])[:160],
    )


def search(query: str = "", track: str = "", artist: str = "", duration: float = 0) -> list[Candidate]:
    """LRCLIB matches: synced ones whose length fits first."""
    params = {"q": query} if query else {"track_name": track, "artist_name": artist}
    res = _get("search", params) or []
    out = [_candidate(e) for e in res if isinstance(e, dict) and e.get("id")]

    def rank(c: Candidate):
        off = abs(c.duration - duration) if duration and c.duration else 30
        return (not (c.synced or c.instrumental), min(off, 30) > 6, off, -len(c.preview))

    out.sort(key=rank)
    # the same song is often listed many times: keep a few per (track, artist, ~length)
    seen: dict[tuple, int] = {}
    kept = []
    for c in out:
        key = (c.track.lower(), c.artist.lower(), round(c.duration / 4), c.synced)
        seen[key] = seen.get(key, 0) + 1
        if seen[key] <= 1:
            kept.append(c)
    return kept[:25]


def fetch(lrclib_id: int) -> dict:
    e = _get(f"get/{int(lrclib_id)}", {})
    if not isinstance(e, dict):
        raise LyricsError("Those lyrics are no longer on LRCLIB")
    return e


_JUNK = re.compile(
    r"[\(\[](?:[^)\]]*?(?:official|video|audio|lyric|lyrics|visuali[sz]er|hd|4k|mv|m/v|remaster(?:ed)?|live|"
    r"full song|explicit|clean|from|ft\.|feat\.)[^)\]]*)[\)\]]", re.I)


def guesses(asset: Asset) -> list[dict]:
    """Searches to try, most likely first: (track, artist) readings of the
    title, then free-text queries."""
    out: list[dict] = []

    def add(**kw):
        kw = {k: v.strip() for k, v in kw.items() if v and v.strip()}
        if kw and kw not in out:
            out.append(kw)

    artist = (asset.song_artist or "").strip()
    title = _clean_title(asset.song_title or Path(asset.original_name).stem)
    parts = [p for p in re.split(r"\s+[-–—]\s+|\s*\|\s*", title)
             if p.strip() and not _JUNK_PART.fullmatch(p.strip())]
    if asset.song_title and artist and len(parts) == 1:
        add(track=title, artist=artist)
    if len(parts) >= 2:
        a, b = parts[0], parts[1]
        if artist:
            add(track=b if a.lower() == artist.lower() else a, artist=artist)
        add(track=b, artist=a)  # "Artist - Title"
        add(track=a, artist=b)  # "Title - Artist"
        add(query=f"{a} {parts[-1]}" if len(parts) > 2 else f"{a} {b}")
        add(query=a)
    else:
        add(track=title, artist=artist)
        add(query=f"{artist} {title}")
    return out


def guess(asset: Asset) -> tuple[str, str]:
    g = guesses(asset)[0]
    return g.get("track") or g.get("query", ""), g.get("artist", "")


_JUNK_PART = re.compile(r"(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?(?:\s*video)?)|4k|hd|hq|8k|1080p|"
                        r"full\s*(?:song|video)|visuali[sz]er|explicit|remaster(?:ed)?", re.I)


def _clean_title(t: str) -> str:
    t = _JUNK.sub("", t)
    t = re.sub(r"\s+(?:ft|feat)\.?\s.*$", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" -|")


def find_best(asset: Asset) -> Optional[dict]:
    """The best LRCLIB entry for a song (synced, about as long), or None."""
    fallback: Optional[Candidate] = None
    for g in guesses(asset):
        found = search(duration=asset.duration, **g)
        for c in found:
            fits = not asset.duration or not c.duration or abs(c.duration - asset.duration) <= max(8.0, asset.duration * 0.06)
            if fits and (c.synced or c.instrumental):
                return fetch(c.id)
            if fits and fallback is None:
                fallback = c
    return fetch(fallback.id) if fallback else None


# -- parsing ---------------------------------------------------------------------------------

_TIME = re.compile(r"\[(\d+):(\d+(?:[.:]\d+)?)\]")
_WORD_TIME = re.compile(r"<(\d+):(\d+(?:\.\d+)?)>")


def parse(text: str) -> tuple[list[tuple[Optional[float], str]], bool]:
    """LRC or plain text → [(time or None, line)], synced?"""
    out: list[tuple[Optional[float], str]] = []
    synced = False
    for raw in text.splitlines():
        stamps = _TIME.findall(raw)
        body = _TIME.sub("", raw)
        body = _WORD_TIME.sub("", body).strip()
        if re.fullmatch(r"\[[a-z]+:.*\]", raw.strip(), re.I):
            continue  # [ar: ...] metadata
        if stamps:
            synced = True
            for m, s in stamps:
                out.append((int(m) * 60 + float(s.replace(":", ".")), body))
        elif body:
            out.append((None, body))
    if synced:
        out = sorted([(t, b) for t, b in out if t is not None], key=lambda x: x[0])
    return out, synced


# -- timing ----------------------------------------------------------------------------------

def _cache_dir(project_id: str) -> Path:
    d = storage.project_dir(project_id) / "lyrics"
    d.mkdir(parents=True, exist_ok=True)
    return d


def emissions(project_id: str, asset: Asset, isolate: bool, progress: Progress) -> np.ndarray:
    """The aligner's view of the song (cached per song and vocal setting)."""
    path = _cache_dir(project_id) / f"{asset.id}.{'vocals' if isolate else 'mix'}.{VERSION}.npy"
    if path.is_file():
        return np.load(path).astype(np.float32)
    src = media.source_path(project_id, asset)
    if isolate:
        progress(0.02, "Isolating the vocals")
        mix = separate.decode(src, separate.SR, 2)
        sess = separate.session()
        vocals = separate.vocals(mix, sess, lambda f: progress(0.02 + 0.5 * f, "Isolating the vocals"))
        del sess, mix
        audio = _resample_mono(vocals)
        del vocals
        lo = 0.55
    else:
        audio = separate.decode(src, align.SR, 1)[0]
        lo = 0.05
    progress(lo, "Listening to the song")
    sess = align.session()
    logp = align.emissions(audio, sess, lambda f: progress(lo + (0.9 - lo) * f, "Listening to the song"))
    del sess
    tmp = path.with_suffix(".tmp.npy")
    np.save(tmp, logp.astype(np.float16))
    tmp.replace(path)
    return logp


def _resample_mono(stereo44: np.ndarray) -> np.ndarray:
    from .. import ffmpeg

    raw = ffmpeg.run(["-f", "f32le", "-ar", str(separate.SR), "-ac", "2", "-i", "-", "-f", "f32le", "-ac", "1",
                      "-ar", str(align.SR), "-"], input_bytes=np.ascontiguousarray(stereo44.T).tobytes(), timeout=600)
    return np.frombuffer(raw, np.float32).copy()


def _conf(score: float) -> float:
    """Mean peak log-probability of a word's letters → 0..1. Calibrated on sung
    vocals: clearly sung lines score about -1 to -3, background "ooh"s and
    fade-outs below -6."""
    return float(max(0.0, min(1.0, (score + 7.0) / 6.0)))


def _spread(words: list[str], a: float, b: float) -> list[LyricWord]:
    """Words spread over [a, b] by length (no audio evidence)."""
    weights = [max(1, len(align.spell(w)) or len(w)) + 1 for w in words]
    total = sum(weights)
    out, t = [], a
    for w, k in zip(words, weights):
        d = (b - a) * k / total
        out.append(LyricWord(text=w, start=round(t, 3), end=round(t + d * 0.9, 3), conf=0.0))
        t += d
    return out


def _line(text: str, words: list[LyricWord]) -> LyricLine:
    return LyricLine(text=text, start=words[0].start if words else 0.0,
                     end=words[-1].end if words else 0.0, words=words)


def time_words(logp: np.ndarray, lines: list[tuple[Optional[float], str]], synced: bool,
               progress: Optional[Progress] = None) -> list[LyricLine]:
    """Word timing for lyric lines (see the module docs)."""
    fps = align.FPS
    T = logp.shape[0]
    song_len = T / fps
    split = [(t, txt, align.split_words(txt)) for t, txt in lines if txt.strip()]
    if not split:
        return []
    flat = [w for _, _, ws in split for w in ws]
    whole = align.align_words(logp, flat)

    if not synced:
        out, k = [], 0
        for _, txt, ws in split:
            times = whole[k:k + len(ws)]
            k += len(ws)
            words = []
            for i, (w, wt) in enumerate(zip(ws, times)):
                if wt is not None:
                    words.append(LyricWord(text=w, start=round(wt.start, 3), end=round(wt.end, 3), conf=_conf(wt.score)))
                else:  # nothing to hear (a symbol): just after the previous word
                    t = words[-1].end if words else 0.0
                    words.append(LyricWord(text=w, start=t, end=t + 0.2, conf=0.0))
            out.append(_line(txt, words))
        return out

    # how far the LRC is shifted against this recording
    diffs, k = [], 0
    for t, _, ws in split:
        first = next((x for x in whole[k:k + len(ws)] if x is not None), None)
        if first is not None and first.score > -1.5:
            diffs.append(first.start - t)
        k += len(ws)
    shift = float(np.median(diffs)) if len(diffs) >= 3 else 0.0

    out: list[LyricLine] = []
    prev_end = 0.0
    for n, (t, txt, ws) in enumerate(split):
        start = t + shift
        nxt = split[n + 1][0] + shift if n + 1 < len(split) else min(song_len, start + max(6.0, len(ws) * 0.6))
        a = max(prev_end - 0.1, start - 1.0, 0.0)
        b = min(song_len, max(nxt + 1.0, a + 0.5))
        f0, f1 = int(a * fps), int(np.ceil(b * fps))
        times = align.align_words(logp[f0:f1], ws, t0=f0 / fps) if f1 > f0 else [None] * len(ws)
        scores = [x.score for x in times if x is not None]
        line_conf = _conf(float(np.mean(scores))) if scores else 0.0
        if line_conf < MIN_CONF:
            end = min(nxt, start + max(1.0, len(ws) * 0.45)) if nxt > start else start + max(1.0, len(ws) * 0.45)
            words = _spread(ws, max(start, 0.0), end)
        else:
            words = []
            for w, wt in zip(ws, times):
                if wt is not None:
                    words.append(LyricWord(text=w, start=round(wt.start, 3), end=round(wt.end, 3), conf=_conf(wt.score)))
                else:
                    tt = words[-1].end if words else a
                    words.append(LyricWord(text=w, start=round(tt, 3), end=round(tt + 0.2, 3), conf=0.0))
        out.append(_line(txt, words))
        prev_end = words[-1].end if words else prev_end
        if progress:
            progress(0.9 + 0.1 * (n + 1) / len(split), "Timing the words")
    return out


def untimed_line(text: str, a: float, b: float) -> LyricLine:
    """A line with its words spread over [a, b] (nothing heard to go by)."""
    ws = align.split_words(text)
    return _line(text, _spread(ws, a, b)) if ws else LyricLine(text=text, start=a, end=b)


def retime_line(logp: np.ndarray, text: str, a: float, b: float) -> LyricLine:
    """Re-time one (edited) line inside [a, b] seconds."""
    ws = align.split_words(text)
    fps = align.FPS
    f0, f1 = max(0, int(a * fps)), min(logp.shape[0], int(np.ceil(b * fps)))
    times = align.align_words(logp[f0:f1], ws, t0=f0 / fps) if f1 > f0 else [None] * len(ws)
    if not ws:
        return LyricLine(text=text, start=a, end=b, words=[])
    scores = [x.score for x in times if x is not None]
    if not scores or _conf(float(np.mean(scores))) < MIN_CONF:
        return _line(text, _spread(ws, a, b))
    words = []
    for w, wt in zip(ws, times):
        if wt is not None:
            words.append(LyricWord(text=w, start=round(wt.start, 3), end=round(wt.end, 3), conf=_conf(wt.score)))
        else:
            tt = words[-1].end if words else a
            words.append(LyricWord(text=w, start=round(tt, 3), end=round(tt + 0.2, 3), conf=0.0))
    return _line(text, words)


def cached_emissions(project_id: str, asset_id: str) -> Optional[np.ndarray]:
    d = _cache_dir(project_id)
    for kind in ("vocals", "mix"):
        p = d / f"{asset_id}.{kind}.{VERSION}.npy"
        if p.is_file():
            return np.load(p).astype(np.float32)
    return None


def clear(project_id: str, asset_id: str) -> None:
    d = storage.project_dir(project_id) / "lyrics"
    if d.is_dir():
        for p in d.glob(f"{asset_id}.*"):
            p.unlink(missing_ok=True)
