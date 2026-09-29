import { KeyPicker, keyPreview, useKeyView } from './ChromaKey'
import { TrackerOverlay } from './Tracking'
import Hls from 'hls.js'
import { Pause, Play, Route, SkipBack, SkipForward, StepBack, StepForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Asset } from '../api/types'
import { toast } from '../components/toast'
import { IconButton, Spinner } from '../components/ui'
import { clamp, formatTimecode } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import { useMediaQuery } from '../lib/useMedia'
import { hitTest, layerOf, type Layer } from './geometry'
import { MotionPath } from './MotionPath'
import { assetsWithSequences, clipEnd, docDuration, timelineOf, useEditor } from './store'

type Quality = 'auto' | 360 | 480 | 720 | 1080 | 'full'
const QUALITY_KEY = 'yabbe.previewQuality'

function loadQuality(): Quality {
  try {
    const v = localStorage.getItem(QUALITY_KEY)
    if (v === 'auto' || v === 'full') return v
    const n = Number(v)
    if ([360, 480, 720, 1080].includes(n)) return n as Quality
  } catch {
    /* ignore */
  }
  return 'auto'
}

export function Viewer({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const settings = useEditor((s) => s.doc.settings)
  const playing = useEditor((s) => s.playing)
  const [quality, setQuality] = useState<Quality>(loadQuality)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const pad = compact ? 8 : 24
      const aw = Math.max(0, el.clientWidth - pad * 2)
      const ah = Math.max(0, el.clientHeight - pad * 2)
      const aspect = settings.width / settings.height
      let w = aw
      let h = w / aspect
      if (h > ah) {
        h = ah
        w = h * aspect
      }
      setBox({ w: Math.floor(w), h: Math.floor(h) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [settings.width, settings.height, compact])

  const renderHeight = useMemo(() => {
    if (quality === 'full') return settings.height
    if (quality !== 'auto') return Math.min(quality, settings.height)
    const want = Math.ceil((box.h * Math.min(window.devicePixelRatio || 1, 2)) / 120) * 120
    return clamp(want || 360, 240, Math.min(1080, settings.height))
  }, [quality, box.h, settings.height])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        {box.w > 0 && (
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 shadow-2xl shadow-black/60"
            style={{ width: box.w, height: box.h }}
          >
            <FrameView projectId={projectId} height={renderHeight} hidden={playing} />
            <Player projectId={projectId} height={Math.min(renderHeight, 720)} />
            {!playing && <TransformOverlay width={box.w} />}
            {!playing && <TrackerOverlay width={box.w} />}
            {!playing && <KeyPicker />}
          </div>
        )}
      </div>
      <Transport
        compact={compact}
        quality={quality}
        onQuality={(q) => {
          setQuality(q)
          try {
            localStorage.setItem(QUALITY_KEY, String(q))
          } catch {
            /* ignore */
          }
        }}
      />
    </div>
  )
}

/** Paused view: one server-rendered JPEG, latest request wins. */
function FrameView({ projectId, height, hidden }: { projectId: string; height: number; hidden: boolean }) {
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const playhead = useEditor((s) => s.playhead)
  const keyPick = useKeyView((s) => s.pick)
  const keyMatte = useKeyView((s) => s.matte)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const wanted = useRef<(() => Promise<void>) | null>(null)

  // Asset readiness changes which proxies exist -> re-render.
  const assetKey = assets.map((a) => a.id + a.status).join(',')

  useEffect(() => {
    if (hidden) return
    const fps = doc.settings.fps
    const t = Math.floor(playhead * fps + 1e-6) / fps
    const timeline = keyPreview(timelineOf(doc), keyPick, keyMatte)
    const run = async () => {
      inflight.current = true
      setBusy(true)
      try {
        const blob = await api.frame(projectId, t, height, timeline)
        const next = URL.createObjectURL(blob)
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev)
          return next
        })
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        inflight.current = false
        const nextJob = wanted.current
        wanted.current = null
        if (nextJob) nextJob()
        else setBusy(false)
      }
    }
    if (inflight.current) wanted.current = run
    else run()
  }, [doc, playhead, height, projectId, hidden, assetKey, keyPick, keyMatte])

  useEffect(() => () => setUrl((prev) => (prev && URL.revokeObjectURL(prev), null)), [])

  return (
    <div className={`absolute inset-0 ${hidden ? 'invisible' : ''}`} style={{ background: doc.settings.background }}>
      {url && <img src={url} alt="Preview" className="h-full w-full select-none" draggable={false} />}
      {busy && (
        <div className="absolute top-2 right-2 text-white/70">
          <Spinner size={12} />
        </div>
      )}
      {error && (
        <div className="absolute inset-x-2 bottom-2 rounded bg-danger/80 px-2 py-1 text-xs text-white">{error}</div>
      )}
    </div>
  )
}

