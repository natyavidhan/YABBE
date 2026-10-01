import { Brush, Eraser, MousePointerClick, SquareDashedMousePointer, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import type { Asset, Clip, Roto, RotoPrompt, RotoStatus, Timeline } from '../api/types'
import { Section } from '../components/Section'
import { toast } from '../components/toast'
import { ProgressBar } from '../components/ui'
import { layerOf } from './geometry'
import { toSource } from './Tracking'
import { assetsWithSequences, clipEnd, useEditor } from './store'

const SECONDS_PER_FRAME = 1.4 // measured on a dual-core i3; shown as an estimate

export const DEFAULT_ROTO: Roto = {
  enabled: true,
  prompts: [],
  start: null,
  end: null,
  invert: false,
  refine: true,
  choke: 0,
  feather: 0,
}

/** View state (never saved): the clip whose selection is being edited, matte view, statuses. */
export const useRoto = create<{
  editing: string | null
  matte: string | null
  status: Record<string, RotoStatus>
  available: boolean | null
}>(() => ({ editing: null, matte: null, status: {}, available: null }))

const sourceTime = (clip: Clip, t: number) => clip.in_point + Math.max(0, Math.min(clip.duration, t - clip.start)) * clip.speed

/** Render request as the preview should show it: the clip being selected uncut, or its matte. */
export function rotoPreview(timeline: Timeline, editing: string | null, matte: string | null): Timeline {
  if (!editing && !matte) return timeline
  const patch = (c: Clip): Clip => {
    if (!c.roto) return c
    if (c.id === editing) return { ...c, roto: { ...c.roto, enabled: false } }
    if (c.id === matte) return { ...c, roto: { ...c.roto, matte: true } }
    return c
  }
  return {
    ...timeline,
    sequences: timeline.sequences?.map((s) => (s.id === timeline.sequence_id ? { ...s, clips: s.clips.map(patch) } : s)),
  }
}

function setRoto(clipId: string, patch: Partial<Roto>) {
  const s = useEditor.getState()
  const clip = s.doc.clips.find((c) => c.id === clipId)
  if (!clip) return
  s.updateClip(clipId, { roto: { ...DEFAULT_ROTO, ...clip.roto, ...patch, matte: undefined } })
}

/** The prompt for the frame at the playhead (index in the list, or -1). */
function promptAt(clip: Clip, fps: number): { index: number; t: number } {
  const t = sourceTime(clip, useEditor.getState().playhead)
  const index = (clip.roto?.prompts ?? []).findIndex((p) => Math.abs(p.t - t) < 0.5 / fps)
  return { index, t }
}

function startEditing(clip: Clip) {
  const s = useEditor.getState()
  if (s.playhead < clip.start || s.playhead >= clipEnd(clip)) s.setPlayhead(clip.start)
  if (!clip.roto) {
    s.updateClip(clip.id, {
      roto: { ...DEFAULT_ROTO, start: clip.in_point, end: clip.in_point + clip.duration * clip.speed },
    })
  }
  useRoto.setState({ editing: clip.id })
}

// -- sync: availability, statuses, automatic tracking ------------------------------------

export function useRotoSync(projectId: string) {
  const clips = useEditor((s) => s.doc.clips)
  const editing = useRoto((s) => s.editing)
  const status = useRoto((s) => s.status)
  const busy = Object.values(status).some((x) => x.state === 'tracking' || x.state === 'queued')
  const items = useMemo(
    () =>
      clips
        .filter((c) => c.type === 'video' && c.asset_id && c.roto && c.roto.prompts.some((p) => p.box || p.points.length))
        .map((c) => ({ clip_id: c.id, asset_id: c.asset_id!, roto: c.roto! })),
    [clips],
  )
  const started = useRef(new Set<string>())

  useEffect(() => {
    if (useRoto.getState().available === null)
      api
        .rotoInfo()
        .then((r) => useRoto.setState({ available: r.available }))
        .catch(() => useRoto.setState({ available: false }))
  }, [])

  useEffect(() => {
    if (!items.length) return
    let alive = true
    const tick = async () => {
      try {
        const res = await api.rotoStatus(projectId, items)
        if (!alive) return
        useRoto.setState({ status: Object.fromEntries(res.map((r) => [r.clip_id, r])) })
        for (const r of res) {
          const it = items.find((x) => x.clip_id === r.clip_id)
          if (!it || r.state !== 'none' || started.current.has(r.key) || editing === r.clip_id) continue
          started.current.add(r.key)
          api.rotoRun(projectId, it).catch((e) => {
            started.current.delete(r.key)
            toast.error(e)
          })
        }
      } catch {
        /* next tick */
      }
    }
    const first = window.setTimeout(tick, 400)
    const id = window.setInterval(tick, busy ? 1500 : 5000)
    return () => {
      alive = false
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [projectId, items, editing, busy])
}

// -- preview overlay: make the selection ---------------------------------------------------

/** Selection tool over the preview: drag a box, click to add, Alt/right-click to exclude. */
export function RotoOverlay({ width }: { width: number }) {
  const editing = useRoto((s) => s.editing)
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const textSizes = useEditor((s) => s.textSizes)
  const playhead = useEditor((s) => s.playhead)
  const projectId = useEditor((s) => s.projectId)
  const clip = doc.clips.find((c) => c.id === editing)
  const assetMap = useMemo(() => new Map(assetsWithSequences(assets, doc).map((a) => [a.id, a])), [assets, doc])
  const inClip = clip && playhead >= clip.start - 1e-6 && playhead < clipEnd(clip) + 1e-6
  const layer = clip && inClip ? layerOf(clip, doc.settings, assetMap, textSizes, playhead) : null
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [mask, setMask] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const k = width / doc.settings.width
  const fps = doc.settings.fps
  const prompt = clip ? (clip.roto?.prompts ?? [])[promptAt(clip, fps).index] : undefined

  // Live selection preview for this frame (the model re-runs only its small decoder per click).
  useEffect(() => {
    if (!clip?.asset_id || !projectId || !editing) return
    if (!prompt || (!prompt.box && !prompt.points.length)) {
      setMask(null)
      return
    }
    const ctl = new AbortController()
    setBusy(true)
    const id = window.setTimeout(() => {
      api
        .rotoPreview(projectId, clip.asset_id!, prompt, ctl.signal)
        .then((b) => tint(b))
        .then((url) => setMask((old) => (old && URL.revokeObjectURL(old), url)))
        .catch((e) => e?.name !== 'AbortError' && toast.error(e))
        .finally(() => setBusy(false))
    }, 120)
    return () => {
      window.clearTimeout(id)
      ctl.abort()
    }
  }, [clip?.asset_id, projectId, editing, JSON.stringify(prompt)]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!clip || !layer) return null

  const toSrc = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return toSource(layer, (e.clientX - r.left) / k, (e.clientY - r.top) / k).map((v) => Math.min(1, Math.max(0, v))) as [number, number]
  }
  const update = (fn: (p: RotoPrompt) => RotoPrompt) => {
    const { index, t } = promptAt(clip, fps)
    const list = [...(clip.roto?.prompts ?? [])]
    const cur = index >= 0 ? list[index] : { t, box: null, points: [] }
    const next = fn(cur)
    if (index >= 0) list[index] = next
    else list.push(next)
    setRoto(clip.id, { prompts: list.filter((p) => p.box || p.points.length) })
  }
  const onDown = (e: React.PointerEvent) => {
    if (e.button === 1) return
    e.preventDefault()
    const exclude = e.button === 2 || e.altKey
    const r = ref.current!.getBoundingClientRect()
    const x0 = e.clientX - r.left
    const y0 = e.clientY - r.top
    const start = toSrc(e)
    let moved = false
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - r.left
      const y1 = ev.clientY - r.top
      if (Math.hypot(x1 - x0, y1 - y0) > 6) moved = true
      if (moved && !exclude) setDrag({ x0, y0, x1, y1 })
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (moved && !exclude) {
        const end = toSrc(ev)
        update((p) => ({ ...p, box: [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])] }))
      } else {
        update((p) => ({ ...p, points: [...p.points, [start[0], start[1], exclude ? 0 : 1]] }))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Full source frame drawn through the layer's placement (crop, flips, rotation).
  const c = clip.crop
  const fullW = layer.width / Math.max(0.01, 1 - c.left - c.right)
  const fullH = layer.height / Math.max(0.01, 1 - c.top - c.bottom)
  const P = (nx: number, ny: number) => {
    const a = (layer.rotation * Math.PI) / 180
    let fx = (nx - c.left) / Math.max(1e-6, 1 - c.left - c.right) - 0.5
    let fy = (ny - c.top) / Math.max(1e-6, 1 - c.top - c.bottom) - 0.5
    if (layer.transform.flip_h) fx = -fx
    if (layer.transform.flip_v) fy = -fy
    const lx = fx * layer.width
    const ly = fy * layer.height
    return [(layer.cx + lx * Math.cos(a) - ly * Math.sin(a)) * k, (layer.cy + lx * Math.sin(a) + ly * Math.cos(a)) * k]
  }
  return (
    <div
      ref={ref}
      className="absolute inset-0 z-20 cursor-crosshair touch-none"
      onPointerDown={onDown}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Roto brush: drag a box around the object, click to add, Alt-click to exclude"
    >
      <div
        className="pointer-events-none absolute overflow-hidden"
        style={{
          left: (layer.cx - layer.width / 2) * k,
          top: (layer.cy - layer.height / 2) * k,
          width: layer.width * k,
          height: layer.height * k,
          transform: `rotate(${layer.rotation}deg)`,
        }}
      >
        {mask && (
          <img
            src={mask}
            alt=""
            className="absolute max-w-none"
            style={{
              left: -c.left * fullW * k,
              top: -c.top * fullH * k,
              width: fullW * k,
              height: fullH * k,
              transform: `scale(${layer.transform.flip_h ? -1 : 1}, ${layer.transform.flip_v ? -1 : 1})`,
            }}
          />
        )}
      </div>
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {prompt?.box &&
          (() => {
            const pts = [
              P(prompt.box[0], prompt.box[1]),
              P(prompt.box[2], prompt.box[1]),
              P(prompt.box[2], prompt.box[3]),
              P(prompt.box[0], prompt.box[3]),
            ]
            return <polygon points={pts.map((p) => p.join(',')).join(' ')} className="fill-none stroke-ok" strokeWidth={1.5} strokeDasharray="5 3" />
          })()}
        {prompt?.points.map(([x, y, l], i) => {
          const [px, py] = P(x, y)
          return <circle key={i} cx={px} cy={py} r={5} className={l ? 'fill-ok stroke-white' : 'fill-danger stroke-white'} strokeWidth={1.5} />
        })}
        {drag && (
          <rect
            x={Math.min(drag.x0, drag.x1)}
            y={Math.min(drag.y0, drag.y1)}
            width={Math.abs(drag.x1 - drag.x0)}
            height={Math.abs(drag.y1 - drag.y0)}
            className="fill-ok/10 stroke-ok"
            strokeWidth={1.5}
          />
        )}
      </svg>
      <div className="pointer-events-auto absolute inset-x-0 bottom-2 flex justify-center" onPointerDown={(e) => e.stopPropagation()}>
        <span className="flex items-center gap-2 rounded-full bg-black/80 px-3 py-1 text-xs text-white">
          {busy ? 'Selecting…' : prompt ? 'Click to add · Alt-click to remove · drag for a new box' : 'Drag a box around the object, or click it'}
          {prompt && (
            <button type="button" className="rounded-full px-2 py-0.5 hover:bg-white/15" onClick={() => update(() => ({ t: prompt.t, box: null, points: [] }))}>
              Clear
            </button>
          )}
          <button type="button" className="rounded-full bg-accent px-2 py-0.5 font-medium" onClick={() => useRoto.setState({ editing: null })}>
            Done
          </button>
        </span>
      </div>
    </div>
  )
}

/** Grey mask PNG -> translucent green tint (object) for the overlay. */
async function tint(blob: Blob): Promise<string> {
  const bmp = await createImageBitmap(blob)
  const cv = document.createElement('canvas')
  cv.width = bmp.width
  cv.height = bmp.height
  const ctx = cv.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, cv.width, cv.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i]
    d[i] = 60
    d[i + 1] = 220
    d[i + 2] = 110
    d[i + 3] = Math.round(a * 0.55)
  }
  ctx.putImageData(img, 0, 0)
  return new Promise((res) => cv.toBlob((b) => res(URL.createObjectURL(b!)), 'image/png'))
}

