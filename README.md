# YABBE — Yet Another Browser Based Editor

A self-hosted, no-login video editor that runs in your browser. The browser is
only the UI: **all** decoding, compositing, previewing and exporting happens on
the server with FFmpeg.

* **Frontend** — React + TypeScript + Vite (`frontend/`)
* **Backend** — Python + FastAPI + FFmpeg (`backend/`)

See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and feature list.

## Quick start (Docker)

```bash
docker compose up -d --build
# open http://localhost:8000
```

Everything (projects, uploads, caches, exports) lives in `./data`.

## Features

* **Dashboard** — create / rename / duplicate / delete projects; export a
  project as a portable `.yabbe` file (project + original media) and import it
  on any YABBE server.
* **Media** — drag-and-drop upload of video, audio and photos. The server
  probes each file and builds a fast-seeking proxy, a filmstrip and a waveform.
* **Timeline** — multiple video (layer) and audio tracks; move clips between
  tracks, trim either edge, split, duplicate, snapping, zoom, mute / hide /
  lock tracks, undo / redo.
* **Clip properties** — position, scale, rotation, opacity, flip, crop,
  speed (0.25×–4×), volume (0–400 %) with fade in / out, text clips with font,
  size, colour, outline and background box.
* **Preview** — paused frames are rendered exactly by FFmpeg; playback streams
  a lazily rendered HLS preview, so you only wait for the parts you watch.
* **Export** — H.264 / AAC MP4 at project or lower resolution with quality
  presets, progress, cancel and download.

The keyboard icon in the editor header lists all shortcuts.

## Requirements (without Docker)

* Python ≥ 3.10 with [uv](https://docs.astral.sh/uv/)
* Node ≥ 20
* `ffmpeg` and `ffprobe` on `PATH` (or set `YABBE_FFMPEG` / `YABBE_FFPROBE`)

## Development

```bash
# backend (http://localhost:8000)
cd backend && uv sync && uv run uvicorn app.main:app --reload --port 8000

# frontend (http://localhost:5173, proxies /api to :8000)
cd frontend && npm install && npm run dev
```

Tests: `cd backend && uv run pytest`

Production without Docker: `cd frontend && npm run build`, then run uvicorn
from `backend/` — it serves the built UI from `frontend/dist` on the same port.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `YABBE_DATA_DIR` | `./data` | Projects, media, caches and exports |
| `YABBE_FFMPEG` / `YABBE_FFPROBE` | from `PATH` | FFmpeg binaries |
| `YABBE_PREVIEW_HEIGHT` | `480` | Default preview resolution |
| `YABBE_PROXY_HEIGHT` | `540` | Proxy (editing copy) resolution |
| `YABBE_JOB_WORKERS` | `2` | Parallel background jobs (proxies, exports) |
| `YABBE_PREVIEW_WORKERS` | `2` | Parallel preview segment renders |
| `YABBE_STATIC_DIR` | `frontend/dist` | Built UI served by the backend |
