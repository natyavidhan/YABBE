"""Runtime configuration, driven by environment variables."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def _env_path(name: str, default: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser().resolve() if value else default.resolve()


BACKEND_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = _env_path("YABBE_DATA_DIR", BACKEND_DIR.parent / "data")
PROJECTS_DIR = DATA_DIR / "projects"
PREVIEW_DIR = DATA_DIR / "preview"
TMP_DIR = DATA_DIR / "tmp"

# Built frontend, served by the backend in production (single container).
STATIC_DIR = _env_path("YABBE_STATIC_DIR", BACKEND_DIR.parent / "frontend" / "dist")

FFMPEG = os.environ.get("YABBE_FFMPEG") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("YABBE_FFPROBE") or shutil.which("ffprobe") or "ffprobe"

# Extra directories searched for .ttf/.otf fonts used by text clips.
FONT_DIRS = [
    BACKEND_DIR / "fonts",
    Path("/usr/share/fonts"),
    Path("/usr/local/share/fonts"),
    Path.home() / ".local/share/fonts",
    Path.home() / ".fonts",
]

# Preview settings
PREVIEW_HEIGHT = int(os.environ.get("YABBE_PREVIEW_HEIGHT", "480"))
PROXY_HEIGHT = int(os.environ.get("YABBE_PROXY_HEIGHT", "540"))
PREVIEW_SEGMENT_SECONDS = 2.0

# Concurrency
JOB_WORKERS = int(os.environ.get("YABBE_JOB_WORKERS", "2"))
# Make draft pre-renders of nested sequences in the background after edits.
AUTO_PRERENDER = os.environ.get("YABBE_AUTO_PRERENDER", "1") not in ("0", "false", "no")
# Size limit for on-demand renders of nested sequence ranges (all projects).
NESTED_CACHE_MB = int(os.environ.get("YABBE_NESTED_CACHE_MB", "4096"))
PREVIEW_WORKERS = int(os.environ.get("YABBE_PREVIEW_WORKERS", "2"))
# Free space kept for proxies, previews and renders: uploads that would eat into
# it are refused with a clear message instead of failing half-way.
STORAGE_RESERVE_MB = int(os.environ.get("YABBE_STORAGE_RESERVE_MB", "100"))
# Cap on everything under the data directory (0 = only the disk's own size),
# e.g. 1024 to hand out a 1 GB test server.
STORAGE_LIMIT_MB = int(os.environ.get("YABBE_STORAGE_LIMIT_MB", "0"))

CORS_ORIGINS = [o for o in os.environ.get("YABBE_CORS_ORIGINS", "*").split(",") if o]


def ensure_dirs() -> None:
    for d in (DATA_DIR, PROJECTS_DIR, PREVIEW_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
