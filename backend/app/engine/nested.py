"""Nested sequences: fingerprints and cached renders of a sequence's time range.

A clip of type "sequence" shows another sequence. When a parent renders, the
part of the child it needs is rendered by the same compositor (recursively
for deeper nesting) into a cached intermediate:

* a still PNG for single-frame previews (cheap, always current);
* a lossless FFV1 + PCM Matroska file for playback segments and exports.

Everything is keyed by the child's recursive fingerprint, so any edit inside
a nested sequence (at any depth) produces new renders for every parent.
"""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from typing import NamedTuple, Optional

from .. import config
from ..models import Project
from . import ffmpeg

class Source(NamedTuple):
    """A file holding the requested range, starting ``offset`` seconds in."""

    path: Path
    offset: float = 0.0


_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def sequence_key(project: Project, sequence_id: str, _stack: tuple[str, ...] = ()) -> str:
    """Fingerprint of everything that affects how ``sequence_id`` renders,
    including every sequence nested inside it."""
    seq = project.sequence(sequence_id)
    if seq is None or sequence_id in _stack:
        return "missing" if seq is None else "cycle"
    parts = [project.id, seq.model_dump_json(exclude={"name", "created_at"})]
    used_assets = {c.asset_id for c in seq.clips if c.asset_id}
    parts += [a.model_dump_json(include={"id", "status", "duration", "width", "height", "has_audio"})
              for a in project.assets if a.id in used_assets]
    for child in sorted(project.nested_in(sequence_id)):
        parts.append(child + ":" + sequence_key(project, child, _stack + (sequence_id,)))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:20]


def has_audio(project: Project, sequence_id: str, _stack: tuple[str, ...] = ()) -> bool:
    seq = project.sequence(sequence_id)
    if seq is None or sequence_id in _stack:
        return False
    for c in seq.clips:
        if c.type in ("video", "audio"):
            a = project.asset(c.asset_id)
            if a is not None and a.has_audio:
                return True
        if c.type == "sequence" and c.sequence_id and has_audio(project, c.sequence_id, _stack + (sequence_id,)):
            return True
    return False


def _cache_dir(project_id: str) -> Path:
    d = config.DATA_DIR / "cache" / "nested" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _locked_render(out: Path, render) -> Path:
    if out.is_file():
        return out
    with _guard:
        lock = _locks.setdefault(str(out), threading.Lock())
    with lock:
        if not out.is_file():
            render()
    return out


def render_height(child_h: int, wanted: float) -> int:
    """Even height, never above the child's own resolution."""
    h = int(min(child_h, max(16, round(wanted))))
    return h - h % 2 or 2


def render_still(project: Project, sequence_id: str, t: float, height: int, draft: bool,
                 stack: tuple[str, ...]) -> Optional[Path]:
    """One frame of a nested sequence as PNG (for paused previews)."""
    from . import compositor  # circular import

    seq = project.sequence(sequence_id)
    if seq is None:
        return None
    fps = seq.settings.fps
    t = max(0.0, int(t * fps + 1e-6) / fps)
    key = hashlib.sha1(f"{sequence_key(project, sequence_id)}|still|{t:.5f}|{height}|{draft}".encode()).hexdigest()[:24]
    out = _cache_dir(project.id) / f"{key}.png"

    def render():
        view = project.view(sequence_id)
        win = compositor.Window(t, t + 1 / fps, scale=height / seq.settings.height, use_proxies=draft, audio=False)
        g = compositor.build(view, win, stack=stack)
        tmp = out.with_suffix(".part.png")
        ffmpeg.run(["-y", *g.args(), "-frames:v", "1", "-update", "1", "-f", "image2", str(tmp)], timeout=300)
        tmp.replace(out)

    return _locked_render(out, render)


def render_range(project: Project, sequence_id: str, start: float, length: float, height: int, draft: bool,
                 stack: tuple[str, ...], video: bool = True) -> Optional[Source]:
    """Render [start, start+length) of a nested sequence (its own time) to a
    cached lossless intermediate. ``video=False`` renders sound only."""
    from . import compositor, prerender  # circular import

    seq = project.sequence(sequence_id)
    if seq is None or length <= 0:
        return None
    start = max(0.0, start)
    # A fresh full pre-render (phase 3) can serve any range directly.
    pre = prerender.usable(project, sequence_id, height, draft)
    if pre is not None:
        return Source(pre, start)
    key = hashlib.sha1(
        f"{sequence_key(project, sequence_id)}|{start:.5f}|{length:.5f}|{height}|{draft}|{video}".encode()
    ).hexdigest()[:24]
    out = _cache_dir(project.id) / f"{key}.{'mkv' if video else 'mka'}"

    def render():
        view = project.view(sequence_id)
        win = compositor.Window(start, start + length, scale=height / seq.settings.height,
                                use_proxies=draft, video=video, audio=True)
        g = compositor.build(view, win, stack=stack)
        tmp = out.with_name(out.stem + ".part" + out.suffix)
        codec = ["-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "4", "-pix_fmt", "yuv420p"] if video else []
        ffmpeg.run(["-y", *g.args(), *codec, "-c:a", "pcm_s16le", "-t", f"{length:.6f}",
                    "-f", "matroska", str(tmp)], timeout=3600)
        tmp.replace(out)

    return Source(_locked_render(out, render))
