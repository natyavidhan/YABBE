import { describe, expect, it } from 'vitest'
import type { Keyframe } from '../../api/types'
import { curveValueAt } from '../curves'
import {
  applyPresetToSegment,
  easyEase,
  PRESETS,
  presetFromSegment,
  presetShape,
  recalcAuto,
  setHandle,
  targetSegments,
} from './model'

const K = (t: number, v: number, extra: Partial<Keyframe> = {}): Keyframe => ({ t, v, ease: 'linear', ...extra })
const preset = (id: string) => PRESETS.find((p) => p.id === id)!

describe('presets', () => {
  it('every preset starts at 0 and ends at 1', () => {
    for (const p of PRESETS) {
      if (p.ease === 'hold') continue
      expect(presetShape(p, 0)).toBeCloseTo(0, 6)
      expect(presetShape(p, 1)).toBeCloseTo(1, 6)
    }
  })

  it('applying a Bézier preset reproduces its shape on any segment', () => {
    const frames = [K(1, 20), K(3, 220)]
    for (const id of ['easy_ease', 'quad_in', 'expo_out', 'circ_in_out']) {
      const out = applyPresetToSegment(frames, 0, preset(id), false)
      for (const x of [0.1, 0.3, 0.5, 0.8]) {
        expect(curveValueAt(out, 1 + 2 * x)).toBeCloseTo(20 + 200 * presetShape(preset(id), x), 6)
      }
    }
  })

  it('named presets set the ease', () => {
    const out = applyPresetToSegment([K(0, 0), K(1, 1)], 0, preset('bounce_out'), false)
    expect(out[0].ease).toBe('bounce_out')
  })

  it('saved presets round-trip', () => {
    const src = applyPresetToSegment([K(0, 0), K(2, 50)], 0, preset('back_out'), false)
    const saved = presetFromSegment(src, 0, false, 'mine')!
    const bez = applyPresetToSegment([K(0, 0), K(2, 50)], 0, preset('sine_in_out'), false)
    const savedBez = presetFromSegment(bez, 0, false, 'mine2')!
    expect(saved.ease).toBe('back_out')
    for (const x of [0.2, 0.6]) expect(presetShape(savedBez, x)).toBeCloseTo(presetShape(preset('sine_in_out'), x), 6)
  })
})

describe('easy ease (F9)', () => {
  it('flattens both sides of a key', () => {
    const out = easyEase([K(0, 0), K(1, 100), K(2, 0)], 1, 'both')
    // Slope ~0 right at the key on both sides.
    expect(curveValueAt(out, 0.98)).toBeGreaterThan(99)
    expect(curveValueAt(out, 1.02)).toBeGreaterThan(99)
  })
  it('in/out only touch one side', () => {
    const inOnly = easyEase([K(0, 0), K(1, 100), K(2, 0)], 1, 'in')
    expect(inOnly[1].ease).toBe('linear')
    expect(inOnly[0].ease).toBe('bezier')
  })
})

describe('handles', () => {
  it('aligned handles stay in line, free handles do not', () => {
    const frames = [K(0, 0, { ease: 'bezier' }), K(1, 10, { ease: 'bezier' }), K(2, 0)]
    const aligned = setHandle(frames, 1, 'out', [0.3, 6])
    const [dti, dvi] = aligned[1].hi!
    expect(dvi / dti).toBeCloseTo(6 / 0.3, 6)
    const free = setHandle(frames, 1, 'out', [0.3, 6], { breakTangent: true })
    expect(free[1].hm).toBe('free')
    expect(free[1].hi ?? null).toBeNull()
  })
  it('outgoing handles cannot point backwards in time', () => {
    const out = setHandle([K(0, 0), K(1, 1)], 0, 'out', [-0.5, 1])
    expect(out[0].ho![0]).toBe(0)
  })
  it('auto clamped keeps peaks flat (no overshoot)', () => {
    const frames = recalcAuto(
      [K(0, 0, { ease: 'bezier', hm: 'auto_clamped' }), K(1, 10, { ease: 'bezier', hm: 'auto_clamped' }), K(2, 0, { hm: 'auto_clamped' })],
      'x',
    )
    expect(frames[1].ho![1]).toBeCloseTo(0, 9)
    let max = 0
    for (let i = 0; i <= 100; i++) max = Math.max(max, curveValueAt(frames, (2 * i) / 100))
    expect(max).toBeLessThanOrEqual(10 + 1e-9)
  })
})

it('target segments', () => {
  expect(targetSegments(4, new Set([1]))).toEqual([1])
  expect(targetSegments(4, new Set([0, 1, 2]))).toEqual([0, 1])
  expect(targetSegments(4, new Set([3]))).toEqual([])
})
