"""Preview frames, lazy HLS preview, exports and job status."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import storage
from ..engine import ffmpeg, prerender, render, text
from ..jobs import Job, jobs
from ..models import Project, TextStyle, TimelineUpdate
from .deps import get_project

router = APIRouter(prefix="/api", tags=["render"])


def _with_timeline(project: Project, timeline: Optional[TimelineUpdate]) -> Project:
    """The project viewed as one sequence (``timeline.sequence_id`` or main),
    with unsaved editor state (settings/tracks/clips) overlaid, so previews
    always match what the user sees even before autosave lands."""
    sid = timeline.sequence_id if timeline and timeline.sequence_id else project.main_sequence_id
    if project.sequence(sid) is None:
        raise HTTPException(404, "Sequence not found")
    p = project.model_copy(deep=True)
    p.main_sequence_id = sid
    if timeline is not None:
        seq = p.main
        if timeline.settings is not None:
            seq.settings = timeline.settings
        if timeline.tracks is not None:
            seq.tracks = timeline.tracks
        if timeline.clips is not None:
            seq.clips = timeline.clips
    return p


class FrameRequest(BaseModel):
    t: float = Field(0.0, ge=0)
    height: Optional[int] = Field(None, ge=16, le=4320)
    timeline: Optional[TimelineUpdate] = None


@router.post("/projects/{project_id}/frame")
def frame(project_id: str, body: FrameRequest):
    project = _with_timeline(get_project(project_id), body.timeline)
    try:
        data = render.render_frame(project, body.t, body.height)
    except ffmpeg.FFmpegError as exc:
        raise HTTPException(500, f"Render failed: {exc}") from None
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


class PreviewRequest(BaseModel):
    height: Optional[int] = Field(None, ge=16, le=2160)
    timeline: Optional[TimelineUpdate] = None


@router.post("/projects/{project_id}/preview", response_model=render.PreviewSession)
def preview(project_id: str, body: PreviewRequest):
    project = _with_timeline(get_project(project_id), body.timeline)
    return render.register_preview(project, body.height)


@router.get("/preview/{key}/index.m3u8")
def preview_playlist(key: str):
    try:
        body = render.playlist(key)
    except FileNotFoundError:
        raise HTTPException(404, "Preview session expired") from None
    return PlainTextResponse(body, media_type="application/vnd.apple.mpegurl",
                             headers={"Cache-Control": "no-cache"})


@router.get("/preview/{key}/seg_{n}.ts")
def preview_segment(key: str, n: int):
    try:
        path = render.segment(key, n)
    except FileNotFoundError:
        raise HTTPException(404, "Segment not found") from None
    except ffmpeg.FFmpegError as exc:
        raise HTTPException(500, f"Render failed: {exc}") from None
    return FileResponse(path, media_type="video/mp2t", headers={"Cache-Control": "max-age=3600"})


# -- exports -------------------------------------------------------------------------


class ExportResponse(BaseModel):
    export: render.ExportRecord
    job: Job


@router.post("/projects/{project_id}/exports", response_model=ExportResponse)
def start_export(project_id: str, options: render.ExportOptions):
    project = get_project(project_id)
    if options.sequence_id:
        if project.sequence(options.sequence_id) is None:
            raise HTTPException(404, "Sequence not found")
        project = project.view(options.sequence_id)
    if project.duration <= 0:
        raise HTTPException(400, "The timeline is empty")
    missing = [a.original_name for a in project.assets
               if a.status != "ready" and any(c.asset_id == a.id for c in project.clips)]
    if missing:
        raise HTTPException(409, f"Media still processing: {', '.join(missing)}")
    record = render.new_export_record(project, options)
    job = jobs.submit("export", lambda ctx: render.run_export(ctx, project, options, record),
                      project_id=project_id, label=f"Export {record.width}×{record.height}")
    record.job_id = job.id
    render._upsert_export(project_id, record)
    return ExportResponse(export=record, job=job)


@router.get("/projects/{project_id}/exports", response_model=list[render.ExportRecord])
def list_exports(project_id: str):
    get_project(project_id)
    records = render.list_exports(project_id)
    # Exports interrupted by a server restart would otherwise say "rendering" forever.
    for r in records:
        if r.status == "rendering" and (r.job_id is None or jobs.get(r.job_id) is None):
            r.status, r.error = "error", "Interrupted"
    return records


@router.delete("/projects/{project_id}/exports/{export_id}")
def delete_export(project_id: str, export_id: str):
    get_project(project_id)
    for r in render.list_exports(project_id):
        if r.id == export_id and r.job_id:
            jobs.cancel(r.job_id)
    if not render.delete_export(project_id, export_id):
        raise HTTPException(404, "Export not found")
    return {"ok": True}


@router.get("/projects/{project_id}/exports/{export_id}/download")
def download_export(project_id: str, export_id: str):
    rec = next((r for r in render.list_exports(project_id) if r.id == export_id), None)
    if rec is None or rec.status != "done":
        raise HTTPException(404, "Export not available")
    path = storage.exports_dir(project_id) / rec.filename
    if not path.is_file():
        raise HTTPException(404, "Export file missing")
    return FileResponse(path, media_type="video/mp4", filename=rec.filename)


# -- pre-renders -----------------------------------------------------------------------


@router.get("/projects/{project_id}/prerenders", response_model=list[prerender.SequenceStatus])
def prerender_status(project_id: str):
    return prerender.status(get_project(project_id))


class PrerenderRequest(BaseModel):
    quality: prerender.Quality = "draft"


@router.post("/projects/{project_id}/sequences/{sequence_id}/prerender", response_model=Optional[Job])
def start_prerender(project_id: str, sequence_id: str, body: PrerenderRequest):
    """Queue a pre-render (null when it's already up to date)."""
    project = get_project(project_id)
    seq = project.sequence(sequence_id)
    if seq is None:
        raise HTTPException(404, "Sequence not found")
    if seq.duration <= 0:
        raise HTTPException(400, "The sequence is empty")
    return prerender.start(project_id, sequence_id, body.quality)


@router.delete("/projects/{project_id}/sequences/{sequence_id}/prerender")
def clear_prerender(project_id: str, sequence_id: str, quality: Optional[prerender.Quality] = None):
    get_project(project_id)
    prerender.clear(project_id, sequence_id, quality)
    return {"ok": True}


# -- jobs ------------------------------------------------------------------------------


@router.get("/jobs", response_model=list[Job])
def list_jobs(project_id: Optional[str] = None):
    return jobs.list(project_id)


@router.get("/jobs/{job_id}", response_model=Job)
def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if not jobs.cancel(job_id):
        raise HTTPException(404, "Job not found")
    return {"ok": True}


# -- text / fonts ---------------------------------------------------------------------


@router.get("/fonts", response_model=list[str])
def fonts():
    return text.families()


class MeasureResponse(BaseModel):
    width: int
    height: int


@router.post("/text/measure", response_model=MeasureResponse)
def measure(style: TextStyle):
    w, h = text.measure(style)
    return MeasureResponse(width=w, height=h)


@router.get("/health")
def health():
    return {"ok": True, "ffmpeg": ffmpeg.version()}

