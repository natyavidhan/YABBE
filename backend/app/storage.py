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
from .models import Project, ProjectSummary, Sequence, default_tracks

_locks: defaultdict[str, threading.RLock] = defaultdict(threading.RLock)
_locks_guard = threading.Lock()


class ProjectNotFound(Exception):
    pass


class StorageFull(Exception):
    """Not enough free disk space for what was asked."""


# -- disk space ----------------------------------------------------------------------


def disk() -> tuple[int, int, int]:
    """(total, used, free) bytes of the disk holding the data directory."""
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    u = shutil.disk_usage(config.DATA_DIR)
    return u.total, u.total - u.free, u.free


def reserve() -> int:
    return config.STORAGE_RESERVE_MB * 1024 * 1024


def reclaim(want_free: int) -> int:
    """Delete disposable files (old preview sessions, then cached nested
    renders, oldest first) until ``want_free`` bytes are free. Returns the
    free space afterwards. Anything written in the last minute is kept: a
    render may be about to read it."""
    free = disk()[2]
    if free >= want_free:
        return free
    now = time.time()
    victims: list[tuple[float, Path]] = []
    if config.PREVIEW_DIR.is_dir():
        for d in config.PREVIEW_DIR.iterdir():
            marker = d / "session.json"
            mtime = marker.stat().st_mtime if marker.exists() else 0.0
            victims.append((mtime, d))
    for f in config.PROJECTS_DIR.glob("*/cache/nested/*"):
        try:
            victims.append((f.stat().st_mtime, f))
        except FileNotFoundError:
            pass
    for mtime, path in sorted(victims, key=lambda v: v[0]):
        if now - mtime < 60:
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
        free = disk()[2]
        if free >= want_free:
            break
    return free


def ensure_space(nbytes: int, what: str) -> None:
    """Raise StorageFull unless ``nbytes`` fit while keeping the reserve free
    (clearing disposable caches first if that helps)."""
    need = nbytes + reserve()
    if reclaim(need) < need:
        total, used, free = disk()
        raise StorageFull(
            f"Not enough storage for {what}: {_mb(free)} free of {_mb(total)}. "
            "Delete projects, media or exports to make room."
        )


def _mb(n: int) -> str:
    return f"{n / 1024**3:.1f} GB" if n >= 1024**3 else f"{n / 1024**2:.0f} MB"


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
    main = Sequence(name="Main", tracks=default_tracks())
    if settings:
        main.settings = main.settings.model_copy(update=settings)
    project = Project(name=name or "Untitled project", sequences=[main], main_sequence_id=main.id)
    _make_dirs(project.id)
    save(project, touch=False)
    return project


def load(project_id: str) -> Project:
    path = _doc_path(project_id)
    if not path.is_file():
        raise ProjectNotFound(project_id)
    with lock(project_id):
        raw = path.read_text(encoding="utf-8")
        project = Project.model_validate_json(raw)
        if '"sequences"' not in raw:
            # Saved before sequences existed: persist the upgraded form once.
            _atomic_write(path, project.model_dump_json(indent=2))
        return project


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
