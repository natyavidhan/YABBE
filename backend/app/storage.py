"""On-disk project storage.

Layout::

    data/projects/<id>/
        project.json     the document (see models.Project)
        thumbnail.jpg    dashboard thumbnail
        media/           original uploads
        cache/           proxies, filmstrips, waveforms, text renders
        exports/         rendered MP4s + exports.json index
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from collections import defaultdict
from pathlib import Path
from typing import Callable, Optional

from . import config
from .models import Project, ProjectSummary, default_tracks

_locks: defaultdict[str, threading.RLock] = defaultdict(threading.RLock)
_locks_guard = threading.Lock()


class ProjectNotFound(Exception):
    pass


def lock(project_id: str) -> threading.RLock:
    with _locks_guard:
        return _locks[project_id]


def _safe_id(project_id: str) -> str:
    if not project_id or "/" in project_id or ".." in project_id or "\\" in project_id:
        raise ProjectNotFound(project_id)
    return project_id


def project_dir(project_id: str) -> Path:
    return config.PROJECTS_DIR / _safe_id(project_id)


def media_dir(project_id: str) -> Path:
    return project_dir(project_id) / "media"


def cache_dir(project_id: str) -> Path:
    return project_dir(project_id) / "cache"


def exports_dir(project_id: str) -> Path:
    return project_dir(project_id) / "exports"


def thumbnail_path(project_id: str) -> Path:
    return project_dir(project_id) / "thumbnail.jpg"


def _doc_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def _atomic_write(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + f".tmp{threading.get_ident()}")
    tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


def _make_dirs(project_id: str) -> None:
    for d in (media_dir(project_id), cache_dir(project_id), exports_dir(project_id)):
        d.mkdir(parents=True, exist_ok=True)


def create_project(name: str, **settings) -> Project:
    project = Project(name=name or "Untitled project", tracks=default_tracks())
    if settings:
        project.settings = project.settings.model_copy(update=settings)
    _make_dirs(project.id)
    save(project, touch=False)
    return project


def load(project_id: str) -> Project:
    path = _doc_path(project_id)
    if not path.is_file():
        raise ProjectNotFound(project_id)
    with lock(project_id):
        return Project.model_validate_json(path.read_text(encoding="utf-8"))


def save(project: Project, touch: bool = True) -> Project:
    if touch:
        project.updated_at = time.time()
    with lock(project.id):
        _make_dirs(project.id)
        _atomic_write(_doc_path(project.id), project.model_dump_json(indent=2))
    return project


def update(project_id: str, fn: Callable[[Project], Optional[Project]], touch: bool = True) -> Project:
    """Read-modify-write under the project lock (used by API and job threads)."""
    with lock(project_id):
        project = load(project_id)
        result = fn(project) or project
        return save(result, touch=touch)


def delete(project_id: str) -> None:
    d = project_dir(project_id)
    if not d.is_dir():
        raise ProjectNotFound(project_id)
    with lock(project_id):
        shutil.rmtree(d)


def list_projects() -> list[ProjectSummary]:
    out: list[ProjectSummary] = []
    if not config.PROJECTS_DIR.is_dir():
        return out
    for d in config.PROJECTS_DIR.iterdir():
        if not (d / "project.json").is_file():
            continue
        try:
            p = load(d.name)
        except Exception:  # corrupt project: skip rather than break the dashboard
            continue
        out.append(
            ProjectSummary(
                id=p.id,
                name=p.name,
                created_at=p.created_at,
                updated_at=p.updated_at,
                duration=p.duration,
                width=p.settings.width,
                height=p.settings.height,
                asset_count=len(p.assets),
                has_thumbnail=thumbnail_path(p.id).is_file(),
            )
        )
    out.sort(key=lambda s: s.updated_at, reverse=True)
    return out


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, json.dumps(data, indent=2))
