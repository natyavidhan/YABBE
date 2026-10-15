import { describe, expect, it } from 'vitest'
import type { Clip, Sequence } from '../api/types'
import { mergeTimelines, type TimelineState } from './merge'

const clip = (id: string, start: number, extra: Partial<Clip> = {}) => ({ id, track_id: 'v1', start, duration: 2, ...extra }) as Clip
const seq = (clips: Clip[], extra: Partial<Sequence> = {}): Sequence =>
  ({ id: 's', name: 'Main', settings: { width: 1920, height: 1080, fps: 30, background: '#000' }, tracks: [{ id: 'v1' }], clips, ...extra }) as Sequence
const state = (s: Sequence[], name = 'P'): TimelineState => ({ name, main: 's', sequences: s })

describe('merging edits made at the same time', () => {
  const base = state([seq([clip('a', 0), clip('b', 2), clip('c', 4)])])

  it('keeps both sides’ changes', () => {
    // here: delete b, move c; there (AI): add d, change a
    const local = state([seq([clip('a', 0), clip('c', 5)])])
    const remote = state([seq([clip('a', 0, { volume: 0.5 }), clip('b', 2), clip('c', 4), clip('d', 8)])])
    const m = mergeTimelines(base, local, remote)
    expect(m.sequences[0].clips.map((c) => [c.id, c.start, c.volume])).toEqual([
      ['a', 0, 0.5],
      ['c', 5, undefined],
      ['d', 8, undefined],
    ])
  })

  it('ours wins on the same clip; theirs deletes untouched clips; added here survives', () => {
    const local = state([seq([clip('a', 1), clip('b', 2), clip('c', 4), clip('n', 10)])], 'Renamed')
    const remote = state([seq([clip('a', 3), clip('c', 4)])])
    const m = mergeTimelines(base, local, remote)
    expect(m.name).toBe('Renamed')
    expect(m.sequences[0].clips.map((c) => [c.id, c.start])).toEqual([
      ['a', 1],
      ['c', 4],
      ['n', 10],
    ])
  })

  it('merges sequences added on both sides', () => {
    const other = seq([], { id: 's2', name: 'Vertical' })
    const mine = seq([], { id: 's3', name: 'Mine' })
    const m = mergeTimelines(base, state([...base.sequences, mine]), state([...base.sequences, other]))
    expect(m.sequences.map((s) => s.id).sort()).toEqual(['s', 's2', 's3'])
  })
})
