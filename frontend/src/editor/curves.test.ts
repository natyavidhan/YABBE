// The browser's curve maths must equal the server's (which renders exports).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Keyframe } from '../api/types'
import { curveValueAt } from './curves'
import { colorAt } from './keyframes'

const fixture = JSON.parse(
  readFileSync(new URL('../../../backend/tests/fixtures/curves.json', import.meta.url), 'utf8'),
) as {
  numeric: { name: string; frames: Partial<Keyframe>[]; samples: [number, number][] }[]
  color: { frames: Partial<Keyframe>[]; samples: [number, string][] }
}

const withDefaults = (f: Partial<Keyframe>): Keyframe => ({ t: 0, v: 0, ease: 'linear', ...f }) as Keyframe

describe('curve parity with backend/tests/fixtures/curves.json', () => {
  for (const c of fixture.numeric) {
    it(c.name, () => {
      const frames = c.frames.map(withDefaults)
      for (const [u, expected] of c.samples) expect(curveValueAt(frames, u)).toBeCloseTo(expected, 7)
    })
  }
  it('colours', () => {
    const frames = fixture.color.frames.map(withDefaults)
    for (const [u, expected] of fixture.color.samples) expect(colorAt(frames, u)).toBe(expected)
  })
})
