"""Pre-renders: whole sequences rendered ahead of time.

Without one, a nested sequence renders just the range its parent needs, on
demand. A pre-render renders the whole sequence once, in the background, to
a lossless file with alpha. While it is fresh (nothing inside the sequence,
at any depth, has changed since) parents read from it instead.

Qualities:

* ``draft``   - 480p from proxies, for smooth previews (also made automatically)
* ``preview`` - 720p from the original media
* ``full``    - the sequence's own resolution from the original media; exports
  make these for every nested sequence first

Files live in ``<project>/cache/prerender/<sequence id>/<quality>.mkv`` next to
a ``.json`` describing them. Stale files are deleted (only the description is
kept, so the editor can say the pre-render is out of date).
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Callable, Literal, Optional

from pydantic import BaseModel

from .. import config, storage
from ..jobs import Job, JobContext, jobs
from ..models import Project
from . import ffmpeg

log = logging.getLogger("yabbe.prerender")

Quality = Literal["draft", "preview", "full"]
QUALITIES: dict[str, tuple[Optional[int], bool]] = {  # quality -> (height cap, from proxies)
    "draft": (480, True),
    "preview": (720, False),
    "full": (None, False),
}
AUTO_DELAY = 4.0  # seconds after the last save before drafts are made automatically


class Prerender(BaseModel):
    sequence_id: str
    quality: Quality
    key: str
    height: int
    proxies: bool
    size: int = 0
    created_at: float = 0.0


class QualityStatus(BaseModel):
    quality: Quality
    state: Literal["fresh", "stale", "queued", "rendering", "none"] = "none"
    height: int = 0
    size: int = 0
    progress: float = 0.0
    job_id: Optional[str] = None


class SequenceStatus(BaseModel):
    sequence_id: str
    used: bool  # nested in another sequence
    qualities: list[QualityStatus]


class _Active(BaseModel):
    job_id: str
    key: str
    rendering: bool = False
    progress: float = 0.0


# (project id, sequence id, quality) -> the job making it
_active: dict[tuple[str, str, str], _Active] = {}
_active_guard = threading.Lock()
_render_locks: dict[tuple[str, str, str], threading.Lock] = {}
_timers: dict[str, threading.Timer] = {}


# --------------------------------------------------------------------------- files


def key(project: Project, sequence_id: str) -> str:
    from . import nested  # circular import

    return f"{nested.RENDER_VERSION}-{nested.sequence_key(project, sequence_id)}"


def _dir(project_id: str, sequence_id: str) -> Path:
    return storage.cache_dir(project_id) / "prerender" / sequence_id


def _paths(project_id: str, sequence_id: str, quality: str) -> tuple[Path, Path]:
    d = _dir(project_id, sequence_id)
    return d / f"{quality}.mkv", d / f"{quality}.json"


def _read(project_id: str, sequence_id: str, quality: str) -> Optional[Prerender]:
    video, meta = _paths(project_id, sequence_id, quality)
    raw = storage.read_json(meta, None)
    if raw is None:
        return None
    try:
        return Prerender.model_validate(raw)
    except ValueError:
        return None


def _fresh(project: Project, sequence_id: str, quality: str, current: Optional[str] = None) -> Optional[Prerender]:
    info = _read(project.id, sequence_id, quality)
    if info is None or info.key != (current or key(project, sequence_id)):
        return None
    return info if _paths(project.id, sequence_id, quality)[0].is_file() else None


def target_height(project: Project, sequence_id: str, quality: str) -> int:
    seq = project.sequence(sequence_id)
    assert seq is not None
    cap, _ = QUALITIES[quality]
    h = seq.settings.height if cap is None else min(cap, seq.settings.height)
    return max(2, h - h % 2)


def usable(project: Project, sequence_id: str, height: int, draft: bool) -> Optional[Path]:
    """A fresh pre-render of the sequence to read from, or None.

    For exports (not ``draft``) it must come from the original media and be at
    least ``height`` tall. Previews take the smallest one that is tall enough,
    else the sharpest there is: a lower-resolution draft beats rendering live.
    """
    current = key(project, sequence_id)
    found = []
    for q, (_, proxies) in QUALITIES.items():
        info = _fresh(project, sequence_id, q, current)
        if info is None or (not draft and (proxies or info.height < height)):
            continue
        found.append(info)
    if not found:
        return None
    tall = [i for i in found if i.height >= height]
    best = min(tall, key=lambda i: i.height) if tall else max(found, key=lambda i: i.height)
    return _paths(project.id, sequence_id, best.quality)[0]


# --------------------------------------------------------------------------- rendering


def dependencies(project: Project, sequence_id: str) -> list[str]:
    """Every sequence nested inside ``sequence_id`` (at any depth), deepest first."""
    order: list[str] = []

    def visit(sid: str, stack: tuple[str, ...]) -> None:
        for child in sorted(project.nested_in(sid)):
            if child in stack or child in order or project.sequence(child) is None:
                continue
            visit(child, stack + (child,))
            order.append(child)

    visit(sequence_id, (sequence_id,))
    return order


def render(
    project: Project, sequence_id: str, quality: str, job_id: str,
    on_progress: Callable[[float], None], cancelled: Callable[[], bool],
) -> Optional[Prerender]:
    """Render one sequence (not its dependencies) unless a fresh one exists."""
    from . import compositor  # circular import

    seq = project.sequence(sequence_id)
    if seq is None:
        return None
    current = key(project, sequence_id)
    slot = (project.id, sequence_id, quality)
    with _active_guard:
        lock = _render_locks.setdefault(slot, threading.Lock())
    with lock:
        info = _fresh(project, sequence_id, quality, current)
        if info is not None or cancelled():
            return info
        duration = seq.duration
        if duration <= 0:
            return None
        height = target_height(project, sequence_id, quality)
        proxies = QUALITIES[quality][1]
        video, meta = _paths(project.id, sequence_id, quality)
        video.parent.mkdir(parents=True, exist_ok=True)
        tmp = video.with_name(f"{quality}.part.mkv")
        with _active_guard:
            _active[slot] = _Active(job_id=job_id, key=current, rendering=True)

        def progress(p: float) -> None:
            with _active_guard:
                if slot in _active:
                    _active[slot].progress = p
            on_progress(p)

        try:
            win = compositor.Window(0.0, duration, scale=height / seq.settings.height, use_proxies=proxies)
            g = compositor.build(project.view(sequence_id), win, transparent=True)
            progress(0.0)
            ffmpeg.run_with_progress(
                ["-y", *g.args(),
                 "-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "4", "-pix_fmt", "yuva420p",
                 "-c:a", "pcm_s16le", "-t", f"{duration:.6f}", "-f", "matroska", str(tmp)],
                duration, progress, cancelled,
            )
            if cancelled():
                tmp.unlink(missing_ok=True)
                return None
            tmp.replace(video)
            info = Prerender(sequence_id=sequence_id, quality=quality, key=current, height=height,  # type: ignore[arg-type]
                             proxies=proxies, size=video.stat().st_size, created_at=time.time())
            storage.write_json(meta, info.model_dump())
            return info
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        finally:
            with _active_guard:
                if slot in _active and _active[slot].job_id == job_id:
                    _active.pop(slot)


def render_with_dependencies(
    project: Project, sequence_id: str, quality: str, ctx: JobContext, span: tuple[float, float] = (0.0, 1.0),
    include_self: bool = True,
) -> None:
    """Pre-render everything nested in ``sequence_id`` (deepest first so each
    parent reads its children's pre-renders), then the sequence itself.
    Progress is reported to ``ctx`` within ``span``, weighted by duration."""
    todo = [s for s in dependencies(project, sequence_id) if _fresh(project, s, quality) is None]
    if include_self:
        todo.append(sequence_id)
    weights = [max(project.sequence(s).duration, 0.1) for s in todo]  # type: ignore[union-attr]
    total = sum(weights) or 1.0
    done = 0.0
    lo, hi = span
    for sid, w in zip(todo, weights):
        name = project.sequence(sid).name  # type: ignore[union-attr]
        base = lo + (hi - lo) * done / total
        part = (hi - lo) * w / total
        ctx.progress(base, f"Pre-rendering “{name}”")
        render(project, sid, quality, ctx.job.id, lambda p, b=base, s=part: ctx.progress(b + s * p),
               lambda: ctx.cancelled)
        done += w


# --------------------------------------------------------------------------- jobs


def start(project_id: str, sequence_id: str, quality: str, auto: bool = False) -> Optional[Job]:
    """Queue a pre-render (with its dependencies). Returns the job, or None when
    a fresh one already exists. A job already making the same render is reused;
    one making an outdated render is cancelled."""
    project = storage.load(project_id)
    seq = project.sequence(sequence_id)
    if seq is None:
        raise KeyError(sequence_id)
    current = key(project, sequence_id)
    slot = (project_id, sequence_id, quality)
    with _active_guard:
        running = _active.get(slot)
        if running is not None:
            job = jobs.get(running.job_id)
            if running.key == current and job is not None and job.status in ("queued", "running"):
                return job
            jobs.cancel(running.job_id)
            _active.pop(slot, None)
    if _fresh(project, sequence_id, quality, current) is not None and all(
        _fresh(project, s, quality) is not None for s in dependencies(project, sequence_id)
    ):
        return None

    def run(ctx: JobContext) -> dict:
        # Render what the project looks like now (it may have changed since queueing).
        p = storage.load(project_id)
        if p.sequence(sequence_id) is None:
            return {}
        render_with_dependencies(p, sequence_id, quality, ctx)
        prune_nested_cache()
        return {"sequence_id": sequence_id, "quality": quality}

    label = f"Pre-render “{seq.name}” · {quality}{' (auto)' if auto else ''}"
    job = jobs.submit("prerender", run, project_id=project_id, label=label)
    with _active_guard:
        _active.setdefault(slot, _Active(job_id=job.id, key=current))
    return job


def clear(project_id: str, sequence_id: str, quality: Optional[str] = None) -> None:
    for q in [quality] if quality else list(QUALITIES):
        slot = (project_id, sequence_id, q)
        with _active_guard:
            running = _active.pop(slot, None)
        if running is not None:
            jobs.cancel(running.job_id)
        for path in _paths(project_id, sequence_id, q):
            path.unlink(missing_ok=True)


def status(project: Project) -> list[SequenceStatus]:
    """Where every sequence's pre-renders stand. Also deletes stale files and
    the folders of sequences that no longer exist."""
    used = {c.sequence_id for s in project.sequences for c in s.clips if c.type == "sequence"}
    root = storage.cache_dir(project.id) / "prerender"
    if root.is_dir():
        for d in root.iterdir():
            if d.is_dir() and project.sequence(d.name) is None:
                clear(project.id, d.name)
                _rmdir(d)
    out = []
    for seq in project.sequences:
        current = key(project, seq.id)
        rows = []
        for q in QUALITIES:
            row = QualityStatus(quality=q)  # type: ignore[arg-type]
            info = _read(project.id, seq.id, q)
            video = _paths(project.id, seq.id, q)[0]
            if info is not None:
                if info.key == current and video.is_file():
                    row.state, row.height, row.size = "fresh", info.height, info.size
                else:
                    row.state = "stale"
                    video.unlink(missing_ok=True)
            with _active_guard:
                running = _active.get((project.id, seq.id, q))
            job = jobs.get(running.job_id) if running else None
            if running and running.key == current and job is not None and job.status in ("queued", "running"):
                row.state = "rendering" if running.rendering else "queued"
                row.progress, row.job_id = running.progress, running.job_id
            rows.append(row)
        out.append(SequenceStatus(sequence_id=seq.id, used=seq.id in used, qualities=rows))
    return out


def _rmdir(d: Path) -> None:
    for f in d.iterdir():
        f.unlink(missing_ok=True)
    d.rmdir()


# --------------------------------------------------------------------------- automatic drafts


def project_saved(project: Project) -> None:
    """Called after every save: stop pre-renders that just went out of date,
    and (unless turned off) make drafts of nested sequences once editing
    pauses for a few seconds."""
    with _active_guard:
        running = [(slot, a) for slot, a in _active.items() if slot[0] == project.id]
    for (pid, sid, q), a in running:
        if project.sequence(sid) is None or a.key != key(project, sid):
            jobs.cancel(a.job_id)
            with _active_guard:
                if _active.get((pid, sid, q)) is a:
                    _active.pop((pid, sid, q))
    if not config.AUTO_PRERENDER or not project.auto_prerender:
        return
    with _active_guard:
        old = _timers.pop(project.id, None)
        if old is not None:
            old.cancel()
        timer = threading.Timer(AUTO_DELAY, _auto, args=(project.id,))
        timer.daemon = True
        _timers[project.id] = timer
    timer.start()


def _auto(project_id: str) -> None:
    with _active_guard:
        _timers.pop(project_id, None)
    try:
        project = storage.load(project_id)
    except storage.ProjectNotFound:
        return
    if not project.auto_prerender:
        return
    used = {c.sequence_id for s in project.sequences for c in s.clips if c.type == "sequence" and c.sequence_id}
    # Deepest first, so each job finds its children already done.
    order: list[str] = []
    for sid in sorted(used):
        for dep in dependencies(project, sid) + [sid]:
            if dep not in order:
                order.append(dep)
    for sid in order:
        if sid in used and project.sequence(sid) is not None and project.sequence(sid).duration > 0:  # type: ignore[union-attr]
            try:
                start(project_id, sid, "draft", auto=True)
            except Exception:  # noqa: BLE001 - never break saving over a background nicety
                log.exception("auto pre-render of %s failed to start", sid)


# --------------------------------------------------------------------------- range cache


def prune_nested_cache() -> None:
    """Keep the on-demand nested render cache (all projects) under its size
    limit, dropping the least recently written files. Recent files are kept:
    a render may be about to read them."""
    limit = config.NESTED_CACHE_MB * 1024 * 1024
    files = []
    for f in config.PROJECTS_DIR.glob("*/cache/nested/*"):
        try:
            st = f.stat()
        except FileNotFoundError:
            continue
        files.append((st.st_mtime, st.st_size, f))
    total = sum(s for _, s, _ in files)
    now = time.time()
    for mtime, size, f in sorted(files):
        if total <= limit:
            break
        if now - mtime < 600:
            continue
        f.unlink(missing_ok=True)
        total -= size
