import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  Plus,
  Scissors,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Asset, Clip, Track } from '../api/types'
import { IconButton } from '../components/ui'
import { clamp } from '../lib/format'
import { ASSET_MIME } from './MediaBin'
import { clipEnd, docDuration, maxClipDuration, MIN_CLIP, overlaps, useEditor } from './store'

const HEADER_W = 176
const RULER_H = 28
const TRACK_H = { video: 64, audio: 52 } as const
const SNAP_PX = 8

type DragState =
  | {
      kind: 'move'
      primary: string
      startX: number
      startY: number
      originals: Map<string, { start: number; track_id: string }>
      active: boolean
    }
  | { kind: 'trim-start' | 'trim-end'; id: string; startX: number; original: Clip; active: boolean }

export function Timeline({ projectId }: { projectId: string }) {
  const tracks = useEditor((s) => s.doc.tracks)
  const clips = useEditor((s) => s.doc.clips)
  const zoom = useEditor((s) => s.zoom)
  const assets = useEditor((s) => s.assets)
  const selection = useEditor((s) => s.selection)
  const duration = useEditor((s) => docDuration(s.doc))
  const scrollRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 1000 })
  const drag = useRef<DragState | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)

  const assetMap = useMemo(() => new Map<string, Asset>(assets.map((a) => [a.id, a])), [assets])
  const contentSeconds = Math.max(duration + 30, (view.width - HEADER_W) / zoom)
  const contentWidth = contentSeconds * zoom

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const s = useEditor.getState()
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left - HEADER_W + el.scrollLeft
      const t = x / s.zoom
      const next = clamp(s.zoom * Math.pow(1.0015, -e.deltaY), 4, 800)
      s.setZoom(next)
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - (e.clientX - rect.left - HEADER_W)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Follow the playhead while playing.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const el = scrollRef.current
        if (!el || !s.playing || s.playhead === prev.playhead) return
        const x = s.playhead * s.zoom
        const visibleW = el.clientWidth - HEADER_W
        if (x > el.scrollLeft + visibleW - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80)
      }),
    [],
  )

  const timeAt = useCallback((clientX: number) => {
    const el = scrollRef.current!
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / useEditor.getState().zoom)
  }, [])

  const trackAt = useCallback(
    (clientY: number): Track | null => {
      const lanes = lanesRef.current
      if (!lanes) return null
      let y = clientY - lanes.getBoundingClientRect().top
      for (const t of useEditor.getState().doc.tracks) {
        const h = TRACK_H[t.kind]
        if (y >= 0 && y < h) return t
        y -= h
      }
      return null
    },
    [],
  )

  // ---- snapping ---------------------------------------------------------------------
  const snapTargets = useCallback((exclude: Set<string>) => {
    const s = useEditor.getState()
    const pts = [0, s.playhead]
    for (const c of s.doc.clips) {
      if (exclude.has(c.id)) continue
      pts.push(c.start, clipEnd(c))
    }
    return pts
  }, [])

  const snap = useCallback((times: number[], targets: number[]): { delta: number; at: number | null } => {
    const s = useEditor.getState()
    if (!s.snapping) return { delta: 0, at: null }
    const tol = SNAP_PX / s.zoom
    let best = { delta: 0, at: null as number | null, dist: tol }
    for (const t of times)
      for (const p of targets) {
        const d = Math.abs(p - t)
        if (d < best.dist) best = { delta: p - t, at: p, dist: d }
      }
    return { delta: best.delta, at: best.at }
  }, [])

  // ---- drag handling ------------------------------------------------------------------
  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const s = useEditor.getState()
      if (!d.active) {
        if (Math.abs(e.clientX - d.startX) < 3 && (d.kind !== 'move' || Math.abs(e.clientY - d.startY) < 3)) return
        d.active = true
        s.beginGesture()
      }
      const dt = (e.clientX - d.startX) / s.zoom
      const clipsNow = s.doc.clips

      if (d.kind === 'move') {
        const moving = new Set(d.originals.keys())
        const prim = d.originals.get(d.primary)!
        const primClip = clipsNow.find((c) => c.id === d.primary)!
        // Only a single clip may change track.
        let targetTrack = prim.track_id
        if (moving.size === 1) {
          const t = trackAt(e.clientY)
          const kind = s.doc.tracks.find((x) => x.id === prim.track_id)?.kind
          if (t && t.kind === kind && !t.locked) targetTrack = t.id
        }
        let delta = dt
        const minStart = Math.min(...[...d.originals.values()].map((o) => o.start))
        delta = Math.max(delta, -minStart)
        const sn = snap([prim.start + delta, prim.start + delta + primClip.duration], snapTargets(moving))
        if (sn.at !== null && prim.start + delta + sn.delta >= 0 && minStart + delta + sn.delta >= 0) delta += sn.delta
        setSnapLine(sn.at)

        const next = clipsNow.map((c) => {
          const o = d.originals.get(c.id)
          if (!o) return c
          return { ...c, start: o.start + delta, track_id: c.id === d.primary ? targetTrack : o.track_id }
        })
        const valid = next
          .filter((c) => moving.has(c.id))
          .every((c) => !overlaps(next, c.track_id, c.start, c.duration, moving))
        if (valid) s.change((doc) => ({ ...doc, clips: next }))
      } else {
        const o = d.original
        const asset = o.asset_id ? assetMap.get(o.asset_id) : undefined
        const others = clipsNow.filter((c) => c.track_id === o.track_id && c.id !== o.id)
        const hasSource = o.type === 'video' || o.type === 'audio'
        if (d.kind === 'trim-start') {
          const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= o.start + 1e-6).map(clipEnd))
          const lower = Math.max(prevEnd, hasSource ? o.start - o.in_point / o.speed : 0)
          let start = o.start + dt
          const sn = snap([start], snapTargets(new Set([o.id])))
          start += sn.delta
          setSnapLine(sn.at)
          start = clamp(start, lower, clipEnd(o) - MIN_CLIP)
          s.updateClip(o.id, {
            start,
            duration: clipEnd(o) - start,
            in_point: hasSource ? Math.max(0, o.in_point + (start - o.start) * o.speed) : o.in_point,
          })
        } else {
          const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= clipEnd(o) - 1e-6).map((c) => c.start))
          const upper = Math.min(nextStart, o.start + maxClipDuration(o, asset))
          let end = clipEnd(o) + dt
          const sn = snap([end], snapTargets(new Set([o.id])))
          end += sn.delta
          setSnapLine(sn.at)
          end = clamp(end, o.start + MIN_CLIP, upper)
          s.updateClip(o.id, { duration: end - o.start })
        }
      }
    },
    [assetMap, snap, snapTargets, trackAt],
  )

  const onUp = useCallback(() => {
    if (drag.current?.active) useEditor.getState().endGesture()
    drag.current = null
    setSnapLine(null)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }, [onMove])

  useEffect(() => () => onUp(), [onUp])

  const beginDrag = (d: DragState) => {
    drag.current = d
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onClipDown = (e: React.PointerEvent, clip: Clip, part: 'body' | 'start' | 'end') => {
    if (e.button !== 0) return
    e.stopPropagation()
    const s = useEditor.getState()
    const track = s.doc.tracks.find((t) => t.id === clip.track_id)
    if (e.shiftKey) {
      s.toggleSelect(clip.id)
      return
    }
    let sel = s.selection
    if (!sel.includes(clip.id)) {
      sel = [clip.id]
      s.select(sel)
    }
    if (track?.locked) return
    if (part === 'body') {
      const lockedTracks = new Set(s.doc.tracks.filter((t) => t.locked).map((t) => t.id))
      const originals = new Map(
        s.doc.clips
          .filter((c) => sel.includes(c.id) && !lockedTracks.has(c.track_id))
          .map((c) => [c.id, { start: c.start, track_id: c.track_id }]),
      )
      beginDrag({ kind: 'move', primary: clip.id, startX: e.clientX, startY: e.clientY, originals, active: false })
    } else {
      s.select([clip.id])
      beginDrag({ kind: part === 'start' ? 'trim-start' : 'trim-end', id: clip.id, startX: e.clientX, original: clip, active: false })
    }
  }

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const s = useEditor.getState()
    s.setPlayhead(timeAt(e.clientX))
    const move = (ev: PointerEvent) => useEditor.getState().setPlayhead(timeAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onLaneDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (!e.shiftKey) useEditor.getState().select([])
    scrub(e)
  }

  const onDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(ASSET_MIME)
    if (!id) return
    e.preventDefault()
    const asset = assetMap.get(id)
    if (!asset) return
    useEditor.getState().addAssetClip(asset, { trackId: track.id, start: timeAt(e.clientX) })
  }

  const clipsByTrack = useMemo(() => {
    const m = new Map<string, Clip[]>()
    for (const c of clips) m.set(c.track_id, [...(m.get(c.track_id) ?? []), c])
    return m
  }, [clips])

  const visible = { from: view.left / zoom - 1, to: (view.left + view.width) / zoom + 1 }

  return (
    <div className="flex h-full flex-col bg-panel">
      <Toolbar />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: HEADER_W + contentWidth, minHeight: '100%' }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 shrink-0 border-r border-b border-line bg-panel" style={{ width: HEADER_W }} />
            <div className="relative flex-1 cursor-text border-b border-line bg-panel-2" onPointerDown={scrub}>
              <Ruler zoom={zoom} from={visible.from} to={visible.to} />
            </div>
          </div>

          {/* Tracks */}
          <div ref={lanesRef}>
            {tracks.map((track, i) => (
              <div key={track.id} className="flex" style={{ height: TRACK_H[track.kind] }}>
                <TrackHeader track={track} index={i} count={tracks.length} />
                <div
                  className={`relative flex-1 border-b border-line ${track.kind === 'audio' ? 'bg-[#13161b]' : 'bg-bg'} ${
                    track.hidden || track.muted ? 'opacity-50' : ''
                  }`}
                  onPointerDown={onLaneDown}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(ASSET_MIME)) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'copy'
                    }
                  }}
                  onDrop={(e) => onDrop(e, track)}
                >
                  {(clipsByTrack.get(track.id) ?? [])
                    .filter((c) => clipEnd(c) >= visible.from && c.start <= visible.to)
                    .map((c) => (
                      <TimelineClip
                        key={c.id}
                        projectId={projectId}
                        clip={c}
                        asset={c.asset_id ? assetMap.get(c.asset_id) : undefined}
                        zoom={zoom}
                        height={TRACK_H[track.kind]}
                        selected={selection.includes(c.id)}
                        locked={track.locked}
                        onDown={onClipDown}
                      />
                    ))}
                </div>
              </div>
            ))}
            {tracks.length === 0 && (
              <div className="p-6 text-center text-muted">No tracks — add one from the toolbar.</div>
            )}
          </div>

          {snapLine !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-warn"
              style={{ left: HEADER_W + snapLine * zoom }}
            />
          )}
          <Playhead />
        </div>
      </div>
    </div>
  )
}

