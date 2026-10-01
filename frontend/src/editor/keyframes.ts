// Mirrors backend/app/engine/keyframes.py — keep the curves identical.
import type { AnimProp, Clip, Ease, Keyframe, ShapeStyle, TextStyle } from '../api/types'
import { curveValueAt, namedEase, progressAt } from './curves'

export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume']

type NumericTextField = 'size' | 'stroke_width' | 'padding' | 'line_spacing'
type ColorTextField = 'color' | 'stroke_color' | 'background'

export const TEXT_NUMERIC: Partial<Record<AnimProp, NumericTextField>> = {
  text_size: 'size',
  text_stroke_width: 'stroke_width',
  text_padding: 'padding',
  text_line_spacing: 'line_spacing',
}
export const TEXT_COLOR: Partial<Record<AnimProp, ColorTextField>> = {
  text_color: 'color',
  text_stroke_color: 'stroke_color',
  text_background: 'background',
}
const INT_FIELDS = new Set(['size', 'stroke_width', 'padding'])

type NumericShapeField = 'width' | 'height' | 'stroke_width' | 'radius'
type ColorShapeField = 'fill' | 'stroke'
export const SHAPE_NUMERIC: Partial<Record<AnimProp, NumericShapeField>> = {
  shape_width: 'width',
  shape_height: 'height',
  shape_stroke_width: 'stroke_width',
  shape_radius: 'radius',
}
export const SHAPE_COLOR: Partial<Record<AnimProp, ColorShapeField>> = { shape_fill: 'fill', shape_stroke: 'stroke' }

export const isColorProp = (p: AnimProp) => p in TEXT_COLOR || p in SHAPE_COLOR

export const EASES: { value: Ease; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease_in_out', label: 'Ease in & out' },
  { value: 'ease_in', label: 'Ease in' },
  { value: 'ease_out', label: 'Ease out' },
  { value: 'hold', label: 'Hold' },
]

export function ease(kind: Ease, p: number): number {
  return namedEase(kind, p)
}

export function valueAt(frames: Keyframe[], u: number): number {
  return curveValueAt(frames, u)
}

export function staticValue(clip: Clip, prop: AnimProp): number {
  if (prop === 'volume') return clip.volume
  const field = TEXT_NUMERIC[prop]
  if (field) return clip.text?.[field] ?? 0
  const sf = SHAPE_NUMERIC[prop]
  if (sf) return clip.shape?.[sf] ?? 0
  if (isColorProp(prop)) return 0
  return clip.transform[prop as 'x' | 'y' | 'scale' | 'rotation' | 'opacity']
}

export function staticColor(clip: Clip, prop: AnimProp): string | null {
  const field = TEXT_COLOR[prop]
  if (field) return clip.text?.[field] ?? null
  const sf = SHAPE_COLOR[prop]
  return sf ? (clip.shape?.[sf] ?? null) : null
}

/** Shape with shape keyframes evaluated at timeline time ``T``. */
export function shapeStyleAt(clip: Clip, T: number): ShapeStyle | null {
  if (!clip.shape) return null
  let style = clip.shape
  for (const [prop, field] of Object.entries(SHAPE_NUMERIC) as [AnimProp, NumericShapeField][]) {
    const f = framesOf(clip, prop)
    if (f) style = { ...style, [field]: valueAt(f, T - clip.start) }
  }
  for (const [prop, field] of Object.entries(SHAPE_COLOR) as [AnimProp, ColorShapeField][]) {
    const f = framesOf(clip, prop)
    if (f) style = { ...style, [field]: colorAt(f, T - clip.start) }
  }
  return style
}

// -- colours ---------------------------------------------------------------------------

function rgba(c: string): number[] {
  const h = c.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255)
}

const hex = (ch: number[]) =>
  '#' + ch.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')

export function colorAt(frames: Keyframe[], u: number): string {
  const col = (k: Keyframe) => rgba(k.c || '#ffffff')
  if (frames.length === 1) return hex(col(frames[0]))
  const [i, p] = progressAt(frames, u)
  const ca = col(frames[i])
  const cb = col(frames[i + 1])
  return hex(ca.map((x, j) => x + (cb[j] - x) * p))
}

/** Colour property at timeline time ``T`` (keyframes applied). */
export function colorPropAt(clip: Clip, prop: AnimProp, T: number): string | null {
  const f = framesOf(clip, prop)
  return f ? colorAt(f, T - clip.start) : staticColor(clip, prop)
}

