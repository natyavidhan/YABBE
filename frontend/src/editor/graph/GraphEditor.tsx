import {
  Bookmark,
  ChartSpline,
  Eye,
  EyeOff,
  Maximize2,
  Minus,
  MoveHorizontal,
  Scaling,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AnimProp, Clip, Ease, HandleMode, Keyframe } from '../../api/types'
import { toast } from '../../components/toast'
import { IconButton, NumberInput } from '../../components/ui'
import { formatTimecode } from '../../lib/format'
import { curveValueAt } from '../curves'
import { colorAt, framesOf, isColorProp } from '../keyframes'
import { allMarkers, useEditor, type GraphKey } from '../store'
import {
  actionKeys,
  animatedProps,
  copySelectedKeys,
  deleteSelectedKeys,
  pasteKeys,
  loadSavedPresets,
  runEasyEase,
  runPreset,
  setEase,
  storeSavedPresets,
} from './actions'
import {
  curveBounds,
  effectiveHandle,
  PRESETS,
  presetFromSegment,
  presetShape,
  setHandle,
  setHandleMode,
  targetSegments,
  type CurvePreset,
  type Side,
} from './model'

// -- property metadata ---------------------------------------------------------------------

interface PropMeta {
  label: string
  color: string
  /** display = value * mul, with unit */
  mul: number
  unit: string
  min?: number
  max?: number
}

export const PROP_META: Record<AnimProp, PropMeta> = {
  x: { label: 'X', color: '#ff6b6b', mul: 1, unit: 'px' },
  y: { label: 'Y', color: '#51cf66', mul: 1, unit: 'px' },
  scale: { label: 'Scale', color: '#4dabf7', mul: 100, unit: '%', min: 0.01, max: 20 },
  rotation: { label: 'Rotation', color: '#ffa94d', mul: 1, unit: '°' },
  opacity: { label: 'Opacity', color: '#cc5de8', mul: 100, unit: '%', min: 0, max: 1 },
  volume: { label: 'Volume', color: '#20c997', mul: 100, unit: '%', min: 0, max: 4 },
  text_size: { label: 'Text size', color: '#f783ac', mul: 1, unit: 'px', min: 4, max: 1000 },
  text_stroke_width: { label: 'Outline width', color: '#ffd43b', mul: 1, unit: 'px', min: 0, max: 100 },
  text_padding: { label: 'Box padding', color: '#94d82d', mul: 1, unit: 'px', min: 0, max: 500 },
  text_line_spacing: { label: 'Line spacing', color: '#74c0fc', mul: 1, unit: '×', min: 0.5, max: 4 },
  text_color: { label: 'Text colour', color: '#f1f3f5', mul: 1, unit: '' },
  text_stroke_color: { label: 'Outline colour', color: '#adb5bd', mul: 1, unit: '' },
  text_background: { label: 'Box colour', color: '#868e96', mul: 1, unit: '' },
  shape_width: { label: 'Shape width', color: '#ffc078', mul: 1, unit: 'px', min: 1, max: 8000 },
  shape_height: { label: 'Shape height', color: '#ffa8a8', mul: 1, unit: 'px', min: 1, max: 8000 },
  shape_stroke_width: { label: 'Outline width', color: '#e599f7', mul: 1, unit: 'px', min: 0, max: 500 },
  shape_radius: { label: 'Corners', color: '#99e9f2', mul: 200, unit: '%', min: 0, max: 0.5 },
  shape_fill: { label: 'Fill', color: '#ffd8a8', mul: 1, unit: '' },
  shape_stroke: { label: 'Outline colour', color: '#dee2e6', mul: 1, unit: '' },
}

const clampProp = (prop: AnimProp, v: number) => {
  const m = PROP_META[prop]
  return Math.min(m.max ?? Infinity, Math.max(m.min ?? -Infinity, v))
}

export const EASE_OPTIONS: { value: Ease; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'bezier', label: 'Curve (handles)' },
  { value: 'hold', label: 'Hold' },
  { value: 'ease_in', label: 'Ease in (cubic)' },
  { value: 'ease_out', label: 'Ease out (cubic)' },
  { value: 'ease_in_out', label: 'Ease in-out (cubic)' },
  { value: 'back_in', label: 'Back in' },
  { value: 'back_out', label: 'Back out' },
  { value: 'back_in_out', label: 'Back in-out' },
  { value: 'elastic_in', label: 'Elastic in' },
  { value: 'elastic_out', label: 'Elastic out' },
  { value: 'elastic_in_out', label: 'Elastic in-out' },
  { value: 'bounce_in', label: 'Bounce in' },
  { value: 'bounce_out', label: 'Bounce out' },
  { value: 'bounce_in_out', label: 'Bounce in-out' },
]

const HANDLE_MODES: { value: HandleMode; label: string }[] = [
  { value: 'auto_clamped', label: 'Auto (no overshoot)' },
  { value: 'auto', label: 'Auto smooth' },
  { value: 'aligned', label: 'Aligned' },
  { value: 'free', label: 'Broken (free)' },
]

// -- layout constants ----------------------------------------------------------------------

const RULER = 22
const GUTTER = 46
const DOPE_ROW = 20
const HIT = 8
const TICKS = [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

interface View {
  t0: number
  t1: number
  v0: number
  v1: number
}

type Hit =
  | { type: 'handle'; prop: AnimProp; i: number; side: Side }
  | { type: 'key'; prop: AnimProp; i: number }
  | { type: 'curve'; prop: AnimProp; t: number }
  | { type: 'ruler' }
  | null

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; y: number; view: View }
  | { kind: 'marquee'; x: number; y: number; x2: number; y2: number; add: boolean }
  | {
      kind: 'keys'
      x: number
      y: number
      hit: GraphKey
      orig: Map<AnimProp, Keyframe[]>
      sel: Map<AnimProp, Set<number>>
      active: boolean
    }
  | { kind: 'handle'; prop: AnimProp; i: number; side: Side; orig: Keyframe[]; active: boolean; x: number; y: number }

const readBool = (key: string, dflt: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? dflt : v === '1'
  } catch {
    return dflt
  }
}
const writeBool = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

