"""Motion tracking: start trackers, poll their status, fetch results."""

from __future__ import annotations

import threading
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..engine import tracking
from ..jobs import jobs
from ..models import Tracker
from .deps import get_project

router = APIRouter(prefix="/api/projects/{project_id}/tracking", tags=["tracking"])

# content key -> job id (one analysis per key, however many clips share it)
_running: dict[str, str] = {}
_guard = threading.Lock()


class TrackRequest(BaseModel):
    asset_id: str
    tracker: Tracker


class TrackStatus(BaseModel):
    tracker_id: str
    key: str
    state: Literal["done", "tracking", "queued", "error", "none"]
    progress: float = 0.0
    error: Optional[str] = None
    job_id: Optional[str] = None


def _status(project_id: str, asset, tracker: Tracker) -> TrackStatus:
    k = tracking.key(asset, tracker)
    st = TrackStatus(tracker_id=tracker.id, key=k, state="none")
    if tracking.result_path(project_id, k).is_file():
        st.state, st.progress = "done", 1.0
        return st
    with _guard:
        jid = _running.get(k)
    job = jobs.get(jid) if jid else None
    if job is not None:
        st.job_id = job.id
        if job.status in ("queued", "running"):
            st.state = "tracking" if job.status == "running" else "queued"
            st.progress = job.progress
        elif job.status == "error":
            st.state, st.error = "error", job.error
    return st


@router.post("/status", response_model=list[TrackStatus])
def status(project_id: str, items: list[TrackRequest]):
    project = get_project(project_id)
    out = []
    for it in items:
        asset = project.asset(it.asset_id)
        if asset is not None:
            out.append(_status(project_id, asset, it.tracker))
    return out


@router.post("/run", response_model=TrackStatus)
def run(project_id: str, body: TrackRequest):
    """Analyse a tracker (no-op when this exact tracker was analysed before)."""
    project = get_project(project_id)
    asset = project.asset(body.asset_id)
    if asset is None or asset.kind != "video":
        raise HTTPException(400, "Only video clips can be tracked")
    if asset.status != "ready":
        raise HTTPException(409, "The video is still processing")
    st = _status(project_id, asset, body.tracker)
    if st.state in ("done", "tracking", "queued"):
        return st
    k, tracker = st.key, body.tracker

    def job(ctx):
        # The job stays registered afterwards so a failure is reported (a new run replaces it).
        tracking.run(project_id, asset, tracker, lambda p: ctx.progress(p))
        return {"key": k}

    names = {"point": "position", "transform": "position, rotation & scale",
             "corner_pin": "corner pin", "stabilize": "stabilize"}
    j = jobs.submit("track", job, project_id=project_id, label=f"Tracking ({names[tracker.kind]})")
    with _guard:
        _running[k] = j.id
    return _status(project_id, asset, tracker)


@router.get("/result/{key}")
def result(project_id: str, key: str):
    get_project(project_id)
    if not key.isalnum():
        raise HTTPException(404, "Not tracked")
    data = tracking.load(project_id, key)
    if data is None:
        raise HTTPException(404, "Not tracked")
    return data
