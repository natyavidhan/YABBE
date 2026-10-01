/**
 * Effects: everything beyond a clip's built-in properties (timing, transform +
 * blend, audio volume / fades, markers - like Premiere's fixed effects).
 * Effects live in the Effects tab and are dragged (or added) onto clips; an
 * added effect's settings then appear in that clip's Properties.
 *
 * Each effect says which kinds of clip it works on. The settings an effect
 * uses are stored in the clip's own fields (crop, speed, chroma_key, ...);
 * `clip.effects` records which effects were added (and their order). Clips
 * from before effects existed get theirs inferred from those settings.
 *
 * Adding a new effect = one entry here + its section in the Properties panel.
 */
import { Brush, Crop, Gauge, Pipette, Scan, Vibrate } from 'lucide-react'
import type { Asset, Clip, ClipType } from '../api/types'
import { DEFAULT_KEY } from './ChromaKey'
import { DEFAULT_ROTO, useRoto } from './Roto'
import { addTracker, removeTracker } from './Tracking'
import { clipEnd, useEditor, type ClipPatch } from './store'

export const EFFECT_MIME = 'application/x-yabbe-effect'

export type EffectId = 'crop' | 'speed' | 'chroma_key' | 'roto' | 'tracking' | 'stabilize'

export interface EffectDef {
  id: EffectId
  name: string
  category: 'Picture' | 'Time' | 'Keying & masks' | 'Motion' | 'Audio'
  description: string
  icon: React.ReactNode
  /** Clip kinds it can go on. */
  targets: ClipType[]
  /** Extra condition (beyond the kind): why it can't be added, or null. */
  unavailable?: (clip: Clip, asset: Asset | undefined) => string | null
  /** The on / off switch, for effects that keep their settings while off. */
  toggle?: { get: (clip: Clip) => boolean; set: (clip: Clip, on: boolean) => ClipPatch }
  /** What adding / removing does to the clip (removing resets its settings). */
  add?: (clip: Clip, asset: Asset | undefined) => void
  remove?: (clip: Clip) => void
}

const set = (clip: Clip, patch: ClipPatch) => useEditor.getState().updateClip(clip.id, patch)
const notFreeze = (clip: Clip) => (clip.hold ? 'Not on freeze frames' : null)
const videoFile = (clip: Clip, asset: Asset | undefined) =>
  clip.hold ? 'Not on freeze frames' : asset?.kind !== 'video' ? 'Needs a video file' : null

export const EFFECTS: EffectDef[] = [
  {
    id: 'crop',
    name: 'Crop',
    category: 'Picture',
    description: 'Trim the edges of the picture.',
    icon: <Crop size={14} />,
    targets: ['video', 'image', 'sequence', 'text', 'shape'],
    toggle: {
      get: (c) => c.crop.enabled !== false,
      set: (c, on) => ({ crop: { ...c.crop, enabled: on } }),
    },
    remove: (c) => set(c, { crop: { left: 0, top: 0, right: 0, bottom: 0, enabled: true } }),
  },
  {
    id: 'speed',
    name: 'Speed',
    category: 'Time',
    description: 'Slow motion or fast forward, fit to a length.',
    icon: <Gauge size={14} />,
    targets: ['video', 'audio', 'sequence'],
    unavailable: notFreeze,
    remove: (c) => useEditor.getState().setClipSpeed(c.id, 1),
  },
  {
    id: 'chroma_key',
    name: 'Chroma key',
    category: 'Keying & masks',
    description: 'Remove a green or blue screen.',
    icon: <Pipette size={14} />,
    targets: ['video', 'image', 'sequence'],
    toggle: {
      get: (c) => !!c.chroma_key?.enabled,
      set: (c, on) => ({ chroma_key: { ...DEFAULT_KEY, ...c.chroma_key, enabled: on, matte: undefined } }),
    },
    add: (c) => set(c, { chroma_key: { ...DEFAULT_KEY, ...c.chroma_key, enabled: true } }),
    remove: (c) => set(c, { chroma_key: null }),
  },
  {
    id: 'roto',
    name: 'Roto brush',
    category: 'Keying & masks',
    description: 'Cut a person or any object out of the video (AI).',
    icon: <Brush size={14} />,
    targets: ['video'],
    unavailable: videoFile,
    toggle: {
      get: (c) => c.roto?.enabled !== false,
      set: (c, on) => ({ roto: { ...DEFAULT_ROTO, ...c.roto, enabled: on, matte: undefined } }),
    },
    add: (c) => {
      const s = useEditor.getState()
      if (s.playhead < c.start || s.playhead >= clipEnd(c)) s.setPlayhead(c.start)
      if (!c.roto) set(c, { roto: { ...DEFAULT_ROTO, start: c.in_point, end: c.in_point + c.duration * c.speed } })
      useRoto.setState({ editing: c.id })
    },
    remove: (c) => {
      useRoto.setState((r) => ({ editing: r.editing === c.id ? null : r.editing, matte: r.matte === c.id ? null : r.matte }))
      set(c, { roto: null })
    },
  },
  {
    id: 'tracking',
    name: 'Motion tracking',
    category: 'Motion',
    description: 'Follow a spot or surface, then attach or pin other clips to it.',
    icon: <Scan size={14} />,
    targets: ['video'],
    unavailable: videoFile,
    remove: (c) => (c.trackers ?? []).filter((t) => t.kind !== 'stabilize').forEach((t) => removeTracker(c.id, t.id)),
  },
  {
    id: 'stabilize',
    name: 'Stabilize',
    category: 'Motion',
    description: 'Remove camera shake: smooth the move or lock the shot.',
    icon: <Vibrate size={14} />,
    targets: ['video'],
    unavailable: videoFile,
    toggle: {
      get: (c) => c.stabilize?.enabled !== false,
      set: (c, on) => (c.stabilize ? { stabilize: { ...c.stabilize, enabled: on } } : {}),
    },
    add: (c, asset) => {
      if (asset && !(c.trackers ?? []).some((t) => t.kind === 'stabilize')) addTracker(c, asset, 'stabilize')
    },
    remove: (c) => {
      ;(c.trackers ?? []).filter((t) => t.kind === 'stabilize').forEach((t) => removeTracker(c.id, t.id))
      set(c, { stabilize: null })
    },
  },
]