/** Playing view: lazily rendered HLS stream of the current timeline. */
function Player({ projectId, height }: { projectId: string; height: number }) {
  const playing = useEditor((s) => s.playing)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [buffering, setBuffering] = useState(false)
  const volume = usePrefs((p) => p.volume)
  const muted = usePrefs((p) => p.muted)

  // Master volume is a playback preference only; the project/export is untouched.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted, playing])

  useEffect(() => {
    const video = videoRef.current
    if (!playing || !video) return
    const store = useEditor.getState()
    const duration = docDuration(store.doc)
    if (duration <= 0) {
      store.setPlaying(false)
      return
    }
    let start = store.playhead
    if (start >= duration - 0.05) {
      start = 0
      store.setPlayhead(0)
    }
    let hls: Hls | null = null
    let raf = 0
    let alive = true
    let lastSet = start
    const startVersion = store.version
    setBuffering(true)

    const tick = () => {
      if (!alive) return
      const s = useEditor.getState()
      if (s.version !== startVersion) {
        // Timeline edited while playing: stop so the preview never lies.
        s.setPlaying(false)
        return
      }
      if (Math.abs(s.playhead - lastSet) > 0.2) {
        // Someone seeked (ruler click / keyboard) while playing.
        video.currentTime = s.playhead
      } else if (!video.seeking) {
        lastSet = video.currentTime
        s.setPlayhead(lastSet)
      }
      if (video.currentTime >= duration - 0.02 || video.ended) {
        s.setPlayhead(duration)
        s.setPlaying(false)
        return
      }
      raf = requestAnimationFrame(tick)
    }

    api
      .preview(projectId, height, timelineOf(store.doc))
      .then((session) => {
        if (!alive) return
        const src = api.playlistUrl(session.key)
        const begin = () => {
          video.currentTime = start
          video.play().catch(() => {})
          raf = requestAnimationFrame(tick)
        }
        if (Hls.isSupported()) {
          hls = new Hls({
            startPosition: start,
            maxBufferLength: 8,
            maxMaxBufferLength: 16,
            backBufferLength: 10,
            fragLoadPolicy: {
              default: {
                maxTimeToFirstByteMs: 60_000,
                maxLoadTimeMs: 120_000,
                timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
                errorRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 2000 },
              },
            },
          })
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) {
              toast.error(`Preview playback failed: ${data.details}`)
              useEditor.getState().setPlaying(false)
            }
          })
          hls.loadSource(src)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, begin)
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src
          video.addEventListener('loadedmetadata', begin, { once: true })
        } else {
          toast.error('This browser cannot play HLS previews')
          useEditor.getState().setPlaying(false)
        }
      })
      .catch((e) => {
        toast.error(e)
        useEditor.getState().setPlaying(false)
      })

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      video.pause()
      hls?.destroy()
      video.removeAttribute('src')
      video.load()
      setBuffering(false)
    }
  }, [playing, projectId, height])

  return (
    <div className={`absolute inset-0 bg-black ${playing ? '' : 'invisible'}`}>
      <video
        ref={videoRef}
        className="h-full w-full"
        playsInline
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onClick={() => useEditor.getState().setPlaying(false)}
      />
      {playing && buffering && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80">
          <Spinner size={22} />
          <span className="text-xs">Rendering preview…</span>
        </div>
      )}
    </div>
  )
}