function Playhead() {
  const playhead = useEditor((s) => s.playhead)
  const zoom = useEditor((s) => s.zoom)
  return (
    <div className="pointer-events-none absolute top-0 bottom-0 z-20" style={{ left: HEADER_W + playhead * zoom }}>
      <div className="sticky top-0 -ml-[6px] h-0 w-0 border-x-[6px] border-t-[9px] border-x-transparent border-t-danger" style={{ top: RULER_H - 9 }} />
      <div className="absolute top-0 bottom-0 w-px -translate-x-1/2 bg-danger" />
    </div>
  )
}

const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

function Ruler({ zoom, from, to }: { zoom: number; from: number; to: number }) {
  const fps = useEditor((s) => s.doc.settings.fps)
  const major = TICKS.find((t) => t * zoom >= 90) ?? 3600
  const minor = major / (major * zoom >= 200 ? 10 : 5)
  const ticks: { t: number; major: boolean }[] = []
  const start = Math.max(0, Math.floor(from / minor) * minor)
  for (let t = start; t <= to && ticks.length < 2000; t += minor) {
    const rounded = Math.round(t * 1000) / 1000
    ticks.push({ t: rounded, major: Math.abs(rounded / major - Math.round(rounded / major)) < 1e-6 })
  }
  const label = (t: number) => {
    const m = Math.floor(t / 60)
    const s = t % 60
    if (major < 1) {
      const frame = Math.round((s % 1) * fps)
      return `${m}:${String(Math.floor(s)).padStart(2, '0')}${frame ? `:${String(frame).padStart(2, '0')}` : ''}`
    }
    return `${m}:${String(Math.round(s)).padStart(2, '0')}`
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      {ticks.map(({ t, major: isMajor }) => (
        <div key={t} className="absolute bottom-0" style={{ left: t * zoom }}>
          <div className={`w-px ${isMajor ? 'h-3 bg-muted/70' : 'h-1.5 bg-faint/60'}`} />
          {isMajor && (
            <span className="tabular absolute bottom-3 left-1 font-mono text-[10px] whitespace-nowrap text-muted">{label(t)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function TrackHeader({ track, index, count }: { track: Track; index: number; count: number }) {
  const { updateTrack, removeTrack, moveTrack } = useEditor.getState()
  const [editing, setEditing] = useState(false)
  const hasClips = useEditor((s) => s.doc.clips.some((c) => c.track_id === track.id))
  const neighbours = useEditor((s) => s.doc.tracks)
  const canUp = index > 0 && neighbours[index - 1]?.kind === track.kind
  const canDown = index < count - 1 && neighbours[index + 1]?.kind === track.kind
  return (
    <div
      className="group sticky left-0 z-10 flex shrink-0 flex-col justify-center gap-1 border-r border-b border-line bg-panel px-2.5"
      style={{ width: HEADER_W }}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${track.kind === 'audio' ? 'bg-clip-audio' : 'bg-clip-video'}`} />
        {editing ? (
          <input
            autoFocus
            defaultValue={track.name}
            className="h-5 w-full min-w-0 rounded border border-accent bg-bg px-1 text-xs outline-none"
            onBlur={(e) => {
              if (e.target.value.trim()) updateTrack(track.id, { name: e.target.value.trim() })
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span className="truncate text-xs font-medium" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {track.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        {track.kind === 'video' ? (
          <IconButton label={track.hidden ? 'Show track' : 'Hide track'} active={track.hidden} onClick={() => updateTrack(track.id, { hidden: !track.hidden })} className="h-6! w-6!">
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        ) : null}
        <IconButton label={track.muted ? 'Unmute track' : 'Mute track'} active={track.muted} onClick={() => updateTrack(track.id, { muted: !track.muted })} className="h-6! w-6!">
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </IconButton>
        <IconButton label={track.locked ? 'Unlock track' : 'Lock track'} active={track.locked} onClick={() => updateTrack(track.id, { locked: !track.locked })} className="h-6! w-6!">
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </IconButton>
        <div className="flex-1" />
        <div className="flex opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton label="Move track up" disabled={!canUp} onClick={() => moveTrack(track.id, -1)} className="h-6! w-5!">
            <ChevronUp size={13} />
          </IconButton>
          <IconButton label="Move track down" disabled={!canDown} onClick={() => moveTrack(track.id, 1)} className="h-6! w-5!">
            <ChevronDown size={13} />
          </IconButton>
          <IconButton
            label={hasClips ? 'Delete track and its clips' : 'Delete track'}
            onClick={() => {
              if (!hasClips || window.confirm(`Delete “${track.name}” and all clips on it?`)) removeTrack(track.id)
            }}
            className="h-6! w-6! hover:text-danger!"
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

function Toolbar() {
  const zoom = useEditor((s) => s.zoom)
  const snapping = useEditor((s) => s.snapping)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const s = useEditor.getState()
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      <IconButton label="Split at playhead (S)" onClick={s.splitAtPlayhead}>
        <Scissors size={15} />
      </IconButton>
      <IconButton label="Duplicate (Ctrl+D)" onClick={s.duplicateSelected} disabled={!hasSelection}>
        <Copy size={15} />
      </IconButton>
      <IconButton label="Delete (Del)" onClick={s.deleteSelected} disabled={!hasSelection}>
        <Trash2 size={15} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-line" />
      <IconButton label="Add text (T)" onClick={() => s.addTextClip()}>
        <Type size={15} />
      </IconButton>
      <button
        onClick={() => s.addTrack('video')}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
      >
        <Plus size={13} /> Video track
      </button>
      <button
        onClick={() => s.addTrack('audio')}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
      >
        <Plus size={13} /> Audio track
      </button>
      <div className="flex-1" />
      <IconButton label={snapping ? 'Snapping on' : 'Snapping off'} active={snapping} onClick={() => s.setSnapping(!snapping)}>
        <Magnet size={15} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-line" />
      <IconButton label="Zoom out (−)" onClick={() => s.setZoom(zoom / 1.25)}>
        <ZoomOut size={15} />
      </IconButton>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={Math.log(zoom / 4) / Math.log(200)}
        onChange={(e) => s.setZoom(4 * Math.pow(200, Number(e.target.value)))}
        className="w-28"
        aria-label="Timeline zoom"
      />
      <IconButton label="Zoom in (+)" onClick={() => s.setZoom(zoom * 1.25)}>
        <ZoomIn size={15} />
      </IconButton>
    </div>
  )
}

// ---- clips -------------------------------------------------------------------------------

const CLIP_COLORS: Record<Clip['type'], string> = {
  video: 'bg-clip-video/80 border-clip-video',
  image: 'bg-clip-image/80 border-clip-image',
  text: 'bg-clip-text/80 border-clip-text',
  audio: 'bg-clip-audio/80 border-clip-audio',
}

const TimelineClip = memo(function TimelineClip({
  projectId,
  clip,
  asset,
  zoom,
  height,
  selected,
  locked,
  onDown,
}: {
  projectId: string
  clip: Clip
  asset: Asset | undefined
  zoom: number
  height: number
  selected: boolean
  locked: boolean
  onDown: (e: React.PointerEvent, clip: Clip, part: 'body' | 'start' | 'end') => void
}) {
  const left = clip.start * zoom
  const width = Math.max(2, clip.duration * zoom)
  const label =
    clip.type === 'text' ? (clip.text?.content.split('\n')[0] ?? 'Text') : (asset?.original_name ?? 'Missing media')
  const ready = asset?.status === 'ready'
  const bodyH = height - 4 - 16
  const showFilm = ready && (clip.type === 'video' || clip.type === 'image') && asset!.thumb_count > 0
  const showWave = ready && asset!.has_audio && (clip.type === 'audio' || clip.type === 'video')

  return (
    <div
      className={`absolute top-0.5 overflow-hidden rounded-md border ${CLIP_COLORS[clip.type]} ${
        selected ? 'z-[5] ring-2 ring-white/90' : ''
      } ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${!asset && clip.type !== 'text' ? 'opacity-50' : ''}`}
      style={{ left, width, height: height - 4 }}
      onPointerDown={(e) => onDown(e, clip, 'body')}
      title={label}
    >
      <div className="flex h-4 items-center gap-1 overflow-hidden px-1.5 text-[10px] leading-4 font-medium whitespace-nowrap text-white/95">
        {clip.muted && <VolumeX size={10} />}
        <span className="truncate">{label}</span>
        {clip.speed !== 1 && <span className="rounded bg-black/30 px-0.5">{clip.speed}×</span>}
      </div>
      <div className="relative overflow-hidden" style={{ height: bodyH }}>
        {showFilm && (
          <Filmstrip projectId={projectId} clip={clip} asset={asset!} zoom={zoom} width={width} height={showWave && clip.type === 'video' ? bodyH - 12 : bodyH} />
        )}
        {clip.type === 'text' && (
          <div className="truncate px-1.5 text-[11px] text-white/70 italic">{clip.text?.font}</div>
        )}
        {showWave && (
          <div className="absolute inset-x-0 bottom-0" style={{ height: clip.type === 'video' ? 12 : bodyH }}>
            <Waveform projectId={projectId} clip={clip} asset={asset!} zoom={zoom} width={width} height={clip.type === 'video' ? 12 : bodyH} />
          </div>
        )}
      </div>
      {/* Fades */}
      {clip.fade_in > 0 && (
        <div
          className="pointer-events-none absolute top-0 left-0 h-full bg-gradient-to-r from-black/50 to-transparent"
          style={{ width: clip.fade_in * zoom }}
        />
      )}
      {clip.fade_out > 0 && (
        <div
          className="pointer-events-none absolute top-0 right-0 h-full bg-gradient-to-l from-black/50 to-transparent"
          style={{ width: clip.fade_out * zoom }}
        />
      )}
      {!locked && (
        <>
          <div
            className="absolute top-0 left-0 z-[2] h-full w-2 cursor-ew-resize hover:bg-white/40"
            onPointerDown={(e) => onDown(e, clip, 'start')}
          />
          <div
            className="absolute top-0 right-0 z-[2] h-full w-2 cursor-ew-resize hover:bg-white/40"
            onPointerDown={(e) => onDown(e, clip, 'end')}
          />
        </>
      )}
    </div>
  )
})

function Filmstrip({
  projectId,
  clip,
  asset,
  zoom,
  width,
  height,
}: {
  projectId: string
  clip: Clip
  asset: Asset
  zoom: number
  width: number
  height: number
}) {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const tileW = Math.max(8, height * aspect)
  const count = Math.min(300, Math.ceil(width / tileW))
  const url = api.filmstripUrl(projectId, asset.id)
  const tiles = []
  for (let i = 0; i < count; i++) {
    let idx = 0
    if (clip.type === 'video' && asset.thumb_interval > 0) {
      const srcT = clip.in_point + ((i * tileW) / zoom) * clip.speed
      idx = clamp(Math.floor(srcT / asset.thumb_interval), 0, asset.thumb_count - 1)
    }
    tiles.push(
      <div
        key={i}
        className="h-full shrink-0"
        style={{
          width: tileW,
          backgroundImage: `url(${url})`,
          backgroundSize: `${tileW * asset.thumb_count}px ${height}px`,
          backgroundPosition: `${-idx * tileW}px 0`,
        }}
      />,
    )
  }
  return (
    <div className="pointer-events-none flex opacity-80" style={{ height }}>
      {tiles}
    </div>
  )
}

const waveCache = new Map<string, Promise<Uint8Array>>()

function loadWave(projectId: string, assetId: string) {
  const key = `${projectId}/${assetId}`
  let p = waveCache.get(key)
  if (!p) {
    p = fetch(api.waveformUrl(projectId, assetId))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no waveform'))))
      .then((b) => new Uint8Array(b))
    p.catch(() => waveCache.delete(key))
    waveCache.set(key, p)
  }
  return p
}

const PEAKS_PER_SECOND = 100

function Waveform({
  projectId,
  clip,
  asset,
  zoom,
  width,
  height,
}: {
  projectId: string
  clip: Clip
  asset: Asset
  zoom: number
  width: number
  height: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Uint8Array | null>(null)
  useEffect(() => {
    let alive = true
    loadWave(projectId, asset.id)
      .then((p) => alive && setPeaks(p))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, asset.id])

  const cw = Math.min(Math.ceil(width), 8000)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !peaks) return
    const ctx = canvas.getContext('2d')!
    canvas.width = cw
    canvas.height = height
    ctx.clearRect(0, 0, cw, height)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const secondsPerPx = width / cw / zoom
    const mid = clip.type === 'audio' ? height / 2 : height
    for (let x = 0; x < cw; x++) {
      const t0 = clip.in_point + x * secondsPerPx * clip.speed
      const t1 = t0 + secondsPerPx * clip.speed
      const a = Math.floor(t0 * PEAKS_PER_SECOND)
      const b = Math.max(a + 1, Math.floor(t1 * PEAKS_PER_SECOND))
      let m = 0
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i]
      const amp = (m / 255) * Math.min(1, clip.volume) * (clip.type === 'audio' ? height / 2 : height)
      if (clip.type === 'audio') ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2))
      else ctx.fillRect(x, height - amp, 1, Math.max(1, amp))
    }
  }, [peaks, cw, width, height, zoom, clip.in_point, clip.speed, clip.volume, clip.type])

  return <canvas ref={ref} className="pointer-events-none h-full" style={{ width }} />
}
