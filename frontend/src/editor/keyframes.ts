// Mirrors backend/app/engine/keyframes.py — keep the curves identical.
import type { AnimProp, Clip, Ease, Keyframe } from '../api/types'

export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume']

export const EASES: { value: Ease; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease_in_out', label: 'Ease in & out' },
  { value: 'ease_in', label: 'Ease in' },
  { value: 'ease_out', label: 'Ease out' },
  { value: 'hold', label: 'Hold' },
]

export function ease(kind: Ease, p: number): number {
  p = Math.min(1, Math.max(0, p))
  switch (kind) {
    case 'hold':
      return 0
    case 'ease_in':
      return p * p * p
    case 'ease_out':
      return 1 - (1 - p) ** 3
    case 'ease_in_out':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
    default:
      return p
  }
}

export function valueAt(frames: Keyframe[], u: number): number {
  if (u <= frames[0].t) return frames[0].v
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i]
    const b = frames[i + 1]
    if (u < b.t) {
      const span = b.t - a.t
      return a.v + (b.v - a.v) * ease(a.ease, span > 0 ? (u - a.t) / span : 1)
    }
  }
  return frames[frames.length - 1].v
}

export function staticValue(clip: Clip, prop: AnimProp): number {
  return prop === 'volume' ? clip.volume : clip.transform[prop]
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

/** Insert or replace the keyframe at ``u`` (keeps its easing when replacing). */
export function upsertKey(frames: Keyframe[] | undefined, u: number, v: number, fps: number): Keyframe[] {
  const list = [...(frames ?? [])]
  const i = keyIndexAt(list, u, fps)
  if (i >= 0) list[i] = { ...list[i], v }
  else {
    // A new key inherits the easing of the segment it splits.
    const prev = [...list].reverse().find((k) => k.t < u)
    list.push({ t: u, v, ease: prev?.ease ?? 'linear' })
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