function Transport({
  quality,
  onQuality,
  compact,
}: {
  quality: Quality
  onQuality: (q: Quality) => void
  compact: boolean
}) {
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const settings = useEditor((s) => s.doc.settings)
  const duration = useEditor((s) => docDuration(s.doc))
  const { setPlaying, setPlayhead } = useEditor.getState()
  const fps = settings.fps
  const step = (n: number) => {
    setPlaying(false)
    setPlayhead(Math.max(0, (Math.round(playhead * fps) + n) / fps))
  }
  return (
    <div className={`flex shrink-0 items-center gap-1 border-t border-line bg-panel ${compact ? 'h-12 px-2' : 'h-11 px-3'}`}>
      <div className={`tabular font-mono ${compact ? 'w-24 text-[11px] leading-tight' : 'w-40 text-xs'}`}>
        <span className="text-fg">{formatTimecode(playhead, fps)}</span>
        {compact ? <br /> : ' '}
        <span className="text-faint">{compact ? '' : '/ '}{formatTimecode(duration, fps)}</span>
      </div>
      <div className="flex flex-1 items-center justify-center gap-0.5">
        <IconButton label="Go to start (Home)" onClick={() => setPlayhead(0)} className={compact ? 'hidden' : ''}>
          <SkipBack size={15} />
        </IconButton>
        <IconButton label="Previous frame (←)" onClick={() => step(-1)}>
          <StepBack size={15} />
        </IconButton>
        <button
          onClick={() => setPlaying(!playing)}
          className="mx-1 flex h-9 w-9 items-center justify-center rounded-full bg-fg text-bg transition-transform hover:scale-105 active:scale-95"
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" className="ml-0.5" />}
        </button>
        <IconButton label="Next frame (→)" onClick={() => step(1)}>
          <StepForward size={15} />
        </IconButton>
        <IconButton label="Go to end (End)" onClick={() => setPlayhead(duration)} className={compact ? 'hidden' : ''}>
          <SkipForward size={15} />
        </IconButton>
      </div>
      <MotionPathToggle />
      <MasterVolume compact={compact} />
      <div className={`items-center justify-end gap-2 text-xs text-muted ${compact ? 'hidden' : 'flex w-40'}`}>
        <span className="hidden xl:inline">
          {settings.width}×{settings.height}
        </span>
        <select
          value={String(quality)}
          onChange={(e) => onQuality((['auto', 'full'].includes(e.target.value) ? e.target.value : Number(e.target.value)) as Quality)}
          className="h-7 rounded-md border border-line bg-bg px-1.5 text-xs text-fg outline-none focus:border-accent"
          title="Preview quality"
        >
          <option value="auto">Auto</option>
          <option value="360">360p</option>
          <option value="480">480p</option>
          <option value="720">720p</option>
          <option value="1080">1080p</option>
          <option value="full">Full</option>
        </select>
      </div>
    </div>
  )
}

function MotionPathToggle() {
  const on = usePrefs((p) => p.motionPath)
  return (
    <IconButton
      label={on ? 'Hide motion paths' : 'Show motion paths'}
      active={on}
      onClick={() => usePrefs.getState().setMotionPath(!on)}
    >
      <Route size={15} />
    </IconButton>
  )
}

/** Preview volume for this browser only (does not change the project's audio). */
function MasterVolume({ compact }: { compact: boolean }) {
  const volume = usePrefs((p) => p.volume)
  const muted = usePrefs((p) => p.muted)
  const { setVolume, setMuted } = usePrefs.getState()
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  return (
    <div className="flex items-center gap-1" title="Preview volume (only affects playback here, not the project)">
      <IconButton
        label={muted ? 'Unmute preview' : 'Mute preview'}
        active={muted}
        onClick={() => setMuted(!muted)}
      >
        <Icon size={15} />
      </IconButton>
      {!compact && (
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={muted ? 0 : Math.round(volume * 100)}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          className="w-20"
          aria-label="Preview volume"
        />
      )}
    </div>
  )
}

type Drag =
  | { kind: 'move'; id: string; px: number; py: number; x: number; y: number }
  | { kind: 'scale'; id: string; cx: number; cy: number; dist: number; scale: number }
  | { kind: 'rotate'; id: string; cx: number; cy: number; angle: number; rotation: number }

