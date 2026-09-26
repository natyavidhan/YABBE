# YABBE — Yet Another Browser Based Editor

A self-hosted, no-login video editor that runs in your browser. The browser is
only the UI: **all** decoding, compositing, previewing and exporting happens on
the server with FFmpeg.

* **Frontend** — React + TypeScript + Vite (`frontend/`)
* **Backend** — Python + FastAPI + FFmpeg (`backend/`)

See [`docs/PLAN.md`](docs/PLAN.md) for the architecture and feature list.

## Quick start (Docker)

One command, nothing else to install — the image contains the UI, the API
server, FFmpeg and fonts:

```bash
docker run -d --name yabbe --restart unless-stopped \
  -p 8000:8000 -v yabbe-data:/data \
  ghcr.io/natyavidhan/yabbe:latest
```

Open **http://localhost:8000** (or `http://<server-ip>:8000` from other devices
on your network). Images are published for `linux/amd64` and `linux/arm64`
(Raspberry Pi 4/5, Apple Silicon, ARM servers).

Or with Compose, using the [`docker-compose.yml`](docker-compose.yml) in this repo:

```bash
docker compose up -d            # pulls the published image
docker compose up -d --build    # or build from this checkout
```

**Data** — everything (projects, uploads, caches, exports) lives in the `/data`
volume. To keep it in a host folder instead, mount it and pass your user and
group ids so the files stay yours:

```bash
docker run -d -p 8000:8000 -v "$PWD/yabbe-data:/data" \
  -e PUID=$(id -u) -e PGID=$(id -g) ghcr.io/natyavidhan/yabbe:latest
```

**Updating** — `docker pull ghcr.io/natyavidhan/yabbe:latest`, then recreate the
container (`docker compose pull && docker compose up -d`). Your data volume is
kept.

The container runs as an unprivileged user, has a health check
(`/api/health`), and shuts down cleanly. Put it behind a reverse proxy
(Caddy, nginx, Traefik) for HTTPS; raise the proxy's upload size limit so large
videos can be uploaded.

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

### Using it from other devices on your network

* Docker already listens on all interfaces: open `http://<server-ip>:8000`.
* Without Docker, bind uvicorn to all interfaces and use the built UI:

  ```bash
  cd frontend && npm run build
  cd ../backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
  ```

* The Vite dev server (`npm run dev`) also listens on the LAN (port 5173).
* If a firewall is enabled, allow the port, e.g. `sudo ufw allow 8000/tcp`.

There is no authentication, so only expose YABBE on networks you trust.

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
| `PUID` / `PGID` | `1000` | (Docker) user/group that owns `/data` |

Run a single server process: background jobs (proxies, exports) are tracked in
memory, so don't start uvicorn with multiple workers.
