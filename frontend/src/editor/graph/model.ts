// Pure keyframe-editing logic for the graph editor (handles, presets, easy ease).
// Everything here returns new arrays; the store applies them as undoable changes.
import type { AnimProp, Ease, HandleMode, Keyframe } from '../../api/types'
import { bezierHandles, curveValueAt, namedEase, solveBezierX } from '../curves'
import { isColorProp } from '../keyframes'

export type Handle = [number, number]
export type Side = 'in' | 'out'

/** Value delta of segment i→i+1 (colour keys are 0→1 progress). */
export const segDelta = (frames: Keyframe[], i: number, color: boolean) => (color ? 1 : frames[i + 1].v - frames[i].v)

/** Handle a Bézier segment would use (explicit or the straight-line default). */
export function effectiveHandle(frames: Keyframe[], i: number, side: Side, color = false): Handle | null {
  const k = frames[i]
  if (side === 'out') {
    const b = frames[i + 1]
    if (!b || k.ease !== 'bezier') return null
    return k.ho ?? [(b.t - k.t) / 3, segDelta(frames, i, color) / 3]
  }
  const a = frames[i - 1]
  if (!a || a.ease !== 'bezier') return null
  return k.hi ?? [-(k.t - a.t) / 3, -segDelta(frames, i - 1, color) / 3]
}

/** Smooth tangent through a key from its neighbours (Catmull-Rom style). */
function autoSlope(frames: Keyframe[], i: number, clamped: boolean): number {
  const k = frames[i]
  const prev = frames[i - 1]
  const next = frames[i + 1]
  if (!prev || !next) {
    if (clamped) return 0
    const o = prev ?? next!
    return (k.v - o.v) / (k.t - o.t || 1)
  }
  // Clamped: flat at peaks/valleys so the curve never overshoots its keys.
  if (clamped && (k.v - prev.v) * (next.v - k.v) <= 0) return 0
  return (next.v - prev.v) / (next.t - prev.t || 1)
}

/** Recompute handles of keys in auto / auto_clamped mode. */
export function recalcAuto(frames: Keyframe[], prop: AnimProp): Keyframe[] {
  if (isColorProp(prop) || !frames.some((k) => k.hm === 'auto' || k.hm === 'auto_clamped')) return frames
  return frames.map((k, i) => {
    if (k.hm !== 'auto' && k.hm !== 'auto_clamped') return k
    const slope = autoSlope(frames, i, k.hm === 'auto_clamped')
    const prev = frames[i - 1]
    const next = frames[i + 1]
    const hi: Handle | null = prev ? [-(k.t - prev.t) / 3, (-(k.t - prev.t) / 3) * slope] : k.hi ?? null
    const ho: Handle | null = next ? [(next.t - k.t) / 3, ((next.t - k.t) / 3) * slope] : k.ho ?? null
    return { ...k, hi, ho }
  })
}

/**
 * Drag a handle. Makes the segment a Bézier curve; unless ``breakTangent`` (or
 * the key is already "free"), the opposite handle stays in line ("aligned").
 */
export function setHandle(
  frames: Keyframe[],
  i: number,
  side: Side,
  h: Handle,
  opts: { breakTangent?: boolean; color?: boolean } = {},
): Keyframe[] {
  const out = frames.map((k) => ({ ...k }))
  const k = out[i]
  const dt = side === 'out' ? Math.max(0, h[0]) : Math.min(0, h[0])
  const dv = h[1]
  if (side === 'out') {
    if (!out[i + 1]) return frames
    k.ease = 'bezier'
    k.ho = [dt, dv]
  } else {
    if (!out[i - 1]) return frames
    out[i - 1].ease = 'bezier'
    k.hi = [dt, dv]
  }
  const mode: HandleMode = opts.breakTangent || k.hm === 'free' ? 'free' : 'aligned'
  k.hm = mode
  if (mode === 'aligned' && Math.abs(dt) > 1e-9) {
    const other: Side = side === 'out' ? 'in' : 'out'
    const cur = effectiveHandle(out, i, other, opts.color)
    if (cur) {
      const slope = dv / dt
      const odt = cur[0]
      if (other === 'out') k.ho = [odt, odt * slope]
      else k.hi = [odt, odt * slope]
    }
  }
  return out
}