/** Selection box + handles over the preview (move / scale / rotate). */
function TransformOverlay({ width }: { width: number }) {
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const textSizes = useEditor((s) => s.textSizes)
  const selection = useEditor((s) => s.selection)
  const playhead = useEditor((s) => s.playhead)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const coarse = useMediaQuery('(pointer: coarse)')
  const handle = coarse ? 22 : 10
  const drag = useRef<Drag | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const k = width / doc.settings.width

  const assetMap = useMemo(() => new Map<string, Asset>(assetsWithSequences(assets, doc).map((a) => [a.id, a])), [assets, doc])

  // Visible visual layers at the playhead, top-most first.
  const layers = useMemo(() => {
    const rank = new Map(doc.tracks.map((t, i) => [t.id, i]))
    const hidden = new Set(doc.tracks.filter((t) => t.hidden).map((t) => t.id))
    return doc.clips
      .filter((c) => c.type !== 'audio' && !hidden.has(c.track_id) && c.start <= playhead + 1e-6 && clipEnd(c) > playhead + 1e-6)
      .sort((a, b) => (rank.get(a.track_id) ?? 0) - (rank.get(b.track_id) ?? 0))
      .map((c) => layerOf(c, doc.settings, assetMap, textSizes, playhead))
      .filter((l): l is Layer => l !== null)
  }, [doc, playhead, assetMap, textSizes])

  const selected = layers.filter((l) => selection.includes(l.clip.id))

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const s = useEditor.getState()
      const p = toProject(e)
      if (d.kind === 'move') {
        let x = d.x + (p.x - d.px)
        let y = d.y + (p.y - d.py)
        const snap = 8 / k
        const v = !e.altKey && Math.abs(x) < snap
        const h = !e.altKey && Math.abs(y) < snap
        if (v) x = 0
        if (h) y = 0
        setGuides({ v, h })
        s.setProps(d.id, { x: Math.round(x), y: Math.round(y) })
      } else if (d.kind === 'scale') {
        const dist = Math.hypot(p.x - d.cx, p.y - d.cy)
        const scale = clamp((d.scale * dist) / Math.max(1, d.dist), 0.01, 20)
        s.setProps(d.id, { scale: Math.round(scale * 1000) / 1000 })
      } else {
        const angle = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI
        let rot = d.rotation + angle - d.angle
        rot = ((((rot + 180) % 360) + 360) % 360) - 180
        if (e.shiftKey) rot = Math.round(rot / 15) * 15
        s.setProps(d.id, { rotation: Math.round(rot * 10) / 10 })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [k],
  )

  const onPointerUp = useCallback(() => {
    drag.current = null
    setGuides({ v: false, h: false })
    useEditor.getState().endGesture()
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
  }, [onPointerMove])

  const startDrag = (d: Drag) => {
    const locked = useEditor.getState().doc.tracks.find((t) => t.id === useEditor.getState().doc.clips.find((c) => c.id === d.id)?.track_id)?.locked
    if (locked) return
    drag.current = d
    useEditor.getState().beginGesture()
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  useEffect(() => () => onPointerUp(), [onPointerUp])

  const onStageDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = toProject(e)
    // Prefer the already-selected layer if it's under the pointer, then top-most.
    const hit = selected.find((l) => hitTest(l, p.x, p.y)) ?? layers.find((l) => hitTest(l, p.x, p.y))
    const s = useEditor.getState()
    if (!hit) {
      if (!e.shiftKey) s.select([])
      return
    }
    if (e.shiftKey) s.toggleSelect(hit.clip.id)
    else if (!selection.includes(hit.clip.id)) s.select([hit.clip.id])
    e.preventDefault()
    startDrag({ kind: 'move', id: hit.clip.id, px: p.x, py: p.y, x: hit.transform.x, y: hit.transform.y })
  }

  return (
    <div ref={ref} className="absolute inset-0 touch-none overflow-hidden select-none" onPointerDown={onStageDown}>
      {guides.v && <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-accent-2/80" />}
      {guides.h && <div className="pointer-events-none absolute top-1/2 right-0 left-0 h-px bg-accent-2/80" />}
      <MotionPath width={width} />
      {selected.map((l) => {
        const w = l.width * k
        const h = l.height * k
        return (
          <div
            key={l.clip.id}
            className="pointer-events-none absolute"
            style={{
              left: l.cx * k - w / 2,
              top: l.cy * k - h / 2,
              width: w,
              height: h,
              transform: `rotate(${l.rotation}deg)`,
            }}
          >
            <div className="absolute inset-0 outline outline-1 outline-accent-2 [box-shadow:0_0_0_1px_rgba(0,0,0,.35)]" />
            {selected.length === 1 &&
              (['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <div
                  key={corner}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const p = toProject(e)
                    startDrag({
                      kind: 'scale',
                      id: l.clip.id,
                      cx: l.cx,
                      cy: l.cy,
                      dist: Math.hypot(p.x - l.cx, p.y - l.cy),
                      scale: l.transform.scale,
                    })
                  }}
                  className={`pointer-events-auto absolute border border-accent-2 bg-white ${coarse ? 'rounded-full' : 'rounded-sm'}`}
                  style={{
                    width: handle,
                    height: handle,
                    left: corner.endsWith('w') ? -handle / 2 : undefined,
                    right: corner.endsWith('e') ? -handle / 2 : undefined,
                    top: corner.startsWith('n') ? -handle / 2 : undefined,
                    bottom: corner.startsWith('s') ? -handle / 2 : undefined,
                    cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                  }}
                />
              ))}
            {selected.length === 1 && (
              <>
                <div className="absolute left-1/2 w-px bg-accent-2/70" style={{ top: -handle * 2, height: handle * 2 }} />
                <div
                  title="Rotate (Shift snaps to 15°)"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    const p = toProject(e)
                    startDrag({
                      kind: 'rotate',
                      id: l.clip.id,
                      cx: l.cx,
                      cy: l.cy,
                      angle: (Math.atan2(p.y - l.cy, p.x - l.cx) * 180) / Math.PI,
                      rotation: l.transform.rotation,
                    })
                  }}
                  className="pointer-events-auto absolute left-1/2 -translate-x-1/2 cursor-grab rounded-full border border-accent-2 bg-white"
                  style={{ top: -handle * 2 - handle / 2, width: handle, height: handle }}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
