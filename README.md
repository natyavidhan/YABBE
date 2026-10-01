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
YABBE_PORT=9000 docker compose up -d   # use another host port
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
* **Sequences** — a project can hold several timelines, each with its own
  resolution, frame rate and background. One is the *main* sequence (shown on
  the dashboard, exported by default). Manage them in the **Sequences** tab of
  the left panel (new, rename, duplicate, settings, set as main, delete),
  switch with the tabs above the timeline, and pick any sequence in the export
  dialog. Undo covers every sequence. Projects from before sequences open with
  their timeline as the main sequence.
  **Nesting:** drag a sequence from the panel onto a timeline (or use *Add to
  timeline*) to use it like a clip — trim, speed, transform, crop, keyframes,
  transitions and volume all work. Double-click it to open and edit it; a
  breadcrumb leads back. Like After Effects precomps, a nested sequence's
  background is transparent, so only its content covers what's underneath.
  A sequence can never end up inside itself.
  **Pre-rendering:** a nested sequence is normally rendered live for the part
  the parent needs. Pre-render it (sequence menu → *Pre-render* draft 480p /
  720p / full quality) and parents play from that file while nothing inside
  it has changed. Drafts of nested sequences are made automatically a few
  seconds after you stop editing (toggle in the **Renders** panel, top bar),
  and exports make full-quality pre-renders of nested sequences first, deepest
  first. Badges on sequences and nested clips show fresh / out of date /
  rendering; the Renders panel shows progress, cancels, and frees disk space.
  **Pre-compose:** select clips → right-click → *Nest into a sequence* (or the
  toolbar button) moves them into a new sequence, keeping their layering and
  timing, and puts it in their place. *Un-nest* does the reverse for a nested
  clip whose own transform, speed, volume and keyframes are untouched (trims
  are fine — only the part shown comes back). Sequences show a thumbnail in
  the panel and on nested clips.
* **Timeline** — multiple video (layer) and audio tracks; move clips between
  tracks, trim either edge, split, duplicate, snapping, zoom, mute / hide /
  lock tracks, undo / redo.
* **Graph editor** — press <kbd>G</kbd> (or the curve button in the timeline
  toolbar) to open a curve editor beside the timeline; on phones it takes over
  the timeline area. Drag keys and Bézier handles (Alt breaks a handle pair),
  box-select, double-click a curve to add a key, snap to frames / playhead /
  markers, copy-paste keys, stretch timing, and pick handle modes (auto,
  auto-clamped, aligned, free). Presets: Easy Ease (<kbd>F9</kbd>, In
  <kbd>Shift+F9</kbd>, Out <kbd>Ctrl+Shift+F9</kbd>), Sine / Quad / Cubic /
  Quart / Quint / Expo / Circ, Back, Elastic and Bounce (with parameters), and
  your own saved curves. Each animated property has a toggle in the inspector
  to show or hide it in the graph.
* **Motion path** — when a selected clip's position is animated, the preview
  draws its path with a dot per frame (spacing shows speed). Drag a key's dot
  to move that position key (Shift locks the direction), click the path to
  jump to that moment, double-click it to add a position key. Toggle it with
  the route button next to the play controls.
* **Transitions** — 74 transitions in CapCut's categories: Basic (mix,
  dissolve, black/white/monochrome fades), Camera (pull in/out, zoom in, spin,
  swing, shake, swipes), Slide (slide/cover/reveal ×4, squeeze), Wipe (wipes,
  soft wipes, corner and diagonal wipes, clock), Mask (circle, rectangle,
  split open/close, blinds), Blur (blur, motion blur, zoom blur), Glitch
  (glitch, RGB split, mosaic), Light (flash, flash zoom) and Distortion (morph,
  wind). Hover a cut between two touching clips and press **+**; pick from
  animated previews, set the duration, apply to all cuts. Transitions are
  centred on the cut and use footage beyond the clip edges when it exists
  (otherwise the edge frame is held), so the timeline doesn't shift. The two
  clips' sound crossfades over the transition (equal power; can be switched
  off per transition). Previews use two sample scenes, are pre-rendered in the
  background when the server starts, and play when you hover a transition in
  the panel or on the timeline.
* **Speed** — 0.25×–4× with a hold-to-repeat stepper and presets; the clip
  resizes on the timeline as you change it, or type a length in **Fit to**
  and the speed is chosen so the same footage plays in exactly that time.
