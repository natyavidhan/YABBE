import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Asset, Project } from '../api/types'
import { addLyricsClip, DEFAULT_LYRICS_STYLE, lyricsClipsOf, presetStyle, removeLyricsClips, setLyricsOn, songTime, timelineTime } from './lyrics'
import { useEditor } from './store'

vi.mock('../api/client', () => ({
  api: {
    computeLyrics: vi.fn(() => new Promise(() => {})), // never finishes in these tests
    cancelJob: vi.fn(() => Promise.resolve({ ok: true })),
  },
}))

const song = { id: 'a1', kind: 'audio', has_audio: true, has_video: false, duration: 200, status: 'ready' } as Asset

function project(): Project {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  const tracks = [
    { id: 'v1', kind: 'video' as const, name: 'Video 1', muted: false, hidden: false, locked: false },
    { id: 'au', kind: 'audio' as const, name: 'Audio 1', muted: false, hidden: false, locked: false },
  ]
  const base = {
    muted: false, volume: 1, fade_in: 0, fade_out: 0, keyframes: {},
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
    crop: { left: 0, top: 0, right: 0, bottom: 0 }, text: null, markers: [], transition: null,
  }
  const clips = [
    { ...base, id: 'music', type: 'audio' as const, track_id: 'au', asset_id: 'a1', start: 2, duration: 30, in_point: 10, speed: 1 },
    // Video 1 is busy where the song plays: lyrics go on a new track
    { ...base, id: 'v', type: 'image' as const, track_id: 'v1', asset_id: 'x', start: 0, duration: 10, in_point: 0, speed: 1 },
  ]
  return {
    id: 'p', name: 'p', created_at: 0, updated_at: 0, assets: [song], main_sequence_id: 's',
    sequences: [{ id: 's', name: 'Main', settings, tracks, clips }],
  } as unknown as Project
}

describe('lyrics clips', () => {
  beforeEach(() => useEditor.getState().load(project()))

  it('adds a lyrics clip linked to the song, mirroring its timing', () => {
    const doc = useEditor.getState().doc
    const music = doc.clips.find((c) => c.id === 'music')!
    const r = addLyricsClip(doc, music)
    const lyr = r.doc.clips.find((c) => c.id === r.clipId)!
    expect(lyr.type).toBe('lyrics')
    expect([lyr.start, lyr.duration, lyr.in_point, lyr.speed, lyr.asset_id]).toEqual([2, 30, 10, 1, 'a1'])
    const linkedSong = r.doc.clips.find((c) => c.id === 'music')!
    expect(lyr.link).toBeTruthy()
    expect(linkedSong.link).toBe(lyr.link)
    // a new video track at the top, named for it
    expect(r.doc.tracks[0].name).toBe('Lyrics')
    expect(lyr.track_id).toBe(r.doc.tracks[0].id)
    expect(lyricsClipsOf(r.doc, linkedSong).map((c) => c.id)).toEqual([r.clipId])
    expect(removeLyricsClips(r.doc, linkedSong).clips.some((c) => c.type === 'lyrics')).toBe(false)
  })

  it('turns on and off from the song clip as one undo step each', () => {
    const s = useEditor.getState()
    expect(setLyricsOn('music', true)).toBeNull()
    let doc = useEditor.getState().doc
    expect(doc.clips.filter((c) => c.type === 'lyrics')).toHaveLength(1)
    setLyricsOn('music', true) // already on: nothing more
    expect(useEditor.getState().doc.clips.filter((c) => c.type === 'lyrics')).toHaveLength(1)
    setLyricsOn('music', false)
    doc = useEditor.getState().doc
    expect(doc.clips.filter((c) => c.type === 'lyrics')).toHaveLength(0)
    s.undo()
    expect(useEditor.getState().doc.clips.filter((c) => c.type === 'lyrics')).toHaveLength(1)
  })

  it('maps song time and timeline time', () => {
    const clip = { start: 5, in_point: 20, speed: 2 } as Parameters<typeof songTime>[0]
    expect(songTime(clip, 7)).toBe(24)
    expect(timelineTime(clip, 24)).toBe(7)
  })

  it('presets keep the timing settings', () => {
    const mine = { ...DEFAULT_LYRICS_STYLE, offset_ms: 400, lead_ms: 100, hold_ms: 900, size: 33 }
    const pop = presetStyle('pop', mine)
    expect(pop.layout).toBe('words')
    expect(pop.preset).toBe('pop')
    expect([pop.offset_ms, pop.lead_ms, pop.hold_ms]).toEqual([400, 100, 900])
    expect(pop.size).toBe(130)
  })
})
