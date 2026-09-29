import { Crosshair, Move3d, Scan, SquareDashed, Trash2, Vibrate } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import type { Asset, Clip, Stabilize, TrackData, Tracker, TrackerKind, TrackStatus } from '../api/types'
import { Section } from '../components/Section'
import { toast } from '../components/toast'
import { IconButton, ProgressBar } from '../components/ui'
import { uid } from '../lib/format'
import { layerOf, type Layer } from './geometry'
import { assetsWithSequences, clipEnd, type ClipPatch, useEditor } from './store'

export const KINDS: { kind: TrackerKind; label: string; hint: string; icon: React.ReactNode }[] = [
  { kind: 'point', label: 'Position', hint: 'Follow one spot. Attach text, stickers or effects to it.', icon: <Crosshair size={14} /> },
  { kind: 'transform', label: 'Position, rotation & scale', hint: 'Follow a region that also turns or gets closer.', icon: <Move3d size={14} /> },
  { kind: 'corner_pin', label: 'Corner pin', hint: 'Follow a flat surface (screen, sign, poster) in perspective and put a clip on it.', icon: <SquareDashed size={14} /> },
  { kind: 'stabilize', label: 'Stabilize', hint: 'Remove camera shake: smooth it out or lock the shot completely.', icon: <Vibrate size={14} /> },
]
const kindLabel = (k: TrackerKind) => KINDS.find((x) => x.kind === k)!.label

/** View state: which tracker's region is being edited, statuses, fetched results. */
export const useTracking = create<{
  editing: { clipId: string; trackerId: string } | null
  status: Record<string, TrackStatus>
  results: Record<string, TrackData>
}>(() => ({ editing: null, status: {}, results: {} }))

// -- geometry --------------------------------------------------------------------------

/** Normalised source point -> canvas (project px), through the clip's placement. */
export function toCanvas(layer: Layer, nx: number, ny: number): [number, number] {
  const c = layer.clip.crop
  let fx = (nx - c.left) / Math.max(1e-6, 1 - c.left - c.right) - 0.5
  let fy = (ny - c.top) / Math.max(1e-6, 1 - c.top - c.bottom) - 0.5
  if (layer.transform.flip_h) fx = -fx
  if (layer.transform.flip_v) fy = -fy
  const lx = fx * layer.width
  const ly = fy * layer.height
  const a = (layer.rotation * Math.PI) / 180
  return [layer.cx + lx * Math.cos(a) - ly * Math.sin(a), layer.cy + lx * Math.sin(a) + ly * Math.cos(a)]
}

export function toSource(layer: Layer, px: number, py: number): [number, number] {
  const a = (-layer.rotation * Math.PI) / 180
  const dx = px - layer.cx
  const dy = py - layer.cy
  let fx = (dx * Math.cos(a) - dy * Math.sin(a)) / Math.max(1e-6, layer.width)
  let fy = (dx * Math.sin(a) + dy * Math.cos(a)) / Math.max(1e-6, layer.height)
  if (layer.transform.flip_h) fx = -fx
  if (layer.transform.flip_v) fy = -fy
  const c = layer.clip.crop
  return [c.left + (fx + 0.5) * (1 - c.left - c.right), c.top + (fy + 0.5) * (1 - c.top - c.bottom)]
}

const sourceTime = (clip: Clip, t: number) => clip.in_point + Math.max(0, Math.min(clip.duration, t - clip.start)) * clip.speed

/** Linear interpolation of a result row at source time t (clamped). */
export function sampleAt(data: TrackData, t: number): number[] | null {
  const rows = data.kind === 'stabilize' ? data.path : data.samples
  const times = data.times
  if (!rows?.length) return null
  if (t <= times[0]) return rows[0]
  if (t >= times[times.length - 1]) return rows[rows.length - 1]
  let i = Math.min(times.length - 2, Math.max(0, Math.floor((t - times[0]) * data.fps)))
  while (i > 0 && times[i] > t) i--
  while (i < times.length - 2 && times[i + 1] < t) i++
  const f = (t - times[i]) / Math.max(1e-9, times[i + 1] - times[i])
  return rows[i].map((v, j) => v + (rows[i + 1][j] - v) * f)
}

