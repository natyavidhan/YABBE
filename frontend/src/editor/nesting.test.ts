import { describe, expect, it } from 'vitest'
import type { Clip, Track } from '../api/types'
import { nestClips, unnestBlocker, unnestClip } from './nesting'
import { allSequences, type Doc } from './store'

const track = (id: string, kind: Track['kind'] = 'video'): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false })
const clip = (id: string, track_id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  asset_id: 'a1',
  type: 'video',
  track_id,
  start,
  duration,
  in_point: 0,
  speed: 1,
  volume: 1,
  muted: false,
  fade_in: 0,
  fade_out: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  text: null,
  keyframes: {},
  markers: [],
  transition: null,
  ...extra,
})

function doc(): Doc {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  const tracks = [track('v2'), track('v1'), track('a1', 'audio')]
  const clips = [
    clip('title', 'v2', 3, 2, { type: 'text', asset_id: null }),
    clip('shot1', 'v1', 2, 3, { transition: { kind: 'fade', duration: 0.5, audio: true } }),
    clip('shot2', 'v1', 5, 2),
    clip('music', 'a1', 0, 10, { type: 'audio' }),
  ]
  return {
    name: 'p',
    settings,
    tracks,
    clips,
    active: 's_main',
    main: 's_main',
    sequences: [{ id: 's_main', name: 'Main', settings, tracks, clips }],
  }
}

describe('nest / un-nest', () => {
  it('pre-composes clips keeping timing, layering and inner transitions', () => {
    const r = nestClips(doc(), ['title', 'shot1', 'shot2'])
    if (typeof r === 'string') throw new Error(r)
    const seq = allSequences(r.doc).find((s) => s.id === r.sequenceId)!
    expect(seq.name).toBe('Nested sequence 1')
    expect(seq.tracks.map((t) => t.kind)).toEqual(['video', 'video', 'audio'])
    const byType = Object.fromEntries(seq.clips.map((c) => [c.type + c.start, c]))
    expect(Object.keys(byType).sort()).toEqual(['text1', 'video0', 'video3'])
    expect(byType.text1.track_id).toBe(seq.tracks[0].id) // still above the shots
    expect(byType.video0.transition?.kind).toBe('fade') // both sides moved
    const nested = r.doc.clips.find((c) => c.id === r.clipId)!
    expect(nested).toMatchObject({ type: 'sequence', start: 2, duration: 5, track_id: 'v1' })
    expect(r.doc.clips.map((c) => c.id)).toContain('music')
    expect(r.doc.clips).toHaveLength(2)
  })

  it('drops transitions to clips left behind and avoids busy tracks', () => {
    const r = nestClips(doc(), ['shot1'])
    if (typeof r === 'string') throw new Error(r)
    const seq = allSequences(r.doc).find((s) => s.id === r.sequenceId)!
    expect(seq.clips[0].transition).toBeNull()
    expect(r.doc.clips.find((c) => c.id === r.clipId)!.track_id).toBe('v1')
    // title + shot2 span 3..7, but shot1 (left on v1) is in the way until 5:
    const r2 = nestClips(doc(), ['title', 'shot2'])
    if (typeof r2 === 'string') throw new Error(r2)
    const t = r2.doc.clips.find((c) => c.id === r2.clipId)!.track_id
    expect(t).not.toBe('v1')
    expect(r2.doc.tracks.map((x) => x.id).indexOf(t)).toBe(1) // a new track right above v1
  })

  it('un-nests back to the same clips', () => {
    const r = nestClips(doc(), ['title', 'shot1', 'shot2'])
    if (typeof r === 'string') throw new Error(r)
    const u = unnestClip(r.doc, r.clipId)
    if (typeof u === 'string') throw new Error(u)
    const got = u.doc.clips
      .filter((c) => c.id !== 'music')
      .map((c) => [c.type, c.start, c.duration, c.track_id])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
    expect(got).toEqual([
      ['video', 2, 3, 'v1'],
      ['text', 3, 2, 'v2'],
      ['video', 5, 2, 'v1'],
    ])
    expect(u.doc.tracks).toHaveLength(3) // reused the free tracks
  })

  it('un-nests only the trimmed part and refuses changed clips', () => {
    const r = nestClips(doc(), ['shot1', 'shot2'])
    if (typeof r === 'string') throw new Error(r)
    // trim the nested clip to child time 1..4 (shot1 1..3, shot2 3..4), placed at 10
    const d = { ...r.doc, clips: r.doc.clips.map((c) => (c.id === r.clipId ? { ...c, start: 10, in_point: 1, duration: 3 } : c)) }
    const u = unnestClip(d, r.clipId)
    if (typeof u === 'string') throw new Error(u)
    const got = u.doc.clips.filter((c) => c.type === 'video').map((c) => [c.start, c.duration, c.in_point])
    expect(got).toEqual([
      [10, 2, 1],
      [12, 1, 0],
    ])
    const scaled = { ...d, clips: d.clips.map((c) => (c.id === r.clipId ? { ...c, transform: { ...c.transform, scale: 0.5 } } : c)) }
    expect(unnestBlocker(scaled, scaled.clips.find((c) => c.id === r.clipId)!)).toMatch(/transform/)
  })
})
