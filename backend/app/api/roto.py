"""Roto brush: instant single-frame previews, tracking jobs and their status."""

from __future__ import annotations

import threading
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..engine import roto
from ..jobs import jobs
from ..models import Roto, RotoPrompt
from .deps import get_project

router = APIRouter(prefix="/api", tags=["roto"])

_running: dict[str, str] = {}  # content key -> job id
_by_clip: dict[str, str] = {}  # project/clip -> key of its latest run (older ones get cancelled)
_guard = threading.Lock()


@router.get("/roto/info")
def info():
    return {"available": roto.available()}


def _video(project, asset_id: str):
    if not roto.available():
        raise HTTPException(503, "The roto brush model isn't installed on this server")
    asset = project.asset(asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(400, "The roto brush works on video clips")
    if asset.status != "ready":
        raise HTTPException(409, "The video is still processing")
    return asset


class PreviewRequest(BaseModel):
    asset_id: str
    prompt: RotoPrompt


@router.post("/projects/{project_id}/roto/preview")
def preview(project_id: str, body: PreviewRequest):
    """The selection on one frame (grey PNG at mask resolution)."""
    project = get_project(project_id)
    asset = _video(project, body.asset_id)
    try:
        png = roto.preview(project_id, asset, body.prompt)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


class RunRequest(BaseModel):
    clip_id: str
    asset_id: str
    roto: Roto


class RotoStatus(BaseModel):
    clip_id: str
    key: str
    state: Literal["done", "tracking", "queued", "error", "none"]
    progress: float = 0.0
    error: Optional[str] = None


def _status(project_id: str, clip_id: str, asset, r: Roto) -> RotoStatus:
    k = roto.key(asset, r)
    st = RotoStatus(clip_id=clip_id, key=k, state="none")
    if roto.load_meta(project_id, k) is not None:
        st.state, st.progress = "done", 1.0
        return st
    with _guard:
        jid = _running.get(k)
    job = jobs.get(jid) if jid else None
    if job is not None:
        if job.status in ("queued", "running"):
            st.state = "tracking" if job.status == "running" else "queued"
            st.progress = job.progress
        elif job.status == "error":
            st.state, st.error = "error", job.error
    return st


@router.post("/projects/{project_id}/roto/status", response_model=list[RotoStatus])
def status(project_id: str, items: list[RunRequest]):
    project = get_project(project_id)
    return [_status(project_id, it.clip_id, a, it.roto) for it in items if (a := project.asset(it.asset_id))]


@router.post("/projects/{project_id}/roto/run", response_model=RotoStatus)
def run(project_id: str, body: RunRequest):
    """Follow the selection through the clip (no-op if this exact selection was done)."""
    project = get_project(project_id)
    asset = _video(project, body.asset_id)
    if not any(p.box or p.points for p in body.roto.prompts):
        raise HTTPException(400, "Select the object first")
    st = _status(project_id, body.clip_id, asset, body.roto)
    if st.state in ("done", "tracking", "queued"):
        return st
    k, r = st.key, body.roto
    clip_ref = f"{project_id}/{body.clip_id}"
    with _guard:
        old = _by_clip.get(clip_ref)
        if old and old != k and old in _running:
            jobs.cancel(_running[old])  # the selection changed: that analysis is outdated
        _by_clip[clip_ref] = k

    def job(ctx):
        roto.run(project_id, asset, r, lambda p: ctx.progress(p), lambda: ctx.cancelled)
        return {"key": k}

    j = jobs.submit("roto", job, project_id=project_id, label="Roto brush")
    with _guard:
        _running[k] = j.id
    return _status(project_id, body.clip_id, asset, r)
