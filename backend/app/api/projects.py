"""Project CRUD, dashboard thumbnails and portable .yabbe packages."""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .. import config, storage
from ..engine import render
from ..jobs import jobs
from ..models import Project, ProjectSummary, TimelineUpdate, new_id
from .deps import get_project
from .media import schedule_processing

router = APIRouter(prefix="/api/projects", tags=["projects"])

PACKAGE_VERSION = 1
MAX_PACKAGE_BYTES = 20 * 1024**3


class CreateProject(BaseModel):
    name: str = "Untitled project"
    width: int = Field(1920, ge=16, le=7680)
    height: int = Field(1080, ge=16, le=4320)
    fps: float = Field(30, gt=0, le=120)
    background: str = "#000000"


@router.get("", response_model=list[ProjectSummary])
def list_projects():
    return storage.list_projects()


@router.post("", response_model=Project)
def create_project(body: CreateProject):
    return storage.create_project(
        body.name.strip() or "Untitled project",
        width=body.width - body.width % 2,
        height=body.height - body.height % 2,
        fps=body.fps,
        background=body.background,
    )


@router.get("/{project_id}", response_model=Project)
def read_project(project_id: str):
    return get_project(project_id)


# -- thumbnails ----------------------------------------------------------------------

_thumb_pending: set[str] = set()
_thumb_lock = threading.Lock()


def refresh_thumbnail(project_id: str, force: bool = False) -> None:
    """Render a small frame of the timeline for the dashboard (debounced)."""
    path = storage.thumbnail_path(project_id)
    if not force and path.is_file() and time.time() - path.stat().st_mtime < 20:
        return
    with _thumb_lock:
        if project_id in _thumb_pending:
            return
        _thumb_pending.add(project_id)

    def job(ctx):
        try:
            time.sleep(1.5)  # let a burst of autosaves settle
            project = storage.load(project_id)
            if not project.clips:
                path.unlink(missing_ok=True)
                return None
            t = min(project.duration * 0.25, 3.0)
            data = render.render_frame(project, t, height=270)
            path.write_bytes(data)
        finally:
            with _thumb_lock:
                _thumb_pending.discard(project_id)
        return None

    jobs.submit("thumbnail", job, project_id=project_id, label="Thumbnail")


@router.put("/{project_id}", response_model=Project)
def save_project(project_id: str, body: TimelineUpdate):
    get_project(project_id)
    changed_timeline = body.clips is not None or body.tracks is not None or body.settings is not None

    def apply(p: Project):
        if body.name is not None:
            p.name = body.name.strip() or p.name
        if body.settings is not None:
            p.settings = body.settings
        if body.tracks is not None:
            p.tracks = body.tracks
        if body.clips is not None:
            track_ids = {t.id for t in p.tracks}
            asset_ids = {a.id for a in p.assets}
            p.clips = [
                c for c in body.clips
                if c.track_id in track_ids and (c.type == "text" or c.asset_id in asset_ids)
            ]
        return p

    project = storage.update(project_id, apply)
    if changed_timeline:
        refresh_thumbnail(project_id)
    return project


@router.delete("/{project_id}")
def delete_project(project_id: str):
    get_project(project_id)
    jobs.cancel_project(project_id)
    storage.delete(project_id)
    return {"ok": True}


@router.post("/{project_id}/duplicate", response_model=Project)
def duplicate_project(project_id: str):
    src = get_project(project_id)
    copy = src.model_copy(deep=True)
    copy.id = new_id("p_")
    copy.name = f"{src.name} (copy)"
    copy.created_at = copy.updated_at = time.time()
    shutil.copytree(storage.project_dir(src.id), storage.project_dir(copy.id),
                    ignore=shutil.ignore_patterns("exports", "*.part*"))
    storage.save(copy, touch=False)
    return copy


@router.get("/{project_id}/thumbnail")
def project_thumbnail(project_id: str):
    path = storage.thumbnail_path(project_id)
    if not path.is_file():
        raise HTTPException(404, "No thumbnail")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})


# -- .yabbe packages ------------------------------------------------------------------


@router.get("/{project_id}/package")
def export_package(project_id: str):
    """Zip project.json + original media into a portable .yabbe file."""
    project = get_project(project_id)
    config.TMP_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".yabbe", dir=config.TMP_DIR)
    tmp = Path(tmp_name)
    with open(fd, "wb") as fh, zipfile.ZipFile(fh, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
        manifest = {"format": "yabbe", "version": PACKAGE_VERSION, "exported_at": time.time()}
        zf.writestr("manifest.json", json.dumps(manifest))
        zf.writestr("project.json", project.model_dump_json(indent=2))
        for asset in project.assets:
            src = storage.media_dir(project_id) / asset.filename
            if src.is_file():
                zf.write(src, f"media/{asset.filename}")
    safe = "".join(ch if ch.isalnum() or ch in " ._-" else "_" for ch in project.name).strip() or "project"
    return FileResponse(
        tmp, media_type="application/zip", filename=f"{safe}.yabbe",
        background=BackgroundTask(tmp.unlink, missing_ok=True),
    )


@router.post("/import", response_model=Project)
async def import_package(request: Request, name: Optional[str] = None):
    """Body: raw bytes of a .yabbe file."""
    config.TMP_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".yabbe", dir=config.TMP_DIR)
    tmp = Path(tmp_name)
    written = 0
    try:
        with open(fd, "wb") as fh:
            async for chunk in request.stream():
                written += len(chunk)
                if written > MAX_PACKAGE_BYTES:
                    raise HTTPException(413, "Package too large")
                fh.write(chunk)
        return _import_from_zip(tmp, name)
    finally:
        tmp.unlink(missing_ok=True)


def _import_from_zip(path: Path, name: Optional[str]) -> Project:
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid .yabbe file") from None
    with zf:
        try:
            project = Project.model_validate_json(zf.read("project.json"))
        except KeyError:
            raise HTTPException(400, "Package is missing project.json") from None
        except ValueError as exc:
            raise HTTPException(400, f"Invalid project.json: {exc}") from None
        project.id = new_id("p_")
        project.name = name or project.name
        project.updated_at = time.time()
        media = storage.media_dir(project.id)
        media.mkdir(parents=True, exist_ok=True)
        known = {a.filename for a in project.assets}
        for info in zf.infolist():
            if not info.filename.startswith("media/") or info.is_dir():
                continue
            fname = Path(info.filename).name
            if fname in ("", ".", "..") or fname not in known:  # also blocks path traversal
                continue
            with zf.open(info) as src, open(media / fname, "wb") as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
    kept = []
    for asset in project.assets:
        if (media / asset.filename).is_file():
            asset.status = "processing"
            asset.error = None
            kept.append(asset)
    project.assets = kept
    ids = {a.id for a in kept}
    project.clips = [c for c in project.clips if c.type == "text" or c.asset_id in ids]
    storage.save(project, touch=False)
    for asset in kept:
        schedule_processing(project.id, asset.id)
    refresh_thumbnail(project.id, force=True)
    return project
