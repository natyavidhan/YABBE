"""Music search: find songs on YouTube and add their audio to a project as MP3."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .. import config, storage
from ..engine import ffmpeg, media, youtube
from ..jobs import Job, JobContext, jobs
from ..models import Asset, Project, new_id
from .deps import get_project
from .media import schedule_processing

router = APIRouter(tags=["music"])


class MusicResult(BaseModel):
    id: str
    title: str
    channel: str
    duration: float
    thumbnail: str


def _enabled() -> None:
    if not config.MUSIC_SEARCH:
        raise HTTPException(404, "Music search is turned off on this server")


@router.get("/api/music/info")
def music_info():
    return {"available": config.MUSIC_SEARCH, "max_minutes": config.MUSIC_MAX_MINUTES}


@router.get("/api/music/search", response_model=list[MusicResult])
def music_search(q: str = Query(min_length=1, max_length=200), limit: int = 12):
    _enabled()
    q = q.strip()
    if not q:
        raise HTTPException(400, "Type something to search for")
    try:
        return youtube.search(q, max(1, min(limit, 30)))
    except youtube.YouTubeError as exc:
        raise HTTPException(502, f"YouTube search failed: {exc}") from None


class MusicDownload(BaseModel):
    video_id: str = Field(pattern=youtube.VIDEO_ID.pattern)


def _file_name(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title)
    name = re.sub(r"\s+", " ", name).strip() or "YouTube audio"
    return f"{name[:190]}.mp3"


@router.post("/api/projects/{project_id}/media/youtube", response_model=Job)
def music_download(project_id: str, body: MusicDownload):
    """Download a video's audio as MP3 into the project's media (a background job;
    its result holds the new ``asset_id``)."""
    _enabled()
    get_project(project_id)
    vid = body.video_id

    def job(ctx: JobContext):
        ctx.progress(0.0, "Looking up the video")
        try:
            meta = youtube.info(vid)
        except youtube.YouTubeError as exc:
            raise RuntimeError(f"Couldn't get that video: {exc}") from None
        title = meta.get("title") or vid
        ctx.job.label = f"Downloading “{title}”"
        duration = float(meta.get("duration") or 0)
        if meta.get("is_live") or not duration:
            raise RuntimeError("Live streams can't be downloaded")
        if duration > config.MUSIC_MAX_MINUTES * 60:
            raise RuntimeError(f"Too long: songs up to {config.MUSIC_MAX_MINUTES:g} minutes can be added")
        # the source stream + the MP3 (≤ 320 kb/s) sit on disk at the same time
        source_bytes = meta.get("filesize") or meta.get("filesize_approx") or duration * 20_000
        storage.ensure_space(int(source_bytes + duration * 40_000), "this song")

        work = config.TMP_DIR / f"music_{ctx.job.id}"
        work.mkdir(parents=True, exist_ok=True)
        asset_id = new_id("a_")
        dest = storage.media_dir(project_id) / f"{asset_id}.mp3"
        try:
            mp3 = youtube.download_mp3(meta, work, lambda f, msg: ctx.progress(0.05 + 0.8 * f, msg))
            ctx.progress(0.9, "Adding to media")
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(mp3), dest)
            fields = media.analyze(dest)
        except youtube.YouTubeError as exc:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"Download failed: {exc}") from None
        except (ffmpeg.FFmpegError, ValueError) as exc:
            dest.unlink(missing_ok=True)
            raise RuntimeError(f"The downloaded audio is unreadable: {exc}") from None
        except BaseException:
            dest.unlink(missing_ok=True)
            raise
        finally:
            shutil.rmtree(work, ignore_errors=True)

        asset = Asset(id=asset_id, filename=dest.name, original_name=_file_name(title),
                      size=dest.stat().st_size, **fields)

        def add(p: Project):
            p.assets.append(asset)
            return p

        try:
            storage.update(project_id, add)
        except BaseException:
            dest.unlink(missing_ok=True)  # project deleted meanwhile
            raise
        schedule_processing(project_id, asset_id)
        return {"asset_id": asset_id, "title": title}

    return jobs.submit("music", job, project_id=project_id, label="Downloading music")