// -- component -------------------------------------------------------------------------------

export function GraphEditor({ compact = false, onClose }: { compact?: boolean; onClose: () => void }) {
  const clip = useEditor((s) => (s.selection.length === 1 ? s.doc.clips.find((c) => c.id === s.selection[0]) : undefined))
  const multi = useEditor((s) => s.selection.length > 1)
  const header = (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
      <ChartSpline size={14} className="text-accent-2" />
      <span className="text-xs font-semibold">Graph</span>
      <div className="flex-1" />
      <IconButton label="Close graph editor (G)" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  )
  if (!clip || !animatedProps(clip).length)
    return (
      <div className="flex h-full flex-col bg-panel">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center text-xs text-muted">
          <ChartSpline size={20} className="text-faint" />
          {multi
            ? 'Select a single clip to edit its curves.'
            : clip
              ? 'This clip has no keyframes yet. Click a ◆ in the inspector to animate a property.'
              : 'Select a clip with keyframes to edit its curves.'}
        </div>
      </div>
    )
  return <GraphInner key={clip.id} clip={clip} compact={compact} onClose={onClose} />
}

function GraphInner({ clip, compact, onClose }: { clip: Clip; compact: boolean; onClose: () => void }) {
  const graphHidden = useEditor((s) => s.graphHidden)
  const graphSel = useEditor((s) => s.graphSel)
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.doc.settings.fps)
  const locked = useEditor((s) => s.doc.tracks.find((t) => t.id === clip.track_id)?.locked ?? false)
  const [normalized, setNormalized] = useState(() => readBool('yabbe.graphNormalized', true))
  const [view, setView] = useState<View | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [marquee, setMarquee] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null)
  const [presetsAt, setPresetsAt] = useState<DOMRect | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; dx: number; dy: number; mid: { x: number; y: number }; view: View } | null>(null)
  const spaceDown = useRef(false)

  const props = animatedProps(clip)
  const visible = (p: AnimProp) => !graphHidden[`${clip.id}:${p}`]
  const curveProps = props.filter((p) => !isColorProp(p) && visible(p))
  const colorRows = props.filter((p) => isColorProp(p) && visible(p))
  const dopeH = colorRows.length * DOPE_ROW

  // Range covering the clip and all keys (for fitting and normalising).
  const span = useMemo(() => {
    let a = 0
    let b = clip.duration
    for (const p of props) {
      const f = framesOf(clip, p)!
      a = Math.min(a, f[0].t)
      b = Math.max(b, f[f.length - 1].t)
    }
    return [a, b] as const
  }, [clip, props])

  const bounds = useMemo(() => {
    const m = new Map<AnimProp, [number, number]>()
    for (const p of curveProps) {
      const [lo, hi] = curveBounds(framesOf(clip, p)!, span[0], span[1])
      m.set(p, hi - lo < 1e-9 ? [lo - 1, hi + 1] : [lo, hi])
    }
    return m
  }, [clip, curveProps.join(','), span]) // eslint-disable-line react-hooks/exhaustive-deps

  const norm = useCallback(
    (p: AnimProp, v: number) => {
      if (!normalized) return v
      const [lo, hi] = bounds.get(p) ?? [0, 1]
      return (v - lo) / (hi - lo)
    },
    [normalized, bounds],
  )
  const denormDelta = useCallback(
    (p: AnimProp, dn: number) => {
      if (!normalized) return dn
      const [lo, hi] = bounds.get(p) ?? [0, 1]
      return dn * (hi - lo)
    },
    [normalized, bounds],
  )

  const fit = useCallback(() => {
    const pad = Math.max(0.1, (span[1] - span[0]) * 0.04)
    let v0 = -0.1
    let v1 = 1.1
    if (!normalized) {
      let lo = Infinity
      let hi = -Infinity
      for (const p of curveProps) {
        const [a, b] = bounds.get(p)!
        lo = Math.min(lo, a)
        hi = Math.max(hi, b)
      }
      if (!isFinite(lo)) [lo, hi] = [0, 1]
      const m = (hi - lo) * 0.1 || 1
      v0 = lo - m
      v1 = hi + m
    }
    setView({ t0: span[0] - pad, t1: span[1] + pad, v0, v1 })
  }, [span, normalized, bounds, curveProps.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fit()
  }, [normalized]) // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // -- coordinate mapping ------------------------------------------------------------------
  const plotW = Math.max(1, size.w - GUTTER)
  const plotH = Math.max(1, size.h - RULER - dopeH)
  const v = view ?? { t0: 0, t1: 1, v0: 0, v1: 1 }
  const tx = (t: number) => GUTTER + ((t - v.t0) / (v.t1 - v.t0)) * plotW
  const xt = (x: number) => v.t0 + ((x - GUTTER) / plotW) * (v.t1 - v.t0)
  const ty = (val: number) => RULER + ((v.v1 - val) / (v.v1 - v.v0)) * plotH
  const yv = (y: number) => v.v1 - ((y - RULER) / plotH) * (v.v1 - v.v0)
  const selSet = useMemo(() => new Set(graphSel.map((k) => `${k.prop}:${k.i}`)), [graphSel])
  const isSel = (p: AnimProp, i: number) => selSet.has(`${p}:${i}`)
  const dopeY = (row: number) => RULER + plotH + row * DOPE_ROW + DOPE_ROW / 2

  // Keep the latest render state for pointer handlers.
  const live = useRef({ tx, xt, ty, yv, v, plotW, plotH })
  live.current = { tx, xt, ty, yv, v, plotW, plotH }

  // -- drawing -------------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view || size.w === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)
    ctx.fillStyle = '#0e0f13'
    ctx.fillRect(0, 0, size.w, size.h)

    // clip range
    ctx.fillStyle = 'rgba(255,255,255,0.025)'
    ctx.fillRect(tx(0), RULER, tx(clip.duration) - tx(0), plotH + dopeH)

    // time grid + ruler
    const step = TICKS.find((s) => (s / (v.t1 - v.t0)) * plotW >= 70) ?? 600
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    for (let t = Math.floor(v.t0 / step) * step; t <= v.t1; t += step) {
      const x = Math.round(tx(t)) + 0.5
      if (x < GUTTER) continue
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      ctx.beginPath()
      ctx.moveTo(x, RULER)
      ctx.lineTo(x, size.h)
      ctx.stroke()
      ctx.fillStyle = '#5d6474'
      ctx.fillText(formatTimecode(Math.max(0, clip.start + t), fps).replace(/^00:/, ''), x + 3, RULER / 2)
    }
    ctx.strokeStyle = '#2a2e3a'
    ctx.beginPath()
    ctx.moveTo(0, RULER + 0.5)
    ctx.lineTo(size.w, RULER + 0.5)
    ctx.stroke()

    // value grid
    if (normalized) {
      ctx.setLineDash([3, 4])
      for (const n of [0, 1]) {
        const y = Math.round(ty(n)) + 0.5
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'
        ctx.beginPath()
        ctx.moveTo(GUTTER, y)
        ctx.lineTo(size.w, y)
        ctx.stroke()
        ctx.fillStyle = '#5d6474'
        ctx.fillText(n ? 'max' : 'min', 6, y)
      }
      ctx.setLineDash([])
    } else {
      const raw = ((v.v1 - v.v0) / plotH) * 36
      const mag = 10 ** Math.floor(Math.log10(raw))
      const vstep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
      for (let val = Math.ceil(v.v0 / vstep) * vstep; val <= v.v1; val += vstep) {
        const y = Math.round(ty(val)) + 0.5
        if (y > RULER + plotH) continue
        ctx.strokeStyle = Math.abs(val) < vstep / 2 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)'
        ctx.beginPath()
        ctx.moveTo(GUTTER, y)
        ctx.lineTo(size.w, y)
        ctx.stroke()
        ctx.fillStyle = '#5d6474'
        ctx.fillText(Number(val.toPrecision(4)).toString(), 4, y)
      }
    }

    // curves
    ctx.save()
    ctx.beginPath()
    ctx.rect(GUTTER, RULER, plotW, plotH)
    ctx.clip()
    for (const p of curveProps) {
      const f = framesOf(clip, p)!
      const hasSel = graphSel.some((k) => k.prop === p)
      ctx.strokeStyle = PROP_META[p].color
      ctx.globalAlpha = graphSel.length && !hasSel ? 0.45 : 1
      ctx.lineWidth = hasSel ? 2 : 1.5
      ctx.beginPath()
      for (let x = GUTTER; x <= size.w; x += 2) {
        const y = ty(norm(p, curveValueAt(f, xt(x))))
        if (x === GUTTER) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
      // handles of selected keys
      f.forEach((k, i) => {
        if (!isSel(p, i)) return
        for (const side of ['in', 'out'] as Side[]) {
          const h = effectiveHandle(f, i, side)
          if (!h) continue
          const kx = tx(k.t)
          const ky = ty(norm(p, k.v))
          const hx = tx(k.t + h[0])
          const hy = ty(norm(p, k.v + h[1]))
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(kx, ky)
          ctx.lineTo(hx, hy)
          ctx.stroke()
          ctx.fillStyle = '#0e0f13'
          ctx.strokeStyle = PROP_META[p].color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(hx, hy, compact ? 6 : 4, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
      })
      // keys
      f.forEach((k, i) => {
        const x = tx(k.t)
        const y = ty(norm(p, k.v))
        const r = compact ? 7 : 5
        ctx.fillStyle = isSel(p, i) ? '#ffffff' : PROP_META[p].color
        ctx.strokeStyle = isSel(p, i) ? PROP_META[p].color : '#0e0f13'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x, y - r)
        ctx.lineTo(x + r, y)
        ctx.lineTo(x, y + r)
        ctx.lineTo(x - r, y)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      })
    }
    ctx.restore()

    // colour (dope) rows
    colorRows.forEach((p, row) => {
      const f = framesOf(clip, p)!
      const y = dopeY(row)
      ctx.strokeStyle = '#2a2e3a'
      ctx.beginPath()
      ctx.moveTo(0, RULER + plotH + row * DOPE_ROW + 0.5)
      ctx.lineTo(size.w, RULER + plotH + row * DOPE_ROW + 0.5)
      ctx.stroke()
      ctx.fillStyle = '#9097a6'
      ctx.fillText(PROP_META[p].label.split(' ')[0].slice(0, 7), 4, y)
      const a = Math.max(GUTTER, tx(f[0].t))
      const b = Math.min(size.w, tx(f[f.length - 1].t))
      for (let x = a; x < b; x += 3) {
        ctx.fillStyle = colorAt(f, xt(x)).slice(0, 7)
        ctx.fillRect(x, y - 3, 3, 6)
      }
      f.forEach((k, i) => {
        const x = tx(k.t)
        const r = compact ? 7 : 5
        ctx.fillStyle = (k.c ?? '#ffffff').slice(0, 7)
        ctx.strokeStyle = isSel(p, i) ? '#ffffff' : '#0e0f13'
        ctx.lineWidth = isSel(p, i) ? 2 : 1.5
        ctx.beginPath()
        ctx.moveTo(x, y - r)
        ctx.lineTo(x + r, y)
        ctx.lineTo(x, y + r)
        ctx.lineTo(x - r, y)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      })
    })

    // playhead
    const px = Math.round(tx(playhead - clip.start)) + 0.5
    if (px >= GUTTER) {
      ctx.strokeStyle = '#ef5f6b'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, size.h)
      ctx.stroke()
    }
    // gutter background over grid labels area separation
    ctx.strokeStyle = '#2a2e3a'
    ctx.beginPath()
    ctx.moveTo(GUTTER + 0.5, RULER)
    ctx.lineTo(GUTTER + 0.5, size.h)
    ctx.stroke()

    if (marquee) {
      ctx.fillStyle = 'rgba(124,92,255,0.12)'
      ctx.strokeStyle = 'rgba(157,133,255,0.9)'
      ctx.lineWidth = 1
      const x = Math.min(marquee.x, marquee.x2)
      const y = Math.min(marquee.y, marquee.y2)
      ctx.fillRect(x, y, Math.abs(marquee.x2 - marquee.x), Math.abs(marquee.y2 - marquee.y))
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(marquee.x2 - marquee.x), Math.abs(marquee.y2 - marquee.y))
    }
  })

  // -- hit testing -----------------------------------------------------------------------------
  const hitTest = (x: number, y: number): Hit => {
    if (y < RULER) return { type: 'ruler' }
    const r = compact ? HIT + 6 : HIT
    // handles of selected keys first
    for (const p of curveProps) {
      const f = framesOf(clip, p)!
      for (let i = 0; i < f.length; i++) {
        if (!isSel(p, i)) continue
        for (const side of ['in', 'out'] as Side[]) {
          const h = effectiveHandle(f, i, side)
          if (!h) continue
          if (Math.hypot(tx(f[i].t + h[0]) - x, ty(norm(p, f[i].v + h[1])) - y) <= r) return { type: 'handle', prop: p, i, side }
        }
      }
    }
    for (const p of [...curveProps].reverse()) {
      const f = framesOf(clip, p)!
      for (let i = f.length - 1; i >= 0; i--) {
        if (Math.abs(tx(f[i].t) - x) <= r && Math.abs(ty(norm(p, f[i].v)) - y) <= r) return { type: 'key', prop: p, i }
      }
    }
    for (let row = 0; row < colorRows.length; row++) {
      if (Math.abs(dopeY(row) - y) > DOPE_ROW / 2) continue
      const p = colorRows[row]
      const f = framesOf(clip, p)!
      for (let i = f.length - 1; i >= 0; i--) if (Math.abs(tx(f[i].t) - x) <= r) return { type: 'key', prop: p, i }
      return null
    }
    if (y > RULER + plotH) return null
    for (const p of curveProps) {
      const f = framesOf(clip, p)!
      if (Math.abs(ty(norm(p, curveValueAt(f, xt(x)))) - y) <= r - 2) return { type: 'curve', prop: p, t: xt(x) }
    }
    return null
  }

  const keyScreenPos = (p: AnimProp, i: number): [number, number] => {
    const f = framesOf(clip, p)!
    if (isColorProp(p)) return [tx(f[i].t), dopeY(colorRows.indexOf(p))]
    return [tx(f[i].t), ty(norm(p, f[i].v))]
  }

  // -- pointer interaction ---------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const store = useEditor.getState

  const selMap = (sel: GraphKey[]) => {
    const m = new Map<AnimProp, Set<number>>()
    for (const k of sel) {
      if (!m.has(k.prop)) m.set(k.prop, new Set())
      m.get(k.prop)!.add(k.i)
    }
    return m
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return
    rootRef.current?.focus({ preventScroll: true })
    const { x, y } = local(e)
    pointers.current.set(e.pointerId, { x, y })
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    if (pointers.current.size === 2) {
      // pinch: cancel any one-finger action
      dragRef.current = null
      const [a, b] = [...pointers.current.values()]
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        dx: Math.abs(a.x - b.x) || 1,
        dy: Math.abs(a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view,
      }
      return
    }
    const touch = e.pointerType !== 'mouse'
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      dragRef.current = { kind: 'pan', x, y, view }
      return
    }
    if (e.button !== 0) return
    const hit = hitTest(x, y)
    const s = store()
    if (hit?.type === 'ruler') {
      s.setPlaying(false)
      s.setPlayhead(Math.max(0, clip.start + xt(x)))
      dragRef.current = { kind: 'scrub' }
      return
    }
    if (hit?.type === 'handle') {
      if (locked) return
      dragRef.current = { kind: 'handle', prop: hit.prop, i: hit.i, side: hit.side, orig: framesOf(clip, hit.prop)!, active: false, x, y }
      return
    }
    if (hit?.type === 'key') {
      let sel = s.graphSel
      const already = isSel(hit.prop, hit.i)
      if (e.shiftKey) {
        sel = already ? sel.filter((k) => !(k.prop === hit.prop && k.i === hit.i)) : [...sel, { prop: hit.prop, i: hit.i }]
        s.setGraphSel(sel)
        return
      }
      if (!already) {
        sel = [{ prop: hit.prop, i: hit.i }]
        s.setGraphSel(sel)
      }
      if (locked) return
      const m = selMap(sel)
      const orig = new Map<AnimProp, Keyframe[]>()
      for (const p of m.keys()) orig.set(p, framesOf(clip, p)!)
      dragRef.current = { kind: 'keys', x, y, orig, sel: m, active: false, hit: { prop: hit.prop, i: hit.i } }
      return
    }
    if (touch) {
      if (!hit) s.setGraphSel([])
      dragRef.current = { kind: 'pan', x, y, view }
      return
    }
    if (!e.shiftKey) s.setGraphSel([])
    dragRef.current = { kind: 'marquee', x, y, x2: x, y2: y, add: e.shiftKey }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e)
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x, y })
    const L = live.current
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const pv = pinch.current.view
      const sx = Math.max(0.05, Math.abs(a.x - b.x) / pinch.current.dx)
      const sy = Math.max(0.05, Math.abs(a.y - b.y) / pinch.current.dy)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const tMid = pv.t0 + ((pinch.current.mid.x - GUTTER) / L.plotW) * (pv.t1 - pv.t0)
      const vMid = pv.v1 - ((pinch.current.mid.y - RULER) / L.plotH) * (pv.v1 - pv.v0)
      const tw = (pv.t1 - pv.t0) / (pinch.current.dx > 40 ? sx : 1)
      const vh = (pv.v1 - pv.v0) / (pinch.current.dy > 40 ? sy : 1)
      const t0 = tMid - ((mid.x - GUTTER) / L.plotW) * tw
      const v1 = vMid + ((mid.y - RULER) / L.plotH) * vh
      setView({ t0, t1: t0 + tw, v0: v1 - vh, v1 })
      return
    }
    const d = dragRef.current
    if (!d) return
    const s = store()
    if (d.kind === 'scrub') {
      s.setPlayhead(Math.max(0, clip.start + L.xt(x)))
    } else if (d.kind === 'pan') {
      const dt = ((x - d.x) / L.plotW) * (d.view.t1 - d.view.t0)
      const dv = ((y - d.y) / L.plotH) * (d.view.v1 - d.view.v0)
      setView({ t0: d.view.t0 - dt, t1: d.view.t1 - dt, v0: d.view.v0 + dv, v1: d.view.v1 + dv })
    } else if (d.kind === 'marquee') {
      d.x2 = x
      d.y2 = y
      setMarquee({ x: d.x, y: d.y, x2: x, y2: y })
    } else if (d.kind === 'handle') {
      if (!d.active) {
        if (Math.hypot(x - d.x, y - d.y) < 3) return
        d.active = true
        s.beginGesture()
      }
      const k = d.orig[d.i]
      const t = L.xt(x)
      const valN = L.yv(y)
      const vv = normalized ? (bounds.get(d.prop)![0] + valN * (bounds.get(d.prop)![1] - bounds.get(d.prop)![0])) : valN
      const next = setHandle(d.orig, d.i, d.side, [t - k.t, vv - k.v], { breakTangent: e.altKey })
      s.setKeyframes(clip.id, d.prop, next)
    } else if (d.kind === 'keys') {
      let dx = x - d.x
      let dy = y - d.y
      if (!d.active) {
        if (Math.hypot(dx, dy) < 3) return
        d.active = true
        s.beginGesture()
      }
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      let dt = Math.round(((dx / L.plotW) * (L.v.t1 - L.v.t0)) * fps) / fps
      // Keys never pass unselected neighbours.
      let lo = -Infinity
      let hi = Infinity
      for (const [p, set] of d.sel) {
        const f = d.orig.get(p)!
        f.forEach((k, i) => {
          if (!set.has(i)) return
          let a = i - 1
          while (a >= 0 && set.has(a)) a--
          let b = i + 1
          while (b < f.length && set.has(b)) b++
          if (a >= 0) lo = Math.max(lo, f[a].t - k.t + 1 / fps)
          if (b < f.length) hi = Math.min(hi, f[b].t - k.t - 1 / fps)
        })
      }
      // Snap the grabbed key to the playhead or a marker (unless Alt).
      if (!e.altKey && dx !== 0 && store().snapping) {
        const grabbed = d.orig.get(d.hit.prop)![d.hit.i]
        const st = store()
        const targets = [
          st.playhead - clip.start,
          ...(st.snapMarkers ? allMarkers(st.doc).map((m) => m.time - clip.start) : []),
        ]
        const tol = (8 / L.plotW) * (L.v.t1 - L.v.t0)
        for (const t of targets) {
          if (Math.abs(grabbed.t + dt - t) < tol) {
            dt = t - grabbed.t
            break
          }
        }
      }
      dt = Math.min(hi, Math.max(lo, dt))
      const dn = -(dy / L.plotH) * (L.v.v1 - L.v.v0)
      for (const [p, set] of d.sel) {
        const f = d.orig.get(p)!
        const dv = isColorProp(p) ? 0 : denormDelta(p, dn)
        s.setKeyframes(
          clip.id,
          p,
          f.map((k, i) => (set.has(i) ? { ...k, t: k.t + dt, v: isColorProp(p) ? k.v : clampProp(p, k.v + dv) } : k)),
        )
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const s = store()
    if ((d.kind === 'keys' || d.kind === 'handle') && d.active) s.endGesture()
    if (d.kind === 'keys' && !d.active && s.graphSel.length > 1) s.setGraphSel([d.hit])
    if (d.kind === 'marquee') {
      setMarquee(null)
      const x0 = Math.min(d.x, d.x2)
      const x1 = Math.max(d.x, d.x2)
      const y0 = Math.min(d.y, d.y2)
      const y1 = Math.max(d.y, d.y2)
      const found: GraphKey[] = d.add ? [...s.graphSel] : []
      for (const p of [...curveProps, ...colorRows]) {
        framesOf(clip, p)!.forEach((_, i) => {
          const [kx, ky] = keyScreenPos(p, i)
          if (kx >= x0 && kx <= x1 && ky >= y0 && ky <= y1 && !found.some((k) => k.prop === p && k.i === i)) found.push({ prop: p, i })
        })
      }
      s.setGraphSel(found)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (locked) return
    const { x, y } = local(e)
    const hit = hitTest(x, y)
    let prop: AnimProp | null = null
    if (hit?.type === 'curve') prop = hit.prop
    else if (!hit && curveProps.length === 1 && y > RULER && y < RULER + plotH) prop = curveProps[0]
    if (!prop) return
    const f = framesOf(clip, prop)!
    const t = Math.round(xt(x) * fps) / fps
    if (f.some((k) => Math.abs(k.t - t) < 0.5 / fps)) return
    const prev = [...f].reverse().find((k) => k.t < t)
    const key: Keyframe = { t, v: curveValueAt(f, t), ease: prev?.ease ?? 'linear', hm: prev?.hm ?? null }
    const next = [...f, key].sort((a, b) => a.t - b.t)
    const s = store()
    s.setKeyframes(clip.id, prop, next)
    s.setGraphSel([{ prop, i: next.indexOf(key) }])
  }

  // wheel: zoom time (Shift: value); trackpad horizontal scroll pans.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const L = live.current
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setView((cur) => {
        if (!cur) return cur
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
          const dt = (e.deltaX / L.plotW) * (cur.t1 - cur.t0)
          return { ...cur, t0: cur.t0 + dt, t1: cur.t1 + dt }
        }
        const f = Math.exp(e.deltaY * 0.0015)
        if (e.shiftKey) {
          const vm = cur.v1 - ((y - RULER) / L.plotH) * (cur.v1 - cur.v0)
          return { ...cur, v0: vm - (vm - cur.v0) * f, v1: vm + (cur.v1 - vm) * f }
        }
        const tm = cur.t0 + ((x - GUTTER) / L.plotW) * (cur.t1 - cur.t0)
        return { ...cur, t0: tm - (tm - cur.t0) * f, t1: tm + (cur.t1 - tm) * f }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // -- keyboard ------------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    const s = store()
    const mod = e.ctrlKey || e.metaKey
    let handled = true
    if (e.key === ' ') {
      spaceDown.current = true
      handled = false // let Space still play/pause
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // Never let Delete fall through to "delete clip" while working in the graph.
      if (!locked && s.graphSel.length) deleteSelectedKeys()
    } else if (e.key === 'F9') {
      if (!locked && !runEasyEase(mod && e.shiftKey ? 'out' : e.shiftKey ? 'in' : 'both')) toast.info('Select keyframes first')
    } else if (e.key.toLowerCase() === 'f' && !mod) fit()
    else if (mod && e.key.toLowerCase() === 'c') {
      const n = copySelectedKeys()
      if (n) toast.info(`Copied ${n} key${n === 1 ? '' : 's'}`)
    } else if (mod && e.key.toLowerCase() === 'v') {
      if (!locked && !pasteKeys()) toast.info('Nothing to paste — copy keys with Ctrl+C first')
    } else if (mod && e.key.toLowerCase() === 'a') {
      const all: GraphKey[] = []
      for (const p of [...curveProps, ...colorRows]) framesOf(clip, p)!.forEach((_, i) => all.push({ prop: p, i }))
      s.setGraphSel(all)
    } else if (e.key === 'Escape' && s.graphSel.length) s.setGraphSel([])
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && s.graphSel.length && !locked) {
      nudge((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1) / fps, 0)
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && s.graphSel.length && !locked) {
      nudge(0, (e.key === 'ArrowUp' ? 1 : -1) * (v.v1 - v.v0) * (e.shiftKey ? 0.05 : 0.01))
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === ' ') spaceDown.current = false
  }

  const nudge = (dt: number, dn: number) => {
    const s = store()
    s.beginGesture()
    for (const [p, set] of selMap(s.graphSel)) {
      const f = framesOf(clip, p)!
      const moved = f.map((k, i) => (set.has(i) ? { ...k, t: k.t + dt, v: isColorProp(p) ? k.v : clampProp(p, k.v + denormDelta(p, dn)) } : k))
      // refuse moves that would reorder keys
      if (moved.every((k, i) => i === 0 || k.t > moved[i - 1].t)) s.setKeyframes(clip.id, p, moved)
    }
    s.endGesture()
  }

  // -- sub-views -----------------------------------------------------------------------------------
  const selected = graphSel.length === 1 ? graphSel[0] : null
  const selKey = selected ? framesOf(clip, selected.prop)?.[selected.i] : undefined

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-panel outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-label="Graph editor"
    >
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <ChartSpline size={14} className="shrink-0 text-accent-2" />
        <span className="mr-1 text-xs font-semibold whitespace-nowrap">Graph</span>
        <HeaderButton title="Easy ease both sides (F9)" disabled={locked} onClick={() => runEasyEase('both') || toast.info('Select keyframes first')}>
          Easy ease
        </HeaderButton>
        <HeaderButton title="Easy ease in (Shift+F9)" disabled={locked} onClick={() => runEasyEase('in') || toast.info('Select keyframes first')}>
          In
        </HeaderButton>
        <HeaderButton title="Easy ease out (Ctrl+Shift+F9)" disabled={locked} onClick={() => runEasyEase('out') || toast.info('Select keyframes first')}>
          Out
        </HeaderButton>
        <HeaderButton title="Linear" disabled={locked} onClick={() => setEase('linear')}>
          <Minus size={12} />
        </HeaderButton>
        <HeaderButton title="Hold (step)" disabled={locked} onClick={() => setEase('hold')}>
          Hold
        </HeaderButton>
        <HeaderButton
          title="Curve presets"
          disabled={locked}
          active={!!presetsAt}
          onClick={(e) => setPresetsAt(presetsAt ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          Presets ▾
        </HeaderButton>
        {presetsAt && <PresetsMenu clip={clip} anchor={presetsAt} onClose={() => setPresetsAt(null)} compact={compact} />}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line px-1">
        <IconButton
          label={normalized ? 'Normalised view (each curve fills the height) — click for real values' : 'Real values — click to normalise'}
          active={normalized}
          onClick={() => {
            setNormalized(!normalized)
            writeBool('yabbe.graphNormalized', !normalized)
          }}
        >
          <Scaling size={14} />
        </IconButton>
        <IconButton label="Fit view (F)" onClick={fit}>
          <Maximize2 size={14} />
        </IconButton>
        <IconButton label="Close graph editor (G)" onClick={onClose}>
          <X size={14} />
        </IconButton>
        </div>
      </div>

      <div className={`flex min-h-0 flex-1 ${compact ? 'flex-col' : ''}`}>
        {/* property list */}
        <div
          className={
            compact
              ? 'flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1'
              : 'flex w-36 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-1.5'
          }
        >
          {props.map((p) => {
            const shown = visible(p)
            const n = framesOf(clip, p)!.length
            return (
              <div key={p} className={`flex shrink-0 items-center gap-1 rounded px-1 py-0.5 ${shown ? '' : 'opacity-45'}`}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] hover:text-fg"
                  title={`Select all ${PROP_META[p].label} keys`}
                  onClick={() => shown && store().setGraphSel(framesOf(clip, p)!.map((_, i) => ({ prop: p, i })))}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PROP_META[p].color }} />
                  <span className="truncate">{PROP_META[p].label}</span>
                  <span className="text-faint">{n}</span>
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted hover:text-fg"
                  aria-label={shown ? `Hide ${PROP_META[p].label} in graph` : `Show ${PROP_META[p].label} in graph`}
                  title={shown ? 'Hide in graph' : 'Show in graph'}
                  onClick={() => store().setGraphHidden(clip.id, p, shown)}
                >
                  {shown ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
              </div>
            )
          })}
        </div>

        {/* canvas */}
        <div ref={boxRef} className="relative min-h-0 min-w-0 flex-1">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full touch-none select-none"
            style={{ cursor: spaceDown.current ? 'grab' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          />
          {curveProps.length === 0 && colorRows.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted">
              All animated properties are hidden — use the eye toggles.
            </div>
          )}
        </div>
      </div>

      {/* footer: selected key */}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-t border-line px-2 py-1 text-[11px]">
        {graphSel.length === 0 ? (
          <span className="text-faint">
            {compact
              ? 'Tap a key · drag to move · pinch to zoom · double-tap the curve to add'
              : 'Click keys (Shift adds, drag a box) · drag handles (Alt breaks) · double-click the curve to add · F9 easy ease · wheel zooms, Shift+wheel value'}
          </span>
        ) : selected && selKey ? (
          <KeyFields clip={clip} k={selected} frame={selKey} disabled={locked} />
        ) : (
          <MultiFields clip={clip} count={graphSel.length} disabled={locked} />
        )}
      </div>
    </div>
  )
}

