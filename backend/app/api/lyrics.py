"""Lyrics: find a song's lyrics and time every word (background job), search
LRCLIB, and re-time one edited line."""

from __future__ import annotations

import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..engine.lyrics import pipeline
from ..jobs import Job, JobContext, jobs
from ..models import LyricLine
from .deps import get_project

router = APIRouter(prefix="/api", tags=["lyrics"])

_running: dict[tuple, str] = {}  # (project, asset, options) -> job id
_guard = threading.Lock()


@router.get("/lyrics/info")
def info():
    return {"available": pipeline.available()}


@router.get("/lyrics/search")
def search(q: str = Query(min_length=1, max_length=300), duration: float = 0):
    try:
        return [c.dict() for c in pipeline.search(query=q.strip(), duration=duration)]
    except pipeline.LyricsError as exc:
        raise HTTPException(502, str(exc)) from None


def _song(project_id: str, asset_id: str):
    project = get_project(project_id)
    asset = project.asset(asset_id)
    if asset is None:
        raise HTTPException(404, "Song not found")
    if not asset.has_audio:
        raise HTTPException(400, "That clip has no sound")
    return asset


@router.get("/projects/{project_id}/lyrics/{asset_id}/guess")
def guess(project_id: str, asset_id: str):
    """What lyrics search would look for (to prefill the search box)."""
    asset = _song(project_id, asset_id)
    track, artist = pipeline.guess(asset)
    return {"query": f"{artist} {track}".strip(), "duration": asset.duration}


class ComputeRequest(BaseModel):
    isolate: bool = False  # isolate the vocals first (slower; better on dense mixes)
    lrclib_id: Optional[int] = None  # a search result the user picked
    text: Optional[str] = Field(None, max_length=60_000)  # lyrics the user pasted (plain or LRC)


@router.post("/projects/{project_id}/lyrics/{asset_id}", response_model=Job)
def compute(project_id: str, asset_id: str, body: ComputeRequest):
    """Find the lyrics (unless given) and time every word. The job's result:
    ``{lines, source, lrclib_id}``."""
    if not pipeline.available():
        raise HTTPException(503, "The lyrics models aren't installed on this server")
    asset = _song(project_id, asset_id)
    key = (project_id, asset_id, body.isolate, body.lrclib_id, hash(body.text))
    with _guard:
        running = jobs.get(_running.get(key, ""))
        if running and running.status in ("queued", "running"):
            return running

    def job(ctx: JobContext):
        ctx.progress(0.0, "Finding the lyrics")
        try:
            if body.text and body.text.strip():
                lines, synced = pipeline.parse(body.text)
                source, lrclib_id = "Your lyrics", None
            else:
                entry = pipeline.fetch(body.lrclib_id) if body.lrclib_id else pipeline.find_best(asset)
                if entry is None:
                    raise RuntimeError("No lyrics found for this song. Search for them or paste them in.")
                if entry.get("instrumental"):
                    return {"lines": [], "source": "Instrumental (no lyrics)", "lrclib_id": entry.get("id")}
                text = entry.get("syncedLyrics") or entry.get("plainLyrics") or ""
                lines, synced = pipeline.parse(text)
                source = f"{entry.get('trackName')} — {entry.get('artistName')} (LRCLIB)"
                lrclib_id = entry.get("id")
        except pipeline.LyricsError as exc:
            raise RuntimeError(str(exc)) from None
        if not lines:
            raise RuntimeError("Those lyrics are empty")
        logp = pipeline.emissions(project_id, asset, body.isolate, ctx.progress)
        ctx.progress(0.9, "Timing the words")
        timed = pipeline.time_words(logp, lines, synced, ctx.progress)
        return {"lines": [ln.model_dump() for ln in timed], "source": source, "lrclib_id": lrclib_id}

    j = jobs.submit("lyrics", job, project_id=project_id, label="Lyrics")
    with _guard:
        _running[key] = j.id
    return j


class RetimeRequest(BaseModel):
    text: str = Field(max_length=2000)
    start: float = Field(ge=0)
    end: float = Field(gt=0)


@router.post("/projects/{project_id}/lyrics/{asset_id}/retime", response_model=LyricLine)
def retime(project_id: str, asset_id: str, body: RetimeRequest):
    """Time the words of one (edited) line inside [start, end] (song seconds).
    Uses what the aligner heard earlier; without it, words are spread evenly."""
    _song(project_id, asset_id)
    end = max(body.end, body.start + 0.2)
    logp = pipeline.cached_emissions(project_id, asset_id)
    if logp is None:
        return pipeline.untimed_line(body.text, body.start, end)
    return pipeline.retime_line(logp, body.text, body.start, end)
