import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../api/types'
import { addEffect, cannotAdd, effectDef, effectsOf, removeEffect, setEffectEnabled } from './effects'
import { useEditor } from './store'

const base = {
  in_point: 0, speed: 1, volume: 1, muted: false, fade_in: 0, fade_out: 0, text: null, markers: [], transition: null,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, keyframes: {},
}

function project(): Project {
  const settings = { width: 1920, height: 1080, fps: 30, background: '#000000' }
  const tracks = [
    { id: 'v1', kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
    { id: 'a1', kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
  ]
  const clips = [
    { ...base, id: 'vid', track_id: 'v1', type: 'video', asset_id: 'av', start: 0, duration: 4 },
    { ...base, id: 'aud', track_id: 'a1', type: 'audio', asset_id: 'aa', start: 0, duration: 4 },
    // made before effects existed: has a crop and a speed change
    { ...base, id: 'old', track_id: 'v1', type: 'video', asset_id: 'av', start: 5, duration: 2, speed: 2, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } },
  ]
  return {
    id: 'p', name: 'p', created_at: 0, updated_at: 0, main_sequence_id: 's',
    assets: [
      { id: 'av', kind: 'video', has_video: true, has_audio: true, duration: 20, width: 1920, height: 1080, status: 'ready' },
      { id: 'aa', kind: 'audio', has_audio: true, duration: 20, status: 'ready' },
    ],
    sequences: [{ id: 's', name: 'Main', settings, tracks, clips }],
  } as unknown as Project
}

const clip = (id: string) => useEditor.getState().doc.clips.find((c) => c.id === id)!

describe('effects', () => {
  beforeEach(() => useEditor.getState().load(project()))

  it('knows which clips each effect fits', () => {
    expect(cannotAdd(effectDef('chroma_key')!, clip('aud'), undefined)).toMatch(/doesn’t work on audio/)
    expect(cannotAdd(effectDef('speed')!, clip('aud'), undefined)).toBeNull()
    expect(cannotAdd(effectDef('chroma_key')!, clip('vid'), undefined)).toBeNull()
  })

  it('infers the effects of clips made before effects existed', () => {
    expect(effectsOf(clip('old'))).toEqual(['crop', 'speed'])
    expect(effectsOf(clip('vid'))).toEqual([])
  })

  it('adds, switches off and removes effects (one undo step each)', () => {
    expect(addEffect('vid', 'chroma_key')).toBeNull()
    expect(effectsOf(clip('vid'))).toEqual(['chroma_key'])
    expect(clip('vid').chroma_key?.enabled).toBe(true)
    expect(addEffect('vid', 'chroma_key')).toMatch(/already/)
    expect(addEffect('aud', 'chroma_key')).toMatch(/audio/)

    setEffectEnabled('vid', 'chroma_key', false)
    expect(clip('vid').chroma_key?.enabled).toBe(false) // settings kept, switched off
    expect(effectsOf(clip('vid'))).toEqual(['chroma_key'])

    removeEffect('vid', 'chroma_key')
    expect(effectsOf(clip('vid'))).toEqual([])
    expect(clip('vid').chroma_key).toBeNull()

    useEditor.getState().undo()
    expect(effectsOf(clip('vid'))).toEqual(['chroma_key']) // the removal undoes in one step

    removeEffect('old', 'speed')
    expect(clip('old').speed).toBe(1)
    expect(effectsOf(clip('old'))).toEqual(['crop'])
  })
})