export function setHandleMode(frames: Keyframe[], i: number, mode: HandleMode, prop: AnimProp): Keyframe[] {
  const out = frames.map((k, j) => (j === i ? { ...k, hm: mode } : k))
  // Auto modes only make sense on Bézier segments: switch the adjacent ones.
  if (mode === 'auto' || mode === 'auto_clamped') {
    if (out[i + 1]) out[i] = { ...out[i], ease: 'bezier' }
    if (out[i - 1]) out[i - 1] = { ...out[i - 1], ease: 'bezier' }
  }
  return recalcAuto(out, prop)
}

// -- presets ------------------------------------------------------------------------------

export interface CurvePreset {
  id: string
  label: string
  group: string
  ease: Ease
  /** Normalised cubic-bezier (CSS style) for Bézier presets. */
  cb?: [number, number, number, number]
  ep?: number[]
  custom?: boolean
}

const fam = (
  name: string,
  inCb: [number, number, number, number],
  outCb: [number, number, number, number],
  inOutCb: [number, number, number, number],
): CurvePreset[] => [
  { id: `${name.toLowerCase()}_in`, label: `${name} in`, group: name, ease: 'bezier', cb: inCb },
  { id: `${name.toLowerCase()}_out`, label: `${name} out`, group: name, ease: 'bezier', cb: outCb },
  { id: `${name.toLowerCase()}_in_out`, label: `${name} in-out`, group: name, ease: 'bezier', cb: inOutCb },
]

/** Built-in presets. Bézier values follow the widely used easings.net set. */
export const PRESETS: CurvePreset[] = [
  { id: 'linear', label: 'Linear', group: 'Basic', ease: 'linear' },
  { id: 'hold', label: 'Hold', group: 'Basic', ease: 'hold' },
  { id: 'easy_ease', label: 'Easy ease', group: 'Basic', ease: 'bezier', cb: [0.333, 0, 0.667, 1] },
  { id: 'ease_in', label: 'Ease in', group: 'Basic', ease: 'bezier', cb: [0.42, 0, 1, 1] },
  { id: 'ease_out', label: 'Ease out', group: 'Basic', ease: 'bezier', cb: [0, 0, 0.58, 1] },
  ...fam('Sine', [0.12, 0, 0.39, 0], [0.61, 1, 0.88, 1], [0.37, 0, 0.63, 1]),
  ...fam('Quad', [0.11, 0, 0.5, 0], [0.5, 1, 0.89, 1], [0.45, 0, 0.55, 1]),
  ...fam('Cubic', [0.32, 0, 0.67, 0], [0.33, 1, 0.68, 1], [0.65, 0, 0.35, 1]),
  ...fam('Quart', [0.5, 0, 0.75, 0], [0.25, 1, 0.5, 1], [0.76, 0, 0.24, 1]),
  ...fam('Quint', [0.64, 0, 0.78, 0], [0.22, 1, 0.36, 1], [0.83, 0, 0.17, 1]),
  ...fam('Expo', [0.7, 0, 0.84, 0], [0.16, 1, 0.3, 1], [0.87, 0, 0.13, 1]),
  ...fam('Circ', [0.55, 0, 1, 0.45], [0, 0.55, 0.45, 1], [0.85, 0, 0.15, 1]),
  { id: 'back_in', label: 'Back in', group: 'Back', ease: 'back_in' },
  { id: 'back_out', label: 'Back out', group: 'Back', ease: 'back_out' },
  { id: 'back_in_out', label: 'Back in-out', group: 'Back', ease: 'back_in_out' },
  { id: 'elastic_in', label: 'Elastic in', group: 'Elastic', ease: 'elastic_in' },
  { id: 'elastic_out', label: 'Elastic out', group: 'Elastic', ease: 'elastic_out' },
  { id: 'elastic_in_out', label: 'Elastic in-out', group: 'Elastic', ease: 'elastic_in_out' },
  { id: 'bounce_in', label: 'Bounce in', group: 'Bounce', ease: 'bounce_in' },
  { id: 'bounce_out', label: 'Bounce out', group: 'Bounce', ease: 'bounce_out' },
  { id: 'bounce_in_out', label: 'Bounce in-out', group: 'Bounce', ease: 'bounce_in_out' },
]

