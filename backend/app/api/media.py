"""Media upload + derived assets (proxy, poster, filmstrip, waveform)."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .. import storage
from ..engine import ffmpeg, media
from ..jobs import JobContext, jobs
from ..models import Asset, Project, new_id
from .deps import get_project

log = logging.getLogger("yabbe.media")
router = APIRouter(prefix="/api/projects/{project_id}/media", tags=["media"])

MAX_UPLOAD_BYTES = 20 * 1024**3


def _safe_ext(name: str) -> str:
    ext = Path(name).suffix.lower()
    return ext if re.fullmatch(r"\.[a-z0-9]{1,6}", ext) else ""


def _set_asset(project_id: str, asset_id: str, **fields) -> None:
    def apply(p: Project):
        for a in p.assets:
            if a.id == asset_id:
                for k, v in fields.items():
                    setattr(a, k, v)
        return p

    storage.update(project_id, apply, touch=False)


def schedule_processing(project_id: str, asset_id: str) -> None:
    def job(ctx: JobContext):
        project = storage.load(project_id)
        asset = project.asset(asset_id)
        if asset is None:
            return None
        try:
            if asset.kind != "audio":
                ctx.progress(0.0, "Creating proxy")
                media.make_proxy(project_id, asset, lambda p: ctx.progress(p * 0.8))
            if asset.has_video or asset.kind == "image":
                ctx.progress(0.82, "Thumbnails")
                media.make_poster(project_id, asset)
                count, interval = media.make_filmstrip(project_id, asset)
            else:
                count, interval = 0, 0.0
            if asset.has_audio:
                ctx.progress(0.9, "Waveform")
                media.make_waveform(project_id, asset)
            _set_asset(project_id, asset_id, status="ready", error=None,
                       thumb_count=count, thumb_interval=interval)
        except Exception as exc:
            if not ctx.cancelled:
                _set_asset(project_id, asset_id, status="error", error=str(exc))
            raise
        return {"asset_id": asset_id}

    jobs.submit("media", job, project_id=project_id, label="Processing media")


@router.post("", response_model=Asset)
async def upload(project_id: str, request: Request, filename: str):
    """Body: raw file bytes (streamed straight to disk). ``?filename=`` is the
    original name."""
    get_project(project_id)
    asset_id = new_id("a_")
    stored = f"{asset_id}{_safe_ext(filename)}"
    dest = storage.media_dir(project_id) / stored
    dest.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with open(dest, "wb") as fh:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File too large")
                fh.write(chunk)
        if size == 0:
            raise HTTPException(400, "Empty upload")
        try:
            fields = media.analyze(dest)
        except (ffmpeg.FFmpegError, ValueError) as exc:
            raise HTTPException(415, f"Unsupported media: {exc}") from None
    except BaseException:
        dest.unlink(missing_ok=True)
        raise

    asset = Asset(id=asset_id, filename=stored, original_name=Path(filename).name[:200] or stored,
                  size=size, **fields)

    def add(p: Project):
        p.assets.append(asset)
        return p

    storage.update(project_id, add)
    schedule_processing(project_id, asset_id)
    return asset


@router.delete("/{asset_id}")
def delete_asset(project_id: str, asset_id: str):
    project = get_project(project_id)
    asset = project.asset(asset_id)
    if asset is None:
        raise HTTPException(404, "Asset not found")

    def apply(p: Project):
        p.assets = [a for a in p.assets if a.id != asset_id]
        p.clips = [c for c in p.clips if c.asset_id != asset_id]
        return p

    storage.update(project_id, apply)
    (storage.media_dir(project_id) / asset.filename).unlink(missing_ok=True)
    media.clear_derived(project_id, asset_id)
    return {"ok": True}


@router.post("/{asset_id}/reprocess", response_model=Asset)
def reprocess(project_id: str, asset_id: str):
    project = get_project(project_id)
    if project.asset(asset_id) is None:
        raise HTTPException(404, "Asset not found")
    media.clear_derived(project_id, asset_id)
    _set_asset(project_id, asset_id, status="processing", error=None)
    schedule_processing(project_id, asset_id)
    return get_project(project_id).asset(asset_id)


def _asset(project_id: str, asset_id: str) -> Asset:
    asset = get_project(project_id).asset(asset_id)
    if asset is None:
        raise HTTPException(404, "Asset not found")
    return asset


def _file(path: Path, media_type: str) -> FileResponse:
    if not path.is_file():
        raise HTTPException(404, "Not generated yet")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "max-age=3600"})


@router.get("/{asset_id}/poster")
def poster(project_id: str, asset_id: str):
    _asset(project_id, asset_id)
    return _file(media.poster_path(project_id, asset_id), "image/jpeg")


@router.get("/{asset_id}/filmstrip")
def filmstrip(project_id: str, asset_id: str):
    _asset(project_id, asset_id)
    return _file(media.filmstrip_path(project_id, asset_id), "image/jpeg")


@router.get("/{asset_id}/waveform")
def waveform(project_id: str, asset_id: str):
    _asset(project_id, asset_id)
    return _file(media.waveform_path(project_id, asset_id), "application/octet-stream")


@router.get("/{asset_id}/file")
def original(project_id: str, asset_id: str):
    asset = _asset(project_id, asset_id)
    path = media.source_path(project_id, asset)
    if not path.is_file():
        raise HTTPException(404, "File missing")
    return FileResponse(path, filename=asset.original_name)
