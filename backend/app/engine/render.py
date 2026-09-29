"""Frame, preview (lazy HLS) and export rendering built on the compositor."""

from __future__ import annotations

import hashlib
import math
import re
import shutil
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

from .. import config, storage
from ..jobs import JobContext
from ..models import Project, new_id
from . import compositor, ffmpeg, prerender

# --------------------------------------------------------------------------- helpers


def timeline_key(project: Project) -> str:
    """Hash of everything that affects the rendered output of the project's
    current (main / viewed) sequence."""
    from . import nested, trackapply

    payload = project.id + nested.sequence_key(project, project.main_sequence_id) + project.model_dump_json(
        include={"assets"}
    ) + trackapply.state_token(project)
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def preview_scale(project: Project, height: Optional[int] = None) -> float:
    target = min(height or config.PREVIEW_HEIGHT, project.settings.height)
    return max(16, target) / project.settings.height


# --------------------------------------------------------------------------- frames

_frame_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_frame_cache_lock = threading.Lock()
_FRAME_CACHE_MAX = 256


def render_frame(project: Project, t: float, height: Optional[int] = None) -> bytes:
    fps = project.settings.fps
    frame = max(0, math.floor(t * fps + 1e-6))
    t0 = frame / fps
    k = preview_scale(project, height)
    cache_key = (timeline_key(project), frame, round(k, 4))
    with _frame_cache_lock:
        if cache_key in _frame_cache:
            _frame_cache.move_to_end(cache_key)
            return _frame_cache[cache_key]

    win = compositor.Window(t0, t0 + 1 / fps, scale=k, use_proxies=True, audio=False)
    g = compositor.build(project, win)
    data = ffmpeg.run(
        [*g.args(), "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "pipe:1"],
        timeout=60,
    )
    with _frame_cache_lock:
        _frame_cache[cache_key] = data
        while len(_frame_cache) > _FRAME_CACHE_MAX:
            _frame_cache.popitem(last=False)
    return data


# --------------------------------------------------------------------------- preview (HLS)

_segment_locks: dict[str, threading.Lock] = {}
_segment_locks_guard = threading.Lock()
_render_slots = threading.BoundedSemaphore(config.PREVIEW_WORKERS)
_MAX_PREVIEW_SESSIONS = 24


class PreviewSession(BaseModel):
    key: str
    height: int
    segment: float
    count: int
    duration: float


def _session_dir(key: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{16}_\d+", key):
        raise FileNotFoundError(key)
    return config.PREVIEW_DIR / key


def register_preview(project: Project, height: Optional[int] = None) -> PreviewSession:
    k = preview_scale(project, height)
    out_h = compositor._even(project.settings.height * k)
    key = f"{timeline_key(project)}_{out_h}"
    fps = project.settings.fps
    frames_per_seg = max(1, round(config.PREVIEW_SEGMENT_SECONDS * fps))
    seg = frames_per_seg / fps
    duration = max(project.duration, 1 / fps)
    session = PreviewSession(
        key=key, height=out_h, segment=seg, count=max(1, math.ceil(duration / seg - 1e-9)), duration=duration
    )
    d = _session_dir(key)
    if not (d / "session.json").is_file():
        d.mkdir(parents=True, exist_ok=True)
        (d / "project.json").write_text(project.model_dump_json(), encoding="utf-8")
        (d / "session.json").write_text(session.model_dump_json(), encoding="utf-8")
        _prune_previews()
    else:
        (d / "session.json").touch()
    return session


def _prune_previews() -> None:
    sessions = sorted(
        (p for p in config.PREVIEW_DIR.iterdir() if p.is_dir()),
        key=lambda p: (p / "session.json").stat().st_mtime if (p / "session.json").exists() else 0,
        reverse=True,
    )
    for old in sessions[_MAX_PREVIEW_SESSIONS:]:
        shutil.rmtree(old, ignore_errors=True)


def _load_session(key: str) -> tuple[PreviewSession, Project]:
    d = _session_dir(key)
    try:
        session = PreviewSession.model_validate_json((d / "session.json").read_text())
        project = Project.model_validate_json((d / "project.json").read_text())
    except FileNotFoundError:
        raise FileNotFoundError(key) from None
    return session, project


def playlist(key: str) -> str:
    session, _ = _load_session(key)
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        f"#EXT-X-TARGETDURATION:{math.ceil(session.segment)}",
        "#EXT-X-MEDIA-SEQUENCE:0",
    ]
    for n in range(session.count):
        length = min(session.segment, session.duration - n * session.segment)
        lines += [f"#EXTINF:{length:.6f},", f"seg_{n}.ts"]
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def segment(key: str, n: int) -> Path:
    session, project = _load_session(key)
    if not 0 <= n < session.count:
        raise FileNotFoundError(f"{key}/{n}")
    out = _session_dir(key) / f"seg_{n}.ts"
    if out.is_file():
        return out
    lock_id = f"{key}/{n}"
    with _segment_locks_guard:
        seg_lock = _segment_locks.setdefault(lock_id, threading.Lock())
    with seg_lock:
        if out.is_file():
            return out
        with _render_slots:
            storage.reclaim(storage.reserve())
            t0 = n * session.segment
            t1 = min(session.duration, t0 + session.segment)
            k = session.height / project.settings.height
            g = compositor.build(project, compositor.Window(t0, t1, scale=k, use_proxies=True))
            tmp = out.with_suffix(".part.ts")
            ffmpeg.run(
                [
                    "-y", *g.args(),
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                    "-t", f"{t1 - t0:.6f}",
                    "-output_ts_offset", f"{t0:.6f}", "-muxdelay", "0", "-muxpreload", "0",
                    "-f", "mpegts", str(tmp),
                ],
                timeout=300,
            )
            tmp.replace(out)
    with _segment_locks_guard:
        _segment_locks.pop(lock_id, None)
    return out


# --------------------------------------------------------------------------- export

Quality = Literal["high", "medium", "low"]
QUALITY_CRF = {"high": 18, "medium": 23, "low": 28}
QUALITY_PRESET = {"high": "medium", "medium": "veryfast", "low": "veryfast"}
QUALITY_AUDIO = {"high": "256k", "medium": "192k", "low": "128k"}


class ExportOptions(BaseModel):
    height: Optional[int] = Field(None, ge=144, le=4320)  # None = sequence resolution
    quality: Quality = "medium"
    sequence_id: Optional[str] = None  # None = main sequence


class ExportRecord(BaseModel):
    id: str = Field(default_factory=lambda: new_id("e_"))
    filename: str
    name: str
    status: Literal["rendering", "done", "error", "cancelled"] = "rendering"
    job_id: Optional[str] = None
    width: int = 0
    height: int = 0
    duration: float = 0.0
    size: int = 0
    quality: Quality = "medium"
    sequence_id: Optional[str] = None
    error: Optional[str] = None
    created_at: float = Field(default_factory=time.time)


def _exports_index(project_id: str) -> Path:
    return storage.exports_dir(project_id) / "exports.json"


_exports_lock = threading.Lock()


def list_exports(project_id: str) -> list[ExportRecord]:
    raw = storage.read_json(_exports_index(project_id), [])
    return [ExportRecord.model_validate(r) for r in raw]


def _upsert_export(project_id: str, record: ExportRecord) -> None:
    with _exports_lock:
        records = [r for r in list_exports(project_id) if r.id != record.id]
        records.insert(0, record)
        storage.write_json(_exports_index(project_id), [r.model_dump() for r in records])


def delete_export(project_id: str, export_id: str) -> bool:
    with _exports_lock:
        records = list_exports(project_id)
        keep = [r for r in records if r.id != export_id]
        if len(keep) == len(records):
            return False
        for r in records:
            if r.id == export_id:
                (storage.exports_dir(project_id) / r.filename).unlink(missing_ok=True)
        storage.write_json(_exports_index(project_id), [r.model_dump() for r in keep])
        return True


def _slug(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return s[:60] or "export"


def new_export_record(project: Project, options: ExportOptions) -> ExportRecord:
    st = project.settings
    h = options.height or st.height
    k = h / st.height
    stamp = time.strftime("%Y%m%d-%H%M%S")
    seq = project.main
    title = project.name if len(project.sequences) == 1 else f"{project.name} · {seq.name}"
    rec = ExportRecord(
        filename=f"{_slug(title)}-{stamp}.mp4",
        name=f"{title} ({compositor._even(st.width * k)}×{compositor._even(st.height * k)})",
        sequence_id=seq.id,
        width=compositor._even(st.width * k),
        height=compositor._even(st.height * k),
        duration=project.duration,
        quality=options.quality,
    )
    _upsert_export(project.id, rec)
    return rec


def run_export(ctx: JobContext, project: Project, options: ExportOptions, record: ExportRecord) -> dict:
    st = project.settings
    k = (options.height or st.height) / st.height
    duration = project.duration
    if duration <= 0:
        raise ValueError("The timeline is empty - add some clips before exporting")
    out = storage.exports_dir(project.id) / record.filename
    tmp = out.with_name(out.stem + ".part.mp4")
    try:
        # Nested sequences first (deepest first), so the export itself only reads
        # finished files and its progress bar means something.
        span = 0.0
        if prerender.dependencies(project, project.main_sequence_id):
            deps = [project.sequence(s) for s in prerender.dependencies(project, project.main_sequence_id)]
            work = sum(s.duration for s in deps if s) or 0.0
            span = min(0.8, work / (work + duration))
            quality = "preview" if options.height and options.height <= 720 else "full"
            prerender.render_with_dependencies(project, project.main_sequence_id, quality, ctx,
                                               span=(0.0, span), include_self=False)
        g = compositor.build(project, compositor.Window(0.0, duration, scale=k, use_proxies=False))
        ctx.progress(span, "Rendering")
        ffmpeg.run_with_progress(
            [
                "-y", *g.args(),
                "-c:v", "libx264", "-preset", QUALITY_PRESET[options.quality],
                "-crf", str(QUALITY_CRF[options.quality]), "-pix_fmt", "yuv420p",
                "-r", compositor._num(st.fps),
                "-c:a", "aac", "-b:a", QUALITY_AUDIO[options.quality], "-ac", "2",
                "-t", f"{duration:.6f}", "-movflags", "+faststart", "-f", "mp4", str(tmp),
            ],
            duration,
            lambda p: ctx.progress(span + (0.99 - span) * p),
            lambda: ctx.cancelled,
        )
        if ctx.cancelled:
            tmp.unlink(missing_ok=True)
            record.status = "cancelled"
            _upsert_export(project.id, record)
            return {"export_id": record.id}
        tmp.replace(out)
        record.status = "done"
        record.size = out.stat().st_size
        _upsert_export(project.id, record)
        return {"export_id": record.id}
    except BaseException as exc:
        tmp.unlink(missing_ok=True)
        record.status = "cancelled" if ctx.cancelled else "error"
        record.error = None if ctx.cancelled else str(exc)
        _upsert_export(project.id, record)
        raise
