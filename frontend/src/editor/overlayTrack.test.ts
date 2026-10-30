import { describe, expect, it } from 'vitest'
import type { Clip, Track } from '../api/types'
import { overlayTrack, type Doc } from './store'

const track = (id: string, kind: 'video' | 'audio' = 'video', locked = false): Track => ({ id, kind, name: id, muted: false, hidden: false, locked })
const clip = (track_id: string, start: number, duration: number) => ({ id: `${track_id}@${start}`, track_id, start, duration }) as Clip

function doc(tracks: Track[], clips: Clip[]): Doc {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  return { name: 'p', settings, tracks, clips, active: 's', main: 's', sequences: [{ id: 's', name: 'Main', settings, tracks, clips }] }
}

describe('where new text and shapes go', () => {
  // Tracks are listed top first.
  const tracks = [track('v3'), track('v2'), track('v1'), track('a1', 'audio')]

  it('sits just above what is showing at the playhead', () => {
    const r = overlayTrack(doc(tracks, [clip('v1', 0, 10)]), 2, 5)
    expect(r.track.id).toBe('v2')
    expect(r.tracks).toBe(tracks)
  })

  it('never goes under something showing at that time', () => {
    // v3 is free, v2 is busy, v1 is free: only v3 is above everything
    const r = overlayTrack(doc(tracks, [clip('v2', 1, 3), clip('v1', 0, 10)]), 2, 5)
    expect(r.track.id).toBe('v3')
  })

  it('adds a track on top when the top one is taken', () => {
    const r = overlayTrack(doc(tracks, [clip('v3', 6, 2)]), 2, 5)
    expect(r.tracks[0]).toBe(r.track)
    expect(r.track).toMatchObject({ kind: 'video', name: 'Video 4' })
  })

  it('uses the top track when nothing is showing, skipping locked ones', () => {
    expect(overlayTrack(doc(tracks, []), 2, 5).track.id).toBe('v3')
    expect(overlayTrack(doc([track('v3', 'video', true), ...tracks.slice(1)], []), 2, 5).track.id).toBe('v2')
  })
})
