"""YABBE backend entrypoint: ``uvicorn app.main:app``."""

from __future__ import annotations

import errno
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, storage
from .api import media, projects, render, transitions
from .jobs import jobs

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    config.ensure_dirs()
    # Render any missing transition previews in the background, so hovering a
    # transition shows its preview instantly.
    threading.Thread(target=transitions.prerender_all, name="yabbe-previews", daemon=True).start()
    yield
    jobs.shutdown()


app = FastAPI(title="YABBE", description="Yet Another Browser Based Editor", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(storage.StorageFull)
def _storage_full(_, exc: storage.StorageFull):
    return JSONResponse({"detail": str(exc)}, status_code=507)


@app.exception_handler(OSError)
def _os_error(_, exc: OSError):
    if exc.errno == errno.ENOSPC:
        return JSONResponse({"detail": "Storage is full. Delete projects, media or exports to make room."},
                            status_code=507)
    raise exc


app.include_router(projects.router)
app.include_router(media.router)
app.include_router(render.router)
app.include_router(transitions.router)

# Serve the built SPA when present (production / docker).
if config.STATIC_DIR.is_dir():
    assets_dir = config.STATIC_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        candidate = (config.STATIC_DIR / path).resolve()
        if path and candidate.is_file() and config.STATIC_DIR in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(config.STATIC_DIR / "index.html")