// -- inspector -----------------------------------------------------------------------------

export function RotoSection({ clip, asset, locked, extra }: { clip: Clip; asset: Asset; locked: boolean; extra?: React.ReactNode }) {
  const available = useRoto((s) => s.available)
  const editing = useRoto((s) => s.editing === clip.id)
  const matte = useRoto((s) => s.matte === clip.id)
  const st = useRoto((s) => s.status[clip.id])
  const fps = asset.fps || 25
  const r = clip.roto
  const frames = r?.prompts.length ?? 0
  const range = r ? (r.end ?? asset.duration) - (r.start ?? 0) : clip.duration * clip.speed
  const minutes = (range * fps * SECONDS_PER_FRAME) / 60
  const busy = st?.state === 'tracking' || st?.state === 'queued'
  useEffect(
    () => () => useRoto.setState((s) => ({ editing: s.editing === clip.id ? null : s.editing, matte: s.matte === clip.id ? null : s.matte })),
    [clip.id],
  )

  if (available === false)
    return (
      <Section icon={<Brush size={14} />} title="Roto brush" extra={extra}>
        <p className="text-[11px] text-faint">The roto brush model isn’t installed on this server.</p>
      </Section>
    )
  return (
    <Section
      icon={<Brush size={14} />}
      title="Roto brush"
      onReset={r ? () => setRoto(clip.id, { invert: false, refine: true, choke: 0, feather: 0 }) : undefined}
      extra={extra}
      dimmed={r?.enabled === false}
    >
      {!r || frames === 0 ? (
        <>
          <button
            type="button"
            disabled={locked}
            onClick={() => startEditing(clip)}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-md border text-xs ${
              editing ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg'
            }`}
          >
            <SquareDashedMousePointer size={13} /> {editing ? 'Select the object on the preview…' : 'Select an object…'}
          </button>
          <p className="text-[11px] text-faint">
            Cut a person or any object out of the video: drag a box around it (or click it) on one frame and it’s followed
            through the clip. Works on anything — people, animals, cars, products.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`flex-1 ${st?.state === 'done' ? 'text-ok' : st?.state === 'error' ? 'text-danger' : 'text-muted'}`}>
              {editing
                ? 'Selecting — press Done on the preview to track'
                : st?.state === 'done'
                  ? `Tracked · selected on ${frames} frame${frames === 1 ? '' : 's'}`
                  : busy
                    ? `${st.state === 'queued' ? 'Waiting' : 'Tracking'} ${Math.round(st.progress * 100)}% · about ${Math.max(1, Math.round(minutes * (1 - st.progress)))} min left`
                    : st?.state === 'error'
                      ? `Failed: ${st.error}`
                      : 'Starting…'}
            </span>
          </div>
          {busy && <ProgressBar value={st.progress} />}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={locked}
              onClick={() => (editing ? useRoto.setState({ editing: null }) : startEditing(clip))}
              className={`flex h-7 items-center justify-center gap-1.5 rounded-md border text-[11px] ${
                editing ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg'
              }`}
              title="Go to a frame where the selection is wrong and fix it there: that frame becomes an extra anchor"
            >
              <MousePointerClick size={12} /> {editing ? 'Done' : 'Fix this frame'}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                useRoto.setState({ editing: null })
                setRoto(clip.id, { prompts: [] })
              }}
              className="flex h-7 items-center justify-center gap-1.5 rounded-md border border-line text-[11px] text-muted hover:border-line-strong hover:text-fg"
              title="Clear the selection and select again"
            >
              <Trash2 size={12} /> Clear selection
            </button>
          </div>
          <div className="flex gap-1">
            {([false, true] as const).map((inv) => (
              <button
                key={String(inv)}
                type="button"
                disabled={locked}
                onClick={() => setRoto(clip.id, { invert: inv })}
                className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border text-[11px] ${
                  r.invert === inv ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted'
                }`}
              >
                {inv ? <Eraser size={12} /> : <Wand2 size={12} />}
                {inv ? 'Remove object' : 'Keep object'}
              </button>
            ))}
          </div>
          <RangeRow label="Shrink / grow" value={r.choke} min={-10} max={10} step={1} unit="px" disabled={locked} onChange={(choke) => setRoto(clip.id, { choke })} />
          <RangeRow label="Feather" value={r.feather} min={0} max={20} step={0.5} unit="px" disabled={locked} onChange={(feather) => setRoto(clip.id, { feather })} />
          <label className="flex items-center gap-2 text-xs text-muted" title="Snaps the edge to the picture: keeps hair and soft detail">
            <input type="checkbox" checked={r.refine} disabled={locked} onChange={(e) => setRoto(clip.id, { refine: e.target.checked })} className="accent-accent" />
            Refine edges (hair, fur, soft detail)
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={matte} onChange={(e) => useRoto.setState({ matte: e.target.checked ? clip.id : null })} className="accent-accent" />
            Show matte (preview)
          </label>
        </>
      )}
      {frames > 0 && !busy && st?.state !== 'done' && (
        <p className="text-[11px] text-faint">Tracking runs on the server: about {minutes < 1 ? 'a minute' : `${Math.ceil(minutes)} min`} for this clip.</p>
      )}
    </Section>
  )
}

function RangeRow({ label, value, min, max, step, unit, disabled, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  disabled: boolean
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const commit = () => {
    if (draft !== null) onChange(draft)
    setDraft(null)
  }
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        disabled={disabled}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="min-w-0 flex-1"
        aria-label={label}
      />
      <span className="w-10 text-right tabular-nums">
        {(draft ?? value).toString()}
        {unit}
      </span>
    </label>
  )
}
