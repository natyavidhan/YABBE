// Store-level graph operations shared by the graph editor and global shortcuts.
import type { AnimProp, Clip, Ease, Keyframe } from '../../api/types'
import { framesOf, isColorProp, keyIndexAt, localTime } from '../keyframes'
import { useEditor } from '../store'
import { applyPresetToSegment, easyEase, targetSegments, type CurvePreset } from './model'

export function selectedClip(): Clip | undefined {
  const s = useEditor.getState()
  return s.selection.length === 1 ? s.doc.clips.find((c) => c.id === s.selection[0]) : undefined
}

export function isGraphVisible(clipId: string, prop: AnimProp): boolean {
  return !useEditor.getState().graphHidden[`${clipId}:${prop}`]
}

/** Animated properties of a clip, in a stable display order. */
export function animatedProps(clip: Clip): AnimProp[] {
  const order: AnimProp[] = [
    'x', 'y', 'scale', 'rotation', 'opacity', 'volume',
    'text_size', 'text_stroke_width', 'text_padding', 'text_line_spacing',
    'text_color', 'text_stroke_color', 'text_background',
  ]
  return order.filter((p) => framesOf(clip, p))
}

/**
 * Keys to act on: the graph selection, or (when nothing is selected) the keys
 * under the playhead on every visible animated property of the selected clip.
 */
export function actionKeys(clip: Clip): Map<AnimProp, Set<number>> {
  const s = useEditor.getState()
  const out = new Map<AnimProp, Set<number>>()
  if (s.graphSel.length) {
    for (const k of s.graphSel) {
      if (!framesOf(clip, k.prop)?.[k.i]) continue
      if (!out.has(k.prop)) out.set(k.prop, new Set())
      out.get(k.prop)!.add(k.i)
    }
    return out
  }
  const fps = s.doc.settings.fps
  const u = localTime(clip, s.playhead, fps)
  for (const prop of animatedProps(clip)) {
    if (!isGraphVisible(clip.id, prop) && s.graphOpen) continue
    const i = keyIndexAt(framesOf(clip, prop), u, fps)
    if (i >= 0) out.set(prop, new Set([i]))
  }
  return out
}

/** Segments to act on for presets: from the selection, else the segment under the playhead. */
function actionSegments(clip: Clip): Map<AnimProp, number[]> {
  const s = useEditor.getState()
  const out = new Map<AnimProp, number[]>()
  if (s.graphSel.length) {
    for (const [prop, set] of actionKeys(clip)) {
      const segs = targetSegments(framesOf(clip, prop)!.length, set)
      if (segs.length) out.set(prop, segs)
    }
    return out
  }
  const u = s.playhead - clip.start
  for (const prop of animatedProps(clip)) {
    if (!isGraphVisible(clip.id, prop) && s.graphOpen) continue
    const f = framesOf(clip, prop)!
    const i = f.findIndex((k, j) => f[j + 1] && k.t <= u && u < f[j + 1].t)
    if (i >= 0) out.set(prop, [i])
  }
  return out
}

function update(clip: Clip, prop: AnimProp, fn: (f: Keyframe[]) => Keyframe[]) {
  useEditor.getState().setKeyframes(clip.id, prop, fn(framesOf(clip, prop)!))
}

/** F9 / Shift+F9 / Ctrl+Shift+F9. Returns false when there was nothing to ease. */
export function runEasyEase(side: 'both' | 'in' | 'out'): boolean {
  const clip = selectedClip()
  if (!clip) return false
  const keys = actionKeys(clip)
  if (!keys.size) return false
  const s = useEditor.getState()
  s.beginGesture()
  for (const [prop, set] of keys) {
    update(selectedClip()!, prop, (f) => [...set].reduce((acc, i) => easyEase(acc, i, side), f))
  }
  s.endGesture()
  return true
}

export function runPreset(preset: CurvePreset): boolean {
  const clip = selectedClip()
  if (!clip) return false
  const segs = actionSegments(clip)
  if (!segs.size) return false
  const s = useEditor.getState()
  s.beginGesture()
  for (const [prop, list] of segs) {
    update(selectedClip()!, prop, (f) => list.reduce((acc, i) => applyPresetToSegment(acc, i, preset, isColorProp(prop)), f))
  }
  s.endGesture()
  return true
}

/** Set the outgoing ease (and params) of the selected keys. */
export function setEase(ease: Ease, ep?: number[] | null) {
  const clip = selectedClip()
  if (!clip) return
  const s = useEditor.getState()
  s.beginGesture()
  for (const [prop, set] of actionKeys(clip)) {
    update(selectedClip()!, prop, (f) => f.map((k, i) => (set.has(i) && f[i + 1] ? { ...k, ease, ep: ep ?? k.ep } : k)))
  }
  s.endGesture()
}

export function deleteSelectedKeys() {
  const clip = selectedClip()
  const s = useEditor.getState()
  if (!clip || !s.graphSel.length) return
  s.beginGesture()
  for (const [prop, set] of actionKeys(clip)) update(selectedClip()!, prop, (f) => f.filter((_, i) => !set.has(i)))
  s.endGesture()
  s.setGraphSel([])
}

// -- saved (custom) presets, per browser -----------------------------------------------

const SAVED_KEY = 'yabbe.curvePresets'

export function loadSavedPresets(): CurvePreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function storeSavedPresets(list: CurvePreset[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

// -- copy / paste ----------------------------------------------------------------------------

interface Clipboard {
  /** Keys per property with times relative to the earliest copied key. */
  props: Partial<Record<AnimProp, Keyframe[]>>
}
let clipboard: Clipboard | null = null

export function copySelectedKeys(): number {
  const clip = selectedClip()
  if (!clip) return 0
  const keys = actionKeys(clip)
  let t0 = Infinity
  for (const [prop, set] of keys) for (const i of set) t0 = Math.min(t0, framesOf(clip, prop)![i].t)
  const props: Clipboard['props'] = {}
  let n = 0
  for (const [prop, set] of keys) {
    props[prop] = [...set].sort((a, b) => a - b).map((i) => ({ ...framesOf(clip, prop)![i], t: framesOf(clip, prop)![i].t - t0 }))
    n += set.size
  }
  clipboard = n ? { props } : null
  return n
}

/** Paste at the playhead onto the selected clip (same properties). */
export function pasteKeys(): number {
  const clip = selectedClip()
  if (!clip || !clipboard) return 0
  const s = useEditor.getState()
  const fps = s.doc.settings.fps
  const at = Math.round((s.playhead - clip.start) * fps) / fps
  let n = 0
  s.beginGesture()
  const sel: { prop: AnimProp; i: number }[] = []
  for (const [prop, keys] of Object.entries(clipboard.props) as [AnimProp, Keyframe[]][]) {
    if (clip.type !== 'text' && prop.startsWith('text_')) continue
    if (clip.type === 'audio' && prop !== 'volume') continue
    const cur = selectedClip()!
    const existing = framesOf(cur, prop) ?? []
    const pasted = keys.map((k) => ({ ...k, t: at + k.t }))
    const merged = [
      ...existing.filter((e) => !pasted.some((p) => Math.abs(p.t - e.t) < 0.5 / fps)),
      ...pasted,
    ].sort((a, b) => a.t - b.t)
    s.setKeyframes(cur.id, prop, merged)
    for (const p of pasted) sel.push({ prop, i: merged.indexOf(p) })
    n += pasted.length
  }
  s.endGesture()
  s.setGraphSel(sel.filter((k) => k.i >= 0))
  return n
}