// -- actions -----------------------------------------------------------------------------

function setTrackers(clipId: string, fn: (ts: Tracker[]) => Tracker[]) {
  const s = useEditor.getState()
  const clip = s.doc.clips.find((c) => c.id === clipId)
  if (clip) s.updateClip(clipId, { trackers: fn(clip.trackers ?? []) })
}

/** Regions are placed on a frame of the clip: bring the playhead into it. */
function showClip(clip: Clip) {
  const s = useEditor.getState()
  if (s.playhead < clip.start || s.playhead >= clipEnd(clip)) s.setPlayhead(clip.start)
}

export function addTracker(clip: Clip, asset: Asset, kind: TrackerKind) {
  showClip(clip)
  const s = useEditor.getState()
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const n = (clip.trackers ?? []).filter((t) => t.kind === kind).length + 1
  const tracker: Tracker = {
    id: uid('k_'),
    name: `${kindLabel(kind)} ${n}`,
    kind,
    ref: sourceTime(clip, s.playhead),
    box: [0.5, 0.5, 0.08, Math.min(0.5, 0.08 * aspect)],
    quad: [
      [0.35, 0.3],
      [0.65, 0.3],
      [0.65, 0.7],
      [0.35, 0.7],
    ],
    // What the clip shows now; trimming later only holds the first / last tracked frame.
    start: clip.in_point,
    end: clip.in_point + clip.duration * clip.speed,
    quality: 'fast',
  }
  const patch: ClipPatch = { trackers: [...(clip.trackers ?? []), tracker] }
  if (kind === 'stabilize')
    patch.stabilize = { tracker_id: tracker.id, mode: 'smooth', smoothness: 1, rotation: true, scale: false, auto_zoom: true }
  s.updateClip(clip.id, patch)
  if (kind !== 'stabilize') useTracking.setState({ editing: { clipId: clip.id, trackerId: tracker.id } })
}

export function removeTracker(clipId: string, trackerId: string) {
  const s = useEditor.getState()
  s.change((d) => ({
    ...d,
    clips: d.clips.map((c) => {
      let next = c
      if (c.id === clipId) next = { ...next, trackers: (c.trackers ?? []).filter((t) => t.id !== trackerId) }
      if (c.follow?.clip_id === clipId && c.follow.tracker_id === trackerId) next = { ...next, follow: null }
      if (c.pin?.clip_id === clipId && c.pin.tracker_id === trackerId) next = { ...next, pin: null }
      if (c.id === clipId && c.stabilize?.tracker_id === trackerId) next = { ...next, stabilize: null }
      return next
    }),
  }))
  const e = useTracking.getState().editing
  if (e?.trackerId === trackerId) useTracking.setState({ editing: null })
}

// -- sync: statuses, and automatic analysis when a tracker changes ------------------------------