* **Properties & Effects** — the right panel has two tabs. **Properties** shows what every clip has built in (like Premiere's fixed effects): timing, markers, transform (position, scale, rotation, opacity, flip) with blend mode for anything visual, audio (volume, fades, mute) for anything with sound, plus a text or shape's own settings. Everything else is an **effect** in the **Effects** tab — Crop, Speed, Chroma key, Roto brush, Motion tracking, Stabilize — that you drag onto a clip on the timeline (or add to the selected clips). Each effect says which clips it works on (e.g. chroma key: video / photo / nested; speed: video / audio / nested). An added effect appears in that clip's Properties with an **fx** on / off switch (settings are kept while off) and a remove button; clips show an *fx* badge. Projects from before keep their settings — the effects they use are detected.
* **Roto brush** — cut a person or any object out of a video clip, like After Effects' Roto Brush: drag a box around it (or click it; Alt-click to exclude parts) on one frame, press Done, and it's followed through the clip in the background. Fix any frame where it slips and it re-tracks with that frame as an anchor. Keep or remove the object, refine edges (hair, fur), shrink / grow, feather, matte view. Runs Meta's EdgeTAM on the CPU with ONNX Runtime (~1.3 s per frame on a dual-core i3), chosen after benchmarking the SAM 2 family on CPU-only hardware.
* **Motion tracking** — on video clips, like After Effects' Tracker panel: *Position* (one point), *Position, rotation & scale*, *Corner pin* (a flat surface in perspective — screen / sign replacement) and *Stabilize* (smooth the camera move or lock it, optional rotation / scale, auto zoom to hide edges). Place the region on the preview and press Track; then make any clip follow it or pin a clip onto the surface. Tracking runs in the background on the server (fast: preview size; precise: the original up to 1080p), is sub-pixel on ground-truth tests, and results are cached per tracker settings — changing what follows, smoothness etc. never re-tracks, editing a region re-tracks automatically.
* **Chroma key** — per clip, toggleable: pick the screen colour with the eyedropper, check the matte, adjust clip black / white, spill removal, shrink and feather. A colour-difference keyer with unmixing (the approach of Keylight / Nuke's IBK), chosen after comparing options on a CPU-only machine: about half the edge error of FFmpeg's `chromakey` on a ground-truth test, and faster. AI keyers (CorridorKey) need a large GPU.
* **Freeze frame** — press `F` (or the snowflake in the timeline toolbar / clip menu): the video clip under the playhead is split there and a 2 s still of that frame is put between the halves; the rest of the clip and later clips on that track move right (linked audio is split and moved too). The still is saved as an ordinary photo (full quality, not listed in the media bin), so it behaves exactly like an image added from the media tab.
* **Shapes** — Shape menu next to Text: rectangle (rounded corners), ellipse, triangle, polygon, star, line, arrow, with fill (or none), outline colour / width, size; width, height, fill, outline colour / width and corner rounding are keyframable (◆), and transform, opacity, blend modes and transitions work as on any clip. Drawn at the size they're shown, so they stay sharp when scaled up.
* **Separate audio** — right-click a video clip → *Separate audio* (or the button in its Audio section) puts its sound on an audio track as its own clip, linked to the video so they move together (Alt+click selects one). *Restore audio* puts it back.
* **Clip properties** — position, scale, rotation, opacity, blend mode (multiply, screen, overlay, soft light, difference and 15 more, matching Photoshop), flip, crop, volume (0–400 %) with fade in / out, text clips with font,
  size, colour, outline and background box.
* **Keyframes** — animate position, scale, rotation, opacity and volume —
  and for text clips also font size, colour, outline colour/width, box colour
  and opacity, padding and line spacing — with linear, ease in/out, ease
  in-out or hold curves. Click ◆ next to a property
  to key it; once animated, any edit at the playhead (inspector or on-canvas
  handles) adds or updates a keyframe. Diamonds on the selected clip jump to
  keys; the bar above the transform fields navigates keys and sets easing.
* **Markers** — press <kbd>M</kbd> to mark a moment on the selected clip. A
  marker is pinned to that frame of footage: moving, trimming, splitting or
  changing the clip's speed carries it along. Name/colour them in the
  inspector, drag their flags, jump with <kbd>[</kbd> / <kbd>]</kbd>; clips and
  the playhead snap to them.
* **Preview** — paused frames are rendered exactly by FFmpeg; playback streams
  a lazily rendered HLS preview, so you only wait for the parts you watch.
  The master volume next to the play controls only changes how loud the
  preview plays in your browser — never the project or exports.
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

Tests: `cd backend && uv run pytest` and `cd frontend && npm test`

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
| `YABBE_AUTO_PRERENDER` | `1` | `0` turns off automatic draft pre-renders of nested sequences everywhere |
| `YABBE_MODELS_DIR` | `models/` (`/app/models` in Docker) | Where the roto brush model lives; the Docker image builds it in. Locally: `backend/tools/export_edgetam.py` |
| `YABBE_ROTO_THREADS` | all cores | CPU threads for the roto brush |
| `YABBE_STORAGE_LIMIT_MB` | `0` | Cap on the data folder (e.g. `1024` for a 1 GB test server); the dashboard shows usage against it |
| `YABBE_STORAGE_RESERVE_MB` | `100` | Free space kept for previews/renders; uploads and exports that would use it are refused with a clear message |
| `YABBE_NESTED_CACHE_MB` | `4096` | Disk budget for live renders of nested sequence ranges |
| `YABBE_PREVIEW_WORKERS` | `2` | Parallel preview segment renders |
| `YABBE_STATIC_DIR` | `frontend/dist` | Built UI served by the backend |
| `PUID` / `PGID` | `1000` | (Docker) user/group that owns `/data` |

Run a single server process: background jobs (proxies, exports) are tracked in
memory, so don't start uvicorn with multiple workers.

## Third-party models

The roto brush uses [EdgeTAM](https://github.com/facebookresearch/EdgeTAM) by Meta (Apache License 2.0),
exported to ONNX at build time; its licence is included next to the model files.
