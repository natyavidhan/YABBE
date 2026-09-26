// Keyframe curve maths — exact mirror of backend/app/engine/curves.py.
// Both are verified against backend/tests/fixtures/curves.json.
import type { Ease, Keyframe } from '../api/types'

const clamp01 = (p: number) => (p < 0 ? 0 : p > 1 ? 1 : p)

function bounceOut(p: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (p < 1 / d1) return n1 * p * p
  if (p < 2 / d1) {
    p -= 1.5 / d1
    return n1 * p * p + 0.75
  }
  if (p < 2.5 / d1) {
    p -= 2.25 / d1
    return n1 * p * p + 0.9375
  }
  p -= 2.625 / d1
  return n1 * p * p + 0.984375
}

function elasticOut(p: number, osc: number, decay: number): number {
  const residual = 2 ** -decay * Math.cos(2 * Math.PI * osc)
  return 1 - 2 ** (-decay * p) * Math.cos(2 * Math.PI * osc * p) + p * residual
}

const inOut = (fIn: (x: number) => number, p: number) => (p < 0.5 ? fIn(2 * p) / 2 : 1 - fIn(2 - 2 * p) / 2)

/** Progress 0→1 of the named eases (back/elastic may overshoot). */
export function namedEase(kind: Ease, p: number, ep?: number[] | null): number {
  p = clamp01(p)
  const e = ep ?? []
  switch (kind) {
    case 'hold':
      return 0
    case 'ease_in':
      return p * p * p
    case 'ease_out':
      return 1 - (1 - p) ** 3
    case 'ease_in_out':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
  }
  if (kind.startsWith('back_')) {
    const c1 = e.length ? e[0] : 1.70158
    const backIn = (x: number) => (c1 + 1) * x ** 3 - c1 * x ** 2
    if (kind === 'back_in') return backIn(p)
    if (kind === 'back_out') return 1 - backIn(1 - p)
    return inOut(backIn, p)
  }
  if (kind.startsWith('elastic_')) {
    const osc = e.length > 0 ? e[0] : 3
    const decay = e.length > 1 ? e[1] : 10
    const out = (x: number) => elasticOut(x, osc, decay)
    if (kind === 'elastic_out') return out(p)
    const elIn = (x: number) => 1 - out(1 - x)
    if (kind === 'elastic_in') return elIn(p)
    return inOut(elIn, p)
  }
  if (kind.startsWith('bounce_')) {
    const bIn = (x: number) => 1 - bounceOut(1 - x)
    if (kind === 'bounce_out') return bounceOut(p)
    if (kind === 'bounce_in') return bIn(p)
    return inOut(bIn, p)
  }
  return p
}

/** Default handle: a straight line (⅓ of the segment). */
export function defaultOut(a: Keyframe, b: Keyframe, v0 = a.v, v1 = b.v): [number, number] {
  return [(b.t - a.t) / 3, (v1 - v0) / 3]
}
export function defaultIn(a: Keyframe, b: Keyframe, v0 = a.v, v1 = b.v): [number, number] {
  return [-(b.t - a.t) / 3, -(v1 - v0) / 3]
}

/** Normalised-time control points (x1, y1, x2, y2); y in value units. */
export function bezierHandles(a: Keyframe, b: Keyframe, v0: number, v1: number): [number, number, number, number] {
  const span = b.t - a.t
  const ho = a.ho ?? defaultOut(a, b, v0, v1)
  const hi = b.hi ?? defaultIn(a, b, v0, v1)
  let hx1 = Math.min(Math.max(ho[0], 0), span)
  let hx2 = Math.min(Math.max(-hi[0], 0), span)
  if (hx1 + hx2 > span && span > 0) {
    const k = span / (hx1 + hx2)
    hx1 *= k
    hx2 *= k
  }
  const x1 = span > 0 ? hx1 / span : 0
  const x2 = span > 0 ? 1 - hx2 / span : 1
  return [x1, v0 + ho[1], x2, v1 + hi[1]]
}

const cubic = (p0: number, p1: number, p2: number, p3: number, s: number) => {
  const m = 1 - s
  return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3
}
const cubicD = (p0: number, p1: number, p2: number, p3: number, s: number) => {
  const m = 1 - s
  return 3 * m * m * (p1 - p0) + 6 * m * s * (p2 - p1) + 3 * s * s * (p3 - p2)
}

export function solveBezierX(x1: number, x2: number, p: number): number {
  let s = p
  for (let i = 0; i < 8; i++) {
    const x = cubic(0, x1, x2, 1, s) - p
    if (Math.abs(x) < 1e-9) return s
    const d = cubicD(0, x1, x2, 1, s)
    if (Math.abs(d) < 1e-9) break
    s -= x / d
    if (s < 0 || s > 1) break
  }
  let lo = 0
  let hi = 1
  s = p
  for (let i = 0; i < 60; i++) {
    const x = cubic(0, x1, x2, 1, s)
    if (Math.abs(x - p) < 1e-10) break
    if (x < p) lo = s
    else hi = s
    s = (lo + hi) / 2
  }
  return s
}

export function segmentValue(a: Keyframe, b: Keyframe, u: number, v0: number, v1: number): number {
  const span = b.t - a.t
  if (span <= 0) return v1
  const p = clamp01((u - a.t) / span)
  if (a.ease === 'bezier') {
    const [x1, y1, x2, y2] = bezierHandles(a, b, v0, v1)
    return cubic(v0, y1, y2, v1, solveBezierX(x1, x2, p))
  }
  return v0 + (v1 - v0) * namedEase(a.ease, p, a.ep)
}

function segmentIndex(frames: Keyframe[], u: number): number | null {
  if (u <= frames[0].t || u >= frames[frames.length - 1].t) return null
  let lo = 0
  let hi = frames.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (frames[mid].t <= u) lo = mid
    else hi = mid
  }
  return lo
}

export function curveValueAt(frames: Keyframe[], u: number): number {
  const i = segmentIndex(frames, u)
  if (i === null) return u <= frames[0].t ? frames[0].v : frames[frames.length - 1].v
  return segmentValue(frames[i], frames[i + 1], u, frames[i].v, frames[i + 1].v)
}

/** [segment index, eased progress] for colour keys. */
export function progressAt(frames: Keyframe[], u: number): [number, number] {
  const i = segmentIndex(frames, u)
  if (i === null) return u <= frames[0].t ? [0, 0] : [frames.length - 2, 1]
  return [i, segmentValue(frames[i], frames[i + 1], u, 0, 1)]
}