export const effectDef = (id: string) => EFFECTS.find((e) => e.id === id)

const KIND_NAMES: Record<ClipType, string> = {
  video: 'video', image: 'photo', audio: 'audio', text: 'text', shape: 'shape', sequence: 'nested sequence',
}
export const kindName = (t: ClipType) => KIND_NAMES[t]

/** Why an effect can't go on a clip (null = it can). */
export function cannotAdd(def: EffectDef, clip: Clip, asset: Asset | undefined): string | null {
  if (!def.targets.includes(clip.type)) return `${def.name} doesn’t work on ${kindName(clip.type)} clips`
  if (effectsOf(clip).includes(def.id)) return `${def.name} is already on this clip`
  return def.unavailable?.(clip, asset) ?? null
}

/** The effects on a clip: as recorded, or inferred from its settings (older projects). */
export function effectsOf(clip: Clip): EffectId[] {
  if (clip.effects) return clip.effects.filter((id): id is EffectId => !!effectDef(id))
  const out: EffectId[] = []
  const c = clip.crop
  if (c.left || c.top || c.right || c.bottom) out.push('crop')
  if (Math.abs(clip.speed - 1) > 1e-6) out.push('speed')
  if (clip.chroma_key) out.push('chroma_key')
  if (clip.roto) out.push('roto')
  if ((clip.trackers ?? []).some((t) => t.kind !== 'stabilize')) out.push('tracking')
  if (clip.stabilize || (clip.trackers ?? []).some((t) => t.kind === 'stabilize')) out.push('stabilize')
  return out
}

// -- actions (one undo step each) ---------------------------------------------------------

function clipAndAsset(clipId: string) {
  const s = useEditor.getState()
  const clip = s.doc.clips.find((c) => c.id === clipId)
  const asset = clip?.asset_id ? s.assets.find((a) => a.id === clip.asset_id) : undefined
  return { s, clip, asset }
}

/** Add an effect to a clip. Returns why it couldn't be added, or null. */
export function addEffect(clipId: string, id: EffectId): string | null {
  const { s, clip, asset } = clipAndAsset(clipId)
  const def = effectDef(id)
  if (!clip || !def) return 'Clip not found'
  if (s.doc.tracks.find((t) => t.id === clip.track_id)?.locked) return 'The clip is on a locked track'
  const why = cannotAdd(def, clip, asset)
  if (why) return why
  s.beginGesture()
  s.updateClip(clip.id, { effects: [...effectsOf(clip), id] })
  const fresh = useEditor.getState().doc.clips.find((c) => c.id === clipId)!
  def.add?.(fresh, asset)
  s.endGesture()
  return null
}

/** Remove an effect (its settings are reset). */
export function removeEffect(clipId: string, id: EffectId): void {
  const { s, clip } = clipAndAsset(clipId)
  const def = effectDef(id)
  if (!clip || !def) return
  s.beginGesture()
  def.remove?.(clip)
  const fresh = useEditor.getState().doc.clips.find((c) => c.id === clipId)
  if (fresh) s.updateClip(clipId, { effects: effectsOf(fresh).filter((e) => e !== id) })
  s.endGesture()
}

export function setEffectEnabled(clipId: string, id: EffectId, on: boolean): void {
  const { s, clip } = clipAndAsset(clipId)
  const def = effectDef(id)
  if (!clip || !def?.toggle) return
  s.updateClip(clipId, { ...def.toggle.set(clip, on), effects: effectsOf(clip) })
}

/** Add to several clips (those it fits); returns a message about the rest, or null. */
export function addEffectToClips(clipIds: string[], id: EffectId): string | null {
  const def = effectDef(id)!
  const problems = clipIds.map((cid) => addEffect(cid, id)).filter((r): r is string => !!r)
  if (!problems.length) return null
  if (problems.length === clipIds.length) return problems[0]
  return `${def.name} was added to ${clipIds.length - problems.length} of ${clipIds.length} clips (${problems[0].toLowerCase()})`
}