/** Progress 0→1 of a preset at p (for thumbnails and custom presets). */
export function presetShape(p: CurvePreset, x: number): number {
  if (p.cb) {
    const [x1, y1, x2, y2] = p.cb
    const s = solveBezierX(x1, x2, x)
    const m = 1 - s
    return 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s
  }
  return namedEase(p.ease, x, p.ep)
}

/** Apply a preset to segment i→i+1. */
export function applyPresetToSegment(frames: Keyframe[], i: number, p: CurvePreset, color: boolean): Keyframe[] {
  if (!frames[i + 1]) return frames
  const out = frames.map((k) => ({ ...k }))
  const a = out[i]
  const b = out[i + 1]
  if (p.cb) {
    const span = b.t - a.t
    const dv = segDelta(out, i, color)
    const [x1, y1, x2, y2] = p.cb
    a.ease = 'bezier'
    a.ep = null
    a.ho = [x1 * span, y1 * dv]
    b.hi = [(x2 - 1) * span, (y2 - 1) * dv]
    // Preset handles are deliberate: stop auto modes from recalculating them.
    if (a.hm === 'auto' || a.hm === 'auto_clamped' || a.hm === 'aligned') a.hm = 'free'
    if (b.hm === 'auto' || b.hm === 'auto_clamped' || b.hm === 'aligned') b.hm = 'free'
  } else {
    a.ease = p.ease
    a.ep = p.ep ?? null
  }
  return out
}

/** Capture segment i's shape as a reusable preset. */
export function presetFromSegment(frames: Keyframe[], i: number, color: boolean, label: string): CurvePreset | null {
  const a = frames[i]
  const b = frames[i + 1]
  if (!a || !b) return null
  const id = `custom_${Date.now().toString(36)}`
  if (a.ease !== 'bezier') return { id, label, group: 'Saved', ease: a.ease, ep: a.ep ?? undefined, custom: true }
  const dv = segDelta(frames, i, color)
  const v0 = color ? 0 : a.v
  const v1 = color ? 1 : b.v
  const [x1, y1, x2, y2] = bezierHandles(a, b, v0, v1)
  const norm = (y: number) => (Math.abs(dv) > 1e-9 ? (y - v0) / dv : 0)
  return { id, label, group: 'Saved', ease: 'bezier', cb: [x1, norm(y1), x2, norm(y2)], custom: true }
}

/**
 * After Effects' Easy Ease on key i: flat handles with ⅓ influence on the
 * incoming side, outgoing side, or both (F9 / Shift+F9 / Ctrl+Shift+F9).
 */
export function easyEase(frames: Keyframe[], i: number, side: 'both' | Side): Keyframe[] {
  const out = frames.map((k) => ({ ...k }))
  const k = out[i]
  const prev = out[i - 1]
  const next = out[i + 1]
  if ((side === 'both' || side === 'in') && prev) {
    prev.ease = 'bezier'
    k.hi = [-(k.t - prev.t) / 3, 0]
  }
  if ((side === 'both' || side === 'out') && next) {
    k.ease = 'bezier'
    k.ho = [(next.t - k.t) / 3, 0]
  }
  k.hm = side === 'both' ? 'aligned' : 'free'
  return out
}

/** Segments a preset should affect, given the selected key indices. */
export function targetSegments(count: number, selected: Set<number>): number[] {
  const segs: number[] = []
  for (const i of selected) {
    if (i + 1 >= count) continue
    if (selected.size === 1 || selected.has(i + 1)) segs.push(i)
  }
  return segs.sort((a, b) => a - b)
}

/** Min/max a curve reaches over [t0, t1] (for fitting the view). */
export function curveBounds(frames: Keyframe[], t0: number, t1: number, steps = 200): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let s = 0; s <= steps; s++) {
    const v = curveValueAt(frames, t0 + ((t1 - t0) * s) / steps)
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  for (const k of frames) {
    lo = Math.min(lo, k.v)
    hi = Math.max(hi, k.v)
  }
  return [lo, hi]
}
