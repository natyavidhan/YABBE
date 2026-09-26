# YABBE — Yet Another Browser Based Editor

A self-hosted, no-login video editor that runs in your browser. The browser is
only the UI: **all** decoding, compositing, previewing and exporting happens on
the server with FFmpeg.

* **Frontend** — React + TypeScript + Vite (`frontend/`)
* **Backend** — Python + FastAPI + FFmpeg (`backend/`)

See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and feature list.

## Requirements

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
