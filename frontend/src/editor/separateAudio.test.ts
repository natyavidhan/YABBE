import { beforeEach, describe, expect, it } from 'vitest'
import type { Asset, Project } from '../api/types'
import { useEditor } from './store'

const asset = { id: 'a1', kind: 'video', has_audio: true, has_video: true, duration: 10, status: 'ready' } as Asset

function project(): Project {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  const tracks = [
    { id: 'v1', kind: 'video' as const, name: 'Video 1', muted: false, hidden: false, locked: false },
    { id: 'au', kind: 'audio' as const, name: 'Audio 1', muted: false, hidden: false, locked: false },
  ]
  const base = {
    track_id: 'v1', asset_id: 'a1', type: 'video' as const, in_point: 1, speed: 2, muted: false,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
    crop: { left: 0, top: 0, right: 0, bottom: 0 }, text: null, markers: [], transition: null,
  }
  const clips = [
    { ...base, id: 'c1', start: 2, duration: 3, volume: 0.5, fade_in: 0.5, fade_out: 0, keyframes: { volume: [{ t: 0, v: 1 }], x: [{ t: 0, v: 10 }] } },
    // something already on Audio 1 where c1 is, so a new audio track is needed
    { ...base, id: 'other', type: 'audio' as const, track_id: 'au', start: 0, duration: 4, volume: 1, fade_in: 0, fade_out: 0, keyframes: {} },
  ]
  return {
    id: 'p', name: 'p', created_at: 0, updated_at: 0, assets: [asset], main_sequence_id: 's',
    sequences: [{ id: 's', name: 'Main', settings, tracks, clips }],
  } as unknown as Project
}

describe('separate audio', () => {
  beforeEach(() => useEditor.getState().load(project()))

  it('moves the sound to a linked audio clip and restores it', () => {
    const s = useEditor.getState()
    s.select(['c1'])
    expect(s.separateAudio()).toBeNull()
    let d = useEditor.getState().doc
    const video = d.clips.find((c) => c.id === 'c1')!
    const audio = d.clips.find((c) => c.type === 'audio' && c.id !== 'other')!
    expect(video).toMatchObject({ audio_detached: true, volume: 1, fade_in: 0 })
    expect(video.keyframes.volume).toBeUndefined()
    expect(video.keyframes.x).toHaveLength(1)
    expect(audio).toMatchObject({ asset_id: 'a1', start: 2, duration: 3, in_point: 1, speed: 2, volume: 0.5, fade_in: 0.5 })
    expect(audio.keyframes.volume).toHaveLength(1)
    expect(audio.link).toBe(video.link)
    expect(audio.track_id).not.toBe('au') // Audio 1 was busy: a new track
    expect(d.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)

    // Nothing left to separate.
    useEditor.getState().select(['c1'])
    expect(useEditor.getState().separateAudio()).toMatch(/has sound/)

    useEditor.getState().restoreAudio('c1')
    d = useEditor.getState().doc
    expect(d.clips.filter((c) => c.type === 'audio')).toHaveLength(1)
    expect(d.clips.find((c) => c.id === 'c1')).toMatchObject({ audio_detached: false, volume: 0.5, fade_in: 0.5, link: null })
  })
})
