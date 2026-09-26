# YABBE — Yet Another Browser Based Editor

Self-hosted, no-auth, browser-based video editor. The browser is a thin UI;
every pixel and sample that ends up in a preview or an export is produced by
FFmpeg on the server.

## Architecture

```
┌──────────────────────────── Browser (React + Vite + TS) ───────────────────────────┐
│ Dashboard ─ project list / create / import .yabbe / export .yabbe / delete         │
│ Editor    ─ media bin · viewer (frame JPEG or HLS stream) · timeline · inspector   │
│             zustand store (undo/redo) → debounced autosave (PUT project JSON)      │
└───────────────┬─────────────────────────────────────────────────────────────────────┘
                │ REST + HLS  (/api/…)
┌───────────────▼──────────────── Backend (Python · FastAPI) ─────────────────────────┐
│ storage   data/projects/<id>/{project.json, media/, cache/, exports/}               │
│ media     upload (streamed) → ffprobe → jobs: proxy (540p, short GOP), filmstrip    │
│           sprite, waveform peaks                                                    │
│ render    one compositor: timeline window [t0,t1) × scale → FFmpeg filter graph     │
│             • frame   : 1 JPEG at t (scrubbing / paused viewer)                     │
│             • preview : on-demand HLS segments, rendered lazily & cached            │
│             • export  : full-res H.264/AAC MP4 job with progress                    │
│ text      Pillow rasterises text → PNG (cached by hash) → overlaid like an image    │
│ jobs      thread pool, ffmpeg `-progress` parsing, polled by the UI                 │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Why frames + lazy HLS for preview
* Paused / scrubbing: `POST /frame` renders exactly one composited frame (from
  proxies) — cheap and always accurate.
* Playing: the UI registers the current timeline snapshot (`POST /preview` →
  hash) and plays `/preview/<hash>/index.m3u8` with hls.js. Segments (~2 s) are
  rendered only when the player asks for them and cached, so playback starts
  almost immediately and edits only cost what you actually watch.

## Data model (project.json)

```jsonc
{
  "id": "…", "name": "My video", "created_at": …, "updated_at": …,
  "settings": { "width": 1920, "height": 1080, "fps": 30, "background": "#000000" },
  "assets": [ { "id", "kind": "video|audio|image", "filename", "original_name",
                "duration", "width", "height", "fps", "has_audio", "has_video",
                "status": "processing|ready|error" } ],
  "tracks": [ { "id", "kind": "video|audio", "name", "muted", "hidden", "locked" } ],
  "clips":  [ { "id", "track_id", "type": "video|audio|image|text", "asset_id",
                "start", "duration", "in_point", "speed",
                "volume", "fade_in", "fade_out", "muted",
                "transform": { "x", "y", "scale", "rotation", "opacity", "flip_h", "flip_v" },
                "crop": { "left", "top", "right", "bottom" },      // fractions 0..1
                "text": { "content", "font", "size", "color", "background",
                          "stroke_color", "stroke_width", "align", "bold", "italic" },
                "keyframes": { "x|y|scale|rotation|opacity|volume|text_size|text_stroke_width|
                                text_padding|text_line_spacing":  [ { "t", "v", "ease" } ],
                               "text_color|text_stroke_color|text_background": [ { "t", "c": "#rrggbbaa", "ease" } ] },
                "markers": [ { "id", "t", "label", "color" } ] } ]
}
```

* Time is in seconds (floats) on the timeline.
* `transform.x/y` = offset of the layer centre from the canvas centre, in
  project pixels. Media is first "contain"-fitted to the canvas (after crop),
  then multiplied by `scale`. Text uses its natural rasterised size × `scale`.
* Track order: `tracks[0]` is the top row in the UI and the top-most layer.
* Keyframe `t` is seconds from the clip's start (keys may sit outside the clip
  after trims/splits and still shape the curve). A property with keyframes
  ignores its static value. Rendering: position → `overlay` expressions,
  scale → per-frame `scale` padded to a fixed canvas, rotation → `rotate`
  expression, opacity → `sendcmd` driving `colorchannelmixer`, volume →
  `volume` expression. Single frames evaluate the curve in Python instead.
  **Update:** all animation now renders by sampling the curve per output frame
  in Python (engine/curves.py) and driving the filters with `sendcmd` /
  `asendcmd` (overlay x/y, scale w/h, rotate angle, colorchannelmixer alpha,
  volume). The frontend mirrors the maths in src/editor/curves.ts; both are
  tested against backend/tests/fixtures/curves.json.
  Text style keyframes re-rasterise the text with Pillow for every frame whose
  style differs (cached), centred on a fixed transparent canvas, and feed the
  frames to FFmpeg through an ffconcat list.

## v1 feature list

Dashboard
- [x] List projects (thumbnail, duration, updated), create, rename, duplicate, delete
- [x] Export a project as a portable `.yabbe` (zip: project.json + media)
- [x] Import a `.yabbe`

Media
- [x] Upload video / audio / images (drag-drop or picker), progress
- [x] Probe, proxy transcode, filmstrip sprite, waveform peaks

Timeline
- [x] Multiple video (layer) and audio tracks; add/remove/rename, mute/hide/lock
- [x] Drag from bin, move clips (across tracks), trim both edges, split at playhead
- [x] Snapping (clip edges, playhead), zoom, ruler, delete, duplicate
- [x] Undo / redo, keyboard shortcuts

Clip properties
- [x] Transform: position, scale, rotation, opacity, flip; on-canvas move/scale/rotate
- [x] Crop (videos and photos)
- [x] Audio: volume, mute, fade in/out (audio & video clips)
- [x] Speed (0.25×–4×)
- [x] Text clips: content, font, size, colour, stroke, background box, alignment

Preview & export
- [x] Frame-accurate server preview, lazy HLS playback
- [x] Export MP4 (resolution presets, quality presets) with progress, download list

Ops
- [x] Single container (Dockerfile + compose) serving API and built UI
- [x] Dev: `uvicorn` + `vite` with proxy

- [x] Keyframes for position, scale, rotation, opacity and volume with easing
- [x] Text style keyframes: size, colours, outline width, box, padding, spacing
- [x] Clip markers pinned to footage (move / trim / split / speed safe), snapping, navigation
- [x] Browser-only master preview volume
- [x] Graph editor: Bézier handles + handle modes, presets (easy ease, easing
      families, back/elastic/bounce, saved curves), F9 shortcuts, box select,
      copy/paste, stretch, snapping; per-property show-in-graph toggles;
      desktop side panel / phone takeover
- [x] Transitions: 74 CapCut-style transitions (xfade modes + per-frame
      motion recipes) between touching clips, centred on the cut, animated
      previews, apply to all cuts
- [x] Motion path on the preview: per-frame dots, draggable position keys,
      click to seek, double-click to add keys, toggle

## Sequences roadmap
- [x] Phase 1 — multiple sequences: model + upgrade of old projects,
      per-sequence rendering/export, sequences panel, tabs, settings
- [ ] Phase 2 — nesting sequences inside sequences (hybrid live/cached
      rendering, cycle checks, audio, open-from-clip, breadcrumbs)
- [ ] Phase 3 — pre-rendering (draft/preview/full, auto draft in background,
      status badges, render queue, export renders dependencies first)
- [ ] Phase 4 — pre-compose / un-nest, thumbnails, mobile polish

## Later
Keyframable crop/colour, effects/filters (colour, blur), audio ducking, captions
import (SRT), render queue across projects, WebSocket push instead of polling.