function HeaderButton({
  children,
  title,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode
  title: string
  onClick: (e: React.MouseEvent) => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 shrink-0 items-center rounded px-1.5 text-[11px] whitespace-nowrap transition-colors disabled:opacity-40 ${
        active ? 'bg-accent/20 text-accent-2' : 'text-muted hover:bg-raised hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

/** Ease + parameters + handle mode for the selected keys' outgoing segments. */
function EaseControls({ clip, frame, disabled }: { clip: Clip; frame: Keyframe; disabled?: boolean }) {
  const hasParams = frame.ease.startsWith('back_') || frame.ease.startsWith('elastic_')
  const ep = frame.ep ?? []
  const setParam = (idx: number, val: number) => {
    const dflt = frame.ease.startsWith('back_') ? [1.70158] : [3, 10]
    const next = [...(ep.length ? ep : dflt)]
    next[idx] = val
    setEase(frame.ease, next)
  }
  const s = useEditor.getState
  const keys = actionKeys(clip)
  return (
    <>
      <label className="flex items-center gap-1 text-muted">
        Curve
        <select
          className="h-6 rounded border border-line bg-bg px-1 text-[11px] text-fg"
          value={frame.ease}
          disabled={disabled}
          onChange={(e) => setEase(e.target.value as Ease)}
        >
          {EASE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {hasParams && (
        <>
          <span className="text-muted">{frame.ease.startsWith('back_') ? 'Overshoot' : 'Wobbles'}</span>
          <div className="w-16">
            <NumberInput
              value={ep[0] ?? (frame.ease.startsWith('back_') ? 1.70158 : 3)}
              onChange={(v) => setParam(0, Math.max(0, v))}
              step={0.1}
              precision={2}
            />
          </div>
          {frame.ease.startsWith('elastic_') && (
            <>
              <span className="text-muted">Decay</span>
              <div className="w-14">
                <NumberInput value={ep[1] ?? 10} onChange={(v) => setParam(1, Math.max(0.1, v))} step={0.5} precision={1} />
              </div>
            </>
          )}
        </>
      )}
      <label className="flex items-center gap-1 text-muted">
        Handles
        <select
          className="h-6 rounded border border-line bg-bg px-1 text-[11px] text-fg"
          value={frame.hm ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const mode = e.target.value as HandleMode
            const st = s()
            st.beginGesture()
            for (const [p, set] of keys) {
              if (isColorProp(p)) continue
              let f = framesOf(clip, p)!
              for (const i of set) f = setHandleMode(f, i, mode, p)
              st.setKeyframes(clip.id, p, f)
            }
            st.endGesture()
          }}
        >
          {!frame.hm && <option value="">—</option>}
          {HANDLE_MODES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}

function KeyFields({ clip, k, frame, disabled }: { clip: Clip; k: GraphKey; frame: Keyframe; disabled: boolean }) {
  const fps = useEditor((s) => s.doc.settings.fps)
  const meta = PROP_META[k.prop]
  const frames = framesOf(clip, k.prop)!
  const s = useEditor.getState
  const setFrame = (patch: Partial<Keyframe>) => {
    const next = frames.map((f, i) => (i === k.i ? { ...f, ...patch } : f))
    if (patch.t !== undefined && !next.every((f, i) => i === 0 || f.t > next[i - 1].t)) {
      toast.info('A key can’t move past its neighbours')
      return
    }
    s().setKeyframes(clip.id, k.prop, next)
  }
  return (
    <>
      <span className="flex items-center gap-1 font-medium">
        <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} />
        {meta.label}
      </span>
      <div className="w-28">
        <NumberInput
          label="At"
          value={clip.start + frame.t}
          onChange={(v) => setFrame({ t: Math.round((v - clip.start) * fps) / fps })}
          step={1 / fps}
          precision={3}
          suffix="s"
        />
      </div>
      {isColorProp(k.prop) ? (
        <label className="flex items-center gap-1 text-muted">
          Colour
          <input
            type="color"
            disabled={disabled}
            value={(frame.c ?? '#ffffff').slice(0, 7)}
            onChange={(e) => setFrame({ c: e.target.value + (frame.c ?? '').slice(7) })}
            className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
          />
        </label>
      ) : (
        <div className="w-28">
          <NumberInput
            label="Value"
            value={frame.v * meta.mul}
            onChange={(v) => setFrame({ v: clampProp(k.prop, v / meta.mul) })}
            step={meta.mul === 100 ? 1 : 1}
            precision={2}
            suffix={meta.unit}
          />
        </div>
      )}
      {frames[k.i + 1] ? <EaseControls clip={clip} frame={frame} disabled={disabled} /> : <span className="text-faint">Last key</span>}
      <IconButton
        label="Delete key"
        disabled={disabled}
        onClick={() => {
          deleteSelectedKeys()
        }}
        className="h-6! w-6! hover:text-danger!"
      >
        <Trash2 size={12} />
      </IconButton>
    </>
  )
}

function MultiFields({ clip, count, disabled }: { clip: Clip; count: number; disabled: boolean }) {
  const sel = useEditor((s) => s.graphSel)
  const fps = useEditor((s) => s.doc.settings.fps)
  const times = sel.map((k) => framesOf(clip, k.prop)?.[k.i]?.t).filter((t): t is number => t !== undefined)
  const t0 = Math.min(...times)
  const spanNow = Math.max(...times) - t0
  const stretch = (target: number) => {
    if (spanNow <= 0 || target <= 0) return
    const k = target / spanNow
    const s = useEditor.getState()
    const byProp = new Map<AnimProp, Set<number>>()
    for (const g of sel) byProp.set(g.prop, (byProp.get(g.prop) ?? new Set()).add(g.i))
    const next = new Map<AnimProp, Keyframe[]>()
    for (const [p, set] of byProp) {
      const f = framesOf(clip, p)!
      const moved = f.map((key, i) =>
        set.has(i)
          ? {
              ...key,
              t: Math.round((t0 + (key.t - t0) * k) * fps) / fps,
              hi: key.hi ? ([key.hi[0] * k, key.hi[1]] as [number, number]) : key.hi,
              ho: key.ho ? ([key.ho[0] * k, key.ho[1]] as [number, number]) : key.ho,
            }
          : key,
      )
      if (!moved.every((key, i) => i === 0 || key.t > moved[i - 1].t)) {
        toast.info('That would push keys past their neighbours')
        return
      }
      next.set(p, moved)
    }
    s.beginGesture()
    for (const [p, f] of next) s.setKeyframes(clip.id, p, f)
    s.endGesture()
  }
  const first = sel.map((k) => framesOf(clip, k.prop)?.[k.i]).find((f, j) => f && framesOf(clip, sel[j].prop)![sel[j].i + 1])
  return (
    <>
      <span className="flex items-center gap-1 font-medium">
        <MoveHorizontal size={12} /> {count} keys
      </span>
      {spanNow > 0 && (
        <div className="w-28" title="Stretch or squeeze the timing of the selected keys">
          <NumberInput label="Span" value={spanNow} onChange={stretch} step={1 / fps} min={1 / fps} precision={2} suffix="s" />
        </div>
      )}
      {first && <EaseControls clip={clip} frame={first} disabled={disabled} />}
      <IconButton label="Delete keys" disabled={disabled} onClick={deleteSelectedKeys} className="h-6! w-6! hover:text-danger!">
        <Trash2 size={12} />
      </IconButton>
    </>
  )
}

// -- presets popover -----------------------------------------------------------------------------

function PresetThumb({ preset }: { preset: CurvePreset }) {
  const pts: string[] = []
  const w = 44
  const h = 30
  let lo = 0
  let hi = 1
  for (let i = 0; i <= 40; i++) {
    const y = presetShape(preset, i / 40)
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
  }
  const pad = 3
  const sy = (y: number) => h - pad - ((y - lo) / (hi - lo)) * (h - pad * 2)
  for (let i = 0; i <= 40; i++) {
    const x = pad + (i / 40) * (w - pad * 2)
    const y = preset.ease === 'hold' ? (i < 40 ? sy(0) : sy(1)) : sy(presetShape(preset, i / 40))
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }
  return (
    <svg width={w} height={h} className="shrink-0" aria-hidden>
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="3" fill="#0e0f13" stroke="#2a2e3a" />
      <polyline points={pts.join(' ')} fill="none" stroke="#9d85ff" strokeWidth="1.6" />
    </svg>
  )
}

function PresetsMenu({
  clip,
  anchor,
  onClose,
  compact,
}: {
  clip: Clip
  anchor: DOMRect
  onClose: () => void
  compact: boolean
}) {
  const [saved, setSaved] = useState<CurvePreset[]>(loadSavedPresets)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (ref.current && !ref.current.contains(t) && !t.closest('[aria-label="Curve presets"]')) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  const groups = new Map<string, CurvePreset[]>()
  for (const p of [...PRESETS, ...saved]) groups.set(p.group, [...(groups.get(p.group) ?? []), p])

  const apply = (p: CurvePreset) => {
    if (!runPreset(p)) toast.info('Select keyframes (or put the playhead between two keys) first')
  }
  const saveCurrent = () => {
    const s = useEditor.getState()
    const keys = actionKeys(clip)
    for (const [prop, set] of keys) {
      const f = framesOf(clip, prop)!
      const seg = targetSegments(f.length, set)[0] ?? (s.graphSel.length ? undefined : [...set][0])
      if (seg === undefined || !f[seg + 1]) continue
      const name = window.prompt('Name this curve preset', 'My curve')
      if (!name) return
      const preset = presetFromSegment(f, seg, isColorProp(prop), name.slice(0, 40))
      if (!preset) return
      const next = [...saved, preset]
      setSaved(next)
      storeSavedPresets(next)
      toast.success(`Saved “${preset.label}”`)
      return
    }
    toast.info('Select a key (with a curve after it) to save its shape')
  }

  return (
    <div
      ref={ref}
      className={`toast-in fixed z-50 overflow-y-auto rounded-lg border border-line bg-raised p-2 shadow-2xl shadow-black/60 ${
        compact ? 'inset-x-2' : 'w-[340px]'
      }`}
      // The graph sits at the bottom of the screen: open upwards from the button.
      style={{
        bottom: window.innerHeight - anchor.top + 4,
        left: compact ? undefined : Math.max(8, Math.min(anchor.left, window.innerWidth - 348)),
        maxHeight: Math.max(160, anchor.top - 12),
      }}
    >
      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="mb-2">
          <div className="mb-1 px-1 text-[10px] font-semibold tracking-wide text-faint uppercase">{group}</div>
          <div className="grid grid-cols-3 gap-1">
            {list.map((p) => (
              <div key={p.id} className="group relative">
                <button
                  type="button"
                  onClick={() => apply(p)}
                  className="flex w-full flex-col items-center gap-0.5 rounded p-1 text-[10px] text-muted hover:bg-white/5 hover:text-fg"
                  title={`Apply “${p.label}”`}
                >
                  <PresetThumb preset={p} />
                  <span className="truncate">{p.label}</span>
                </button>
                {p.custom && (
                  <button
                    type="button"
                    aria-label={`Delete preset ${p.label}`}
                    onClick={() => {
                      const next = saved.filter((x) => x.id !== p.id)
                      setSaved(next)
                      storeSavedPresets(next)
                    }}
                    className="absolute top-0 right-0 hidden rounded bg-black/60 p-0.5 text-muted group-hover:block hover:text-danger pointer-coarse:block"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={saveCurrent}
        className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-line py-1.5 text-[11px] text-muted hover:border-line-strong hover:text-fg"
      >
        <Bookmark size={12} /> Save selected curve as preset
      </button>
    </div>
  )
}
