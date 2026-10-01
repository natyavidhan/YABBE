import { describe, expect, it } from 'vitest'
import type { Clip } from '../api/types'
import { freezeFrame, freezeTarget } from './freeze'
import type { Doc } from './store'

const base = (id: string, extra: Partial<Clip>): Clip => ({
  id, track_id: 'v1', type: 'video', asset_id: 'a1', start: 0, duration: 4, in_point: 1, speed: 2, volume: 1,
  muted: false, fade_in: 0.5, fade_out: 0.5, text: null, markers: [], transition: null,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, keyframes: {}, ...extra,
})

function doc(): Doc {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  const tracks = [
    { id: 'v1', kind: 'video' as const, name: 'V1', muted: false, hidden: false, locked: false },
    { id: 'v2', kind: 'video' as const, name: 'V2', muted: false, hidden: false, locked: false },
    { id: 'a1', kind: 'audio' as const, name: 'A1', muted: false, hidden: false, locked: false },
  ]
  const clips = [
    base('vid', { link: 'L', keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 4, v: 400, ease: 'linear' }] } }),
    base('aud', { type: 'audio', track_id: 'a1', link: 'L' }),
    base('after', { start: 5, duration: 1 }), // later on the same track: moves
    base('other', { track_id: 'v2', start: 3, duration: 2 }), // another track: stays
  ]
  return { name: 'p', settings, tracks, clips, active: 's', main: 's', sequences: [{ id: 's', name: 'Main', settings, tracks, clips }] }
}

describe('freeze frame', () => {
  it('splits, inserts the still and makes room', () => {
    const d = doc()
    const target = freezeTarget(d, [], 1.5)
    if (typeof target === 'string') throw new Error(target)
    expect(target.sourceT).toBe(1 + 1.5 * 2) // the frame to save as a photo
    const r = freezeFrame(d, target, 'img', 2)
    const c = (id: string) => r.doc.clips.find((x) => x.id === id)!
    const still = c(r.clipId)
    expect(still).toMatchObject({ type: 'image', asset_id: 'img', start: 1.5, duration: 2, link: null, track_id: 'v1' })
    expect(still.transform.x).toBeCloseTo(150) // keyframed x at that moment, baked in
    expect(still.keyframes).toEqual({})
    expect(c('vid')).toMatchObject({ start: 0, duration: 1.5, fade_out: 0 })
    const right = r.doc.clips.filter((x) => x.type === 'video' && x.track_id === 'v1' && x.start === 3.5)
    expect(right).toHaveLength(1)
    expect(right[0]).toMatchObject({ duration: 2.5, in_point: 4, fade_in: 0 })
    expect(right[0].keyframes.x?.[0].t).toBeCloseTo(-1.5)
    expect(c('after').start).toBe(7)
    expect(c('other').start).toBe(3)
    // the linked (separated) audio is split and moved the same way, leaving a silent gap
    expect(c('aud')).toMatchObject({ start: 0, duration: 1.5 })
    const audRight = r.doc.clips.filter((x) => x.type === 'audio' && x.start === 3.5)
    expect(audRight).toHaveLength(1)
    expect(audRight[0].link).toBe(right[0].link)
    expect(audRight[0].link).not.toBe('L')
  })

  it('needs a video under the playhead', () => {
    expect(freezeTarget(doc(), [], 6.5)).toMatch(/video clip/) // nothing playing at 6.5 s
  })
})