export function useTrackingSync(projectId: string) {
  const clips = useEditor((s) => s.doc.clips)
  const editing = useTracking((s) => s.editing)
  const status = useTracking((s) => s.status)
  const busy = Object.values(status).some((x) => x.state === 'tracking' || x.state === 'queued')
  const items = useMemo(
    () =>
      clips.flatMap((c) =>
        c.asset_id && c.type === 'video' ? (c.trackers ?? []).map((t) => ({ clipId: c.id, asset_id: c.asset_id!, tracker: t })) : [],
      ),
    [clips],
  )
  const started = useRef(new Set<string>())

  useEffect(() => {
    if (!items.length) return
    let alive = true
    const tick = async () => {
      try {
        const res = await api.trackingStatus(
          projectId,
          items.map(({ asset_id, tracker }) => ({ asset_id, tracker })),
        )
        if (!alive) return
        useTracking.setState({ status: Object.fromEntries(res.map((r) => [r.tracker_id, r])) })
        // Changed / new trackers are analysed automatically (not while their region is being placed).
        for (const r of res) {
          const it = items.find((x) => x.tracker.id === r.tracker_id)
          if (!it || r.state !== 'none' || started.current.has(r.key)) continue
          if (editing?.trackerId === r.tracker_id) continue
          started.current.add(r.key)
          api.trackingRun(projectId, { asset_id: it.asset_id, tracker: it.tracker }).catch((e) => {
            started.current.delete(r.key)
            toast.error(e)
          })
        }
      } catch {
        /* next tick */
      }
    }
    const first = window.setTimeout(tick, 500)
    const id = window.setInterval(tick, busy ? 1000 : 4000)
    return () => {
      alive = false
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [projectId, items, editing, busy])
}

/** Fetch (and cache) the result of a finished tracker. */
export function useTrackData(projectId: string | null, trackerId: string | undefined): TrackData | null {
  const st = useTracking((s) => (trackerId ? s.status[trackerId] : undefined))
  const data = useTracking((s) => (st?.state === 'done' ? s.results[st.key] : undefined))
  useEffect(() => {
    if (!projectId || !st || st.state !== 'done' || data) return
    api
      .trackingResult(projectId, st.key)
      .then((d) => useTracking.setState((s) => ({ results: { ...s.results, [st.key]: d } })))
      .catch(() => {})
  }, [projectId, st, data])
  return data ?? null
}

// -- preview overlay ------------------------------------------------------------------------------

/** Region editor + tracked path over the preview. */
export function TrackerOverlay({ width }: { width: number }) {
  const editing = useTracking((s) => s.editing)
  const selection = useEditor((s) => s.selection)
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const textSizes = useEditor((s) => s.textSizes)
  const playhead = useEditor((s) => s.playhead)
  const projectId = useEditor((s) => s.projectId)
  const ref = useRef<HTMLDivElement>(null)
  const k = width / doc.settings.width

  // The clip whose trackers are shown: the one being edited, else the selected one.
  const clipId = editing?.clipId ?? (selection.length === 1 ? selection[0] : undefined)
  const clip = doc.clips.find((c) => c.id === clipId && (c.trackers?.length ?? 0) > 0)
  const assetMap = useMemo(() => new Map(assetsWithSequences(assets, doc).map((a) => [a.id, a])), [assets, doc])
  const inClip = clip && playhead >= clip.start - 1e-6 && playhead <= clipEnd(clip) + 1e-6
  const layer = clip && inClip ? layerOf(clip, doc.settings, assetMap, textSizes, playhead) : null
  const tracker = clip?.trackers?.find((t) => t.id === editing?.trackerId) ?? clip?.trackers?.find((t) => t.kind !== 'stabilize')
  const data = useTrackData(projectId, editing ? undefined : tracker?.id)
  if (!clip || !layer || !tracker || tracker.kind === 'stabilize') return null
  const isEditing = editing?.trackerId === tracker.id

  const P = (nx: number, ny: number) => {
    const [x, y] = toCanvas(layer, nx, ny)
    return [x * k, y * k] as const
  }
  const fromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return toSource(layer, (e.clientX - r.left) / k, (e.clientY - r.top) / k)
  }
  const drag = (e: React.PointerEvent, apply: (nx: number, ny: number, start: [number, number]) => Partial<Tracker>) => {
    e.stopPropagation()
    e.preventDefault()
    const s = useEditor.getState()
    s.beginGesture()
    const start = fromEvent(e)
    const move = (ev: PointerEvent) => {
      const [nx, ny] = fromEvent(ev)
      const patch = { ...apply(nx, ny, start), ref: sourceTime(clip, useEditor.getState().playhead) }
      setTrackers(clip.id, (ts) => ts.map((t) => (t.id === tracker.id ? { ...t, ...patch } : t)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      s.endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // The tracked result at the playhead (where the region is now).
  const now = data ? sampleAt(data, sourceTime(clip, playhead)) : null
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  let shape: React.ReactNode = null
  if (tracker.kind === 'corner_pin') {
    const quad = isEditing || !now ? tracker.quad : [0, 1, 2, 3].map((i) => [now[2 * i], now[2 * i + 1]] as [number, number])
    const pts = quad.map(([x, y]) => P(x, y))
    shape = (
      <>
        <polygon points={pts.map((p) => p.join(',')).join(' ')} className="fill-accent/10 stroke-accent-2" strokeWidth={1.5} />
        {isEditing &&
          pts.map(([x, y], i) => (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={7}
              className="cursor-move fill-white stroke-accent-2"
              strokeWidth={2}
              style={{ pointerEvents: 'all' }}
              onPointerDown={(e) =>
                drag(e, (nx, ny) => ({ quad: tracker.quad.map((q, j) => (j === i ? [clamp01(nx), clamp01(ny)] : q)) as Tracker['quad'] }))
              }
            />
          ))}
      </>
    )
  } else {
    const [cx, cy, bw, bh] = tracker.box
    const at = isEditing || !now ? [cx, cy] : [now[0], now[1]]
    const [x0, y0] = P(at[0] - bw / 2, at[1] - bh / 2)
    const [x1, y1] = P(at[0] + bw / 2, at[1] + bh / 2)
    const [px, py] = P(at[0], at[1])
    shape = (
      <>
        <rect
          x={Math.min(x0, x1)}
          y={Math.min(y0, y1)}
          width={Math.abs(x1 - x0)}
          height={Math.abs(y1 - y0)}
          className={`fill-accent/10 stroke-accent-2 ${isEditing ? 'cursor-move' : ''}`}
          strokeWidth={1.5}
          style={{ pointerEvents: isEditing ? 'all' : 'none' }}
          onPointerDown={(e) => drag(e, (nx, ny, s0) => ({ box: [clamp01(cx + nx - s0[0]), clamp01(cy + ny - s0[1]), bw, bh] }))}
        />
        <path d={`M${px - 6},${py}H${px + 6}M${px},${py - 6}V${py + 6}`} className="stroke-accent-2" strokeWidth={1.5} />
        {isEditing && (
          <rect
            x={Math.max(x0, x1) - 5}
            y={Math.max(y0, y1) - 5}
            width={10}
            height={10}
            className="cursor-nwse-resize fill-white stroke-accent-2"
            strokeWidth={2}
            style={{ pointerEvents: 'all' }}
            onPointerDown={(e) =>
              drag(e, (nx, ny) => ({ box: [cx, cy, Math.max(0.01, Math.abs(nx - cx) * 2), Math.max(0.01, Math.abs(ny - cy) * 2)] }))
            }
          />
        )}
      </>
    )
  }
  // Tracked path (point / transform): where the feature goes over the clip.
  let path: React.ReactNode = null
  if (data?.samples && tracker.kind !== 'corner_pin') {
    const step = Math.max(1, Math.floor(data.samples.length / 300))
    const pts = data.samples.filter((_, i) => i % step === 0).map((r) => P(r[0], r[1]).join(','))
    path = <polyline points={pts.join(' ')} className="fill-none stroke-accent-2/60" strokeWidth={1} strokeDasharray="3 3" />
  }
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-10">
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        {path}
        {shape}
      </svg>
      {isEditing && (
        <div className="pointer-events-auto absolute inset-x-0 bottom-2 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/75 px-3 py-1 text-xs text-white">
            {tracker.kind === 'corner_pin' ? 'Drag the corners onto the surface' : 'Drag the box over a detailed spot'}
            <button
              type="button"
              className="rounded-full bg-accent px-2 py-0.5 font-medium"
              onClick={() => useTracking.setState({ editing: null })}
            >
              Track
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

// -- inspector ------------------------------------------------------------------------------

export function MotionTrackingSection({ clip, asset, locked }: { clip: Clip; asset: Asset; locked: boolean }) {
  const projectId = useEditor((s) => s.projectId)
  const status = useTracking((s) => s.status)
  const editing = useTracking((s) => s.editing)
  const trackers = clip.trackers ?? []
  return (
    <Section icon={<Scan size={14} />} title="Motion tracking">
      <div className="grid grid-cols-2 gap-1.5">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            disabled={locked || (k.kind === 'stabilize' && !!clip.stabilize)}
            title={k.hint}
            onClick={() => addTracker(clip, asset, k.kind)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-left text-[11px] text-muted hover:border-line-strong hover:text-fg disabled:opacity-40"
          >
            {k.icon}
            {k.label}
          </button>
        ))}
      </div>
      {trackers.length === 0 && (
        <p className="text-[11px] text-faint">Pick what to track. Tracking runs on the server and is reused until you change the tracker.</p>
      )}
      {trackers.map((t) => {
        const st = status[t.id]
        const busy = st?.state === 'tracking' || st?.state === 'queued'
        return (
          <div key={t.id} className="rounded-lg border border-line p-2">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{t.name}</span>
              <span className={`text-[10px] ${st?.state === 'done' ? 'text-ok' : st?.state === 'error' ? 'text-danger' : 'text-muted'}`}>
                {st?.state === 'done'
                  ? 'Tracked'
                  : busy
                    ? `${st.state === 'queued' ? 'Waiting' : 'Tracking'} ${Math.round((st.progress ?? 0) * 100)}%`
                    : st?.state === 'error'
                      ? 'Failed'
                      : editing?.trackerId === t.id
                        ? 'Placing…'
                        : '…'}
              </span>
              {t.kind !== 'stabilize' && (
                <IconButton
                  label={editing?.trackerId === t.id ? 'Done placing' : 'Edit region'}
                  active={editing?.trackerId === t.id}
                  disabled={locked}
                  onClick={() => {
                    if (editing?.trackerId !== t.id) showClip(clip)
                    useTracking.setState({ editing: editing?.trackerId === t.id ? null : { clipId: clip.id, trackerId: t.id } })
                  }}
                >
                  <SquareDashed size={13} />
                </IconButton>
              )}
              <IconButton label="Delete tracker" disabled={locked} onClick={() => removeTracker(clip.id, t.id)}>
                <Trash2 size={13} />
              </IconButton>
            </div>
            {busy && <ProgressBar value={st.progress} className="mt-1.5" />}
            {st?.state === 'error' && <p className="mt-1 text-[11px] text-danger">{st.error}</p>}
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-faint">
              <span className="flex-1">{kindLabel(t.kind)}</span>
              <select
                value={t.quality}
                disabled={locked}
                onChange={(e) => setTrackers(clip.id, (ts) => ts.map((x) => (x.id === t.id ? { ...x, quality: e.target.value as Tracker['quality'] } : x)))}
                className="h-5 rounded border border-line bg-bg px-1 text-[10px] text-muted"
                aria-label="Tracking quality"
                title="Precise analyses the original video (up to 1080p): slower, a little more accurate"
              >
                <option value="fast">Fast</option>
                <option value="precise">Precise</option>
              </select>
            </div>
            {projectId && <ApplyControls clip={clip} tracker={t} locked={locked} />}
          </div>
        )
      })}
    </Section>
  )
}

/** How a tracker is used: which clip follows / is pinned, or the stabiliser's settings. */
function ApplyControls({ clip, tracker, locked }: { clip: Clip; tracker: Tracker; locked: boolean }) {
  const clips = useEditor((s) => s.doc.clips)
  const s = useEditor.getState()
  const targets = clips.filter((c) => c.id !== clip.id && c.type !== 'audio')
  const label = (c: Clip) =>
    c.type === 'text' ? `Text: ${c.text?.content.slice(0, 24) ?? ''}` : (s.assets.find((a) => a.id === c.asset_id)?.original_name ?? c.type)
  if (tracker.kind === 'stabilize') return <StabilizeControls clip={clip} st={clip.stabilize} trackerId={tracker.id} locked={locked} />
  const pin = tracker.kind === 'corner_pin'
  const linked = targets.filter((c) =>
    pin ? c.pin?.clip_id === clip.id && c.pin.tracker_id === tracker.id : c.follow?.clip_id === clip.id && c.follow.tracker_id === tracker.id,
  )
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {linked.map((c) => (
        <div key={c.id} className="flex items-center gap-1.5 text-[11px]">
          <span className="min-w-0 flex-1 truncate text-muted">
            {pin ? 'Pinned: ' : 'Following: '}
            <span className="text-fg">{label(c)}</span>
          </span>
          {!pin && tracker.kind === 'transform' &&
            (['position', 'rotation', 'scale'] as const).map((p) => (
              <label key={p} className="flex items-center gap-0.5 text-faint" title={`Follow ${p}`}>
                <input
                  type="checkbox"
                  checked={!!c.follow?.[p]}
                  disabled={locked}
                  onChange={(e) => s.updateClip(c.id, { follow: { ...c.follow!, [p]: e.target.checked } })}
                  className="accent-accent"
                />
                {p[0].toUpperCase()}
              </label>
            ))}
          <button
            type="button"
            className="text-faint hover:text-fg"
            disabled={locked}
            onClick={() => s.updateClip(c.id, pin ? { pin: null } : { follow: null })}
          >
            Remove
          </button>
        </div>
      ))}
      <select
        value=""
        disabled={locked || targets.length === 0}
        onChange={(e) => {
          const id = e.target.value
          if (!id) return
          s.updateClip(
            id,
            pin
              ? { pin: { clip_id: clip.id, tracker_id: tracker.id } }
              : { follow: { clip_id: clip.id, tracker_id: tracker.id, position: true, rotation: tracker.kind === 'transform', scale: tracker.kind === 'transform' } },
          )
        }}
        className="h-7 rounded-md border border-line bg-bg px-1.5 text-[11px] text-muted"
        aria-label={pin ? 'Pin a clip onto this surface' : 'Make a clip follow this'}
      >
        <option value="">{targets.length ? (pin ? 'Pin a clip onto this surface…' : 'Make a clip follow this…') : 'Add another clip to attach it'}</option>
        {targets.map((c) => (
          <option key={c.id} value={c.id}>
            {label(c)}
          </option>
        ))}
      </select>
    </div>
  )
}

function StabilizeControls({ clip, st, trackerId, locked }: { clip: Clip; st: Stabilize | null | undefined; trackerId: string; locked: boolean }) {
  const s = useEditor.getState()
  const [draft, setDraft] = useState<number | null>(null)
  const cur: Stabilize = st ?? { tracker_id: trackerId, mode: 'smooth', smoothness: 1, rotation: true, scale: false, auto_zoom: true }
  const set = (p: Partial<Stabilize>) => s.updateClip(clip.id, { stabilize: { ...cur, ...p } })
  if (!st)
    return (
      <button type="button" className="mt-2 text-[11px] text-accent-2" disabled={locked} onClick={() => set({})}>
        Apply stabilization
      </button>
    )
  return (
    <div className="mt-2 flex flex-col gap-1.5 text-[11px]">
      <div className="flex gap-1">
        {(['smooth', 'lock'] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={locked}
            onClick={() => set({ mode: m })}
            className={`h-6 flex-1 rounded border ${cur.mode === m ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted'}`}
            title={m === 'smooth' ? 'Keep the camera move, remove the shake' : 'No camera motion at all (tripod look)'}
          >
            {m === 'smooth' ? 'Smooth motion' : 'No motion'}
          </button>
        ))}
      </div>
      {cur.mode === 'smooth' && (
        <label className="flex items-center gap-2 text-muted">
          Smoothness
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={draft ?? cur.smoothness}
            disabled={locked}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => draft !== null && (set({ smoothness: draft }), setDraft(null))}
            onKeyUp={() => draft !== null && (set({ smoothness: draft }), setDraft(null))}
            className="min-w-0 flex-1"
            aria-label="Smoothness"
          />
          <span className="w-8 text-right tabular-nums">{(draft ?? cur.smoothness).toFixed(1)}s</span>
        </label>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
        {(
          [
            ['rotation', 'Rotation'],
            ['scale', 'Scale'],
            ['auto_zoom', 'Auto zoom (hide edges)'],
          ] as const
        ).map(([p, l]) => (
          <label key={p} className="flex items-center gap-1">
            <input type="checkbox" checked={cur[p]} disabled={locked} onChange={(e) => set({ [p]: e.target.checked })} className="accent-accent" />
            {l}
          </label>
        ))}
      </div>
      <button type="button" className="self-start text-faint hover:text-fg" disabled={locked} onClick={() => s.updateClip(clip.id, { stabilize: null })}>
        Turn off stabilization
      </button>
    </div>
  )
}