/** Text style with style keyframes evaluated at timeline time ``T``. */
export function textStyleAt(clip: Clip, T: number): TextStyle | null {
  if (!clip.text) return null
  let style = clip.text
  for (const [prop, field] of Object.entries(TEXT_NUMERIC) as [AnimProp, NumericTextField][]) {
    const f = framesOf(clip, prop)
    if (f) {
      const v = valueAt(f, T - clip.start)
      style = { ...style, [field]: INT_FIELDS.has(field) ? Math.round(v) : Math.round(v * 1000) / 1000 }
    }
  }
  for (const [prop, field] of Object.entries(TEXT_COLOR) as [AnimProp, ColorTextField][]) {
    const f = framesOf(clip, prop)
    if (f) style = { ...style, [field]: colorAt(f, T - clip.start) }
  }
  return style
}

export const framesOf = (clip: Clip, prop: AnimProp): Keyframe[] | undefined => {
  const f = clip.keyframes?.[prop]
  return f && f.length ? f : undefined
}

export const isAnimated = (clip: Clip, prop: AnimProp) => !!framesOf(clip, prop)

/** Clip-local time for timeline time ``T``, snapped to the frame grid. */
export function localTime(clip: Clip, T: number, fps: number): number {
  return Math.round((T - clip.start) * fps) / fps
}

/** Property value at timeline time ``T`` (keyframes applied). */
export function propAt(clip: Clip, prop: AnimProp, T: number): number {
  const f = framesOf(clip, prop)
  return f ? valueAt(f, T - clip.start) : staticValue(clip, prop)
}

/** Transform with keyframes evaluated at timeline time ``T``. */
export function transformAt(clip: Clip, T: number): Clip['transform'] {
  const has = clip.keyframes && Object.keys(clip.keyframes).length > 0
  if (!has) return clip.transform
  return {
    ...clip.transform,
    x: propAt(clip, 'x', T),
    y: propAt(clip, 'y', T),
    scale: propAt(clip, 'scale', T),
    rotation: propAt(clip, 'rotation', T),
    opacity: propAt(clip, 'opacity', T),
  }
}

export const keyTolerance = (fps: number) => 0.5 / fps

export function keyIndexAt(frames: Keyframe[] | undefined, u: number, fps: number): number {
  if (!frames) return -1
  const tol = keyTolerance(fps)
  return frames.findIndex((k) => Math.abs(k.t - u) <= tol)
}

/** Insert or replace the keyframe at ``u`` (keeps its easing when replacing).
 * ``value`` is a number, or a colour string for colour properties. */
export function upsertKey(frames: Keyframe[] | undefined, u: number, value: number | string, fps: number): Keyframe[] {
  const list = [...(frames ?? [])]
  const fields = typeof value === 'string' ? { v: 0, c: value } : { v: value }
  const i = keyIndexAt(list, u, fps)
  if (i >= 0) list[i] = { ...list[i], ...fields }
  else {
    // A new key inherits the easing of the segment it splits.
    const prev = [...list].reverse().find((k) => k.t < u)
    list.push({ t: u, ...fields, ease: prev?.ease ?? 'linear' })
  }
  return list.sort((a, b) => a.t - b.t)
}

/** Shift every key by ``dt`` (used when a clip's start moves but its content
 * doesn't). Keys may land outside the clip; they still shape the curve. */
export function shiftKeyframes(kf: Clip['keyframes'], dt: number): Clip['keyframes'] {
  if (!kf || !dt) return kf
  const out: Clip['keyframes'] = {}
  for (const [prop, frames] of Object.entries(kf) as [AnimProp, Keyframe[]][]) {
    out[prop] = frames.map((k) => ({ ...k, t: k.t + dt }))
  }
  return out
}

/** All distinct key times of a clip (for timeline markers / navigation). */
export function allKeyTimes(clip: Clip): number[] {
  const times: number[] = []
  for (const frames of Object.values(clip.keyframes ?? {})) {
    for (const k of frames ?? []) if (!times.some((t) => Math.abs(t - k.t) < 1e-4)) times.push(k.t)
  }
  return times.sort((a, b) => a - b)
}

// -- markers (same time base as keyframes: seconds from the clip's start) -----------------

export const MARKER_COLORS = ['#f2b84b', '#ef5f6b', '#3fcf8e', '#4dabf7', '#9d85ff', '#f783ac']

export const shiftMarkers = (markers: Clip['markers'] | undefined, dt: number): Clip['markers'] =>
  (markers ?? []).map((m) => ({ ...m, t: m.t + dt }))

/** Markers that currently fall inside the clip (others are hidden after trims). */
export const visibleMarkers = (clip: Clip) =>
  (clip.markers ?? []).filter((m) => m.t >= -1e-6 && m.t <= clip.duration + 1e-6).sort((a, b) => a.t - b.t)
