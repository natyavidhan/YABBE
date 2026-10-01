import { create } from 'zustand'
import type { AnimProp, Asset, Clip, ClipType, Ease, Keyframe, Marker, Sequence, Transition, Project, ProjectSettings, ShapeKind, ShapeStyle, TextStyle, Timeline, Track, TrackKind } from '../api/types'
import { clamp, uid } from '../lib/format'
import { recalcAuto } from './graph/model'
import { freezeFrame as freezeClips } from './freeze'
import { nestClips, unnestClip } from './nesting'
import { colorPropAt, shiftMarkers, visibleMarkers, framesOf, isColorProp, keyIndexAt, localTime, propAt, shiftKeyframes, staticColor, staticValue, TEXT_COLOR, TEXT_NUMERIC, upsertKey } from './keyframes'

/** The user-editable part of a project (what undo/redo and autosave cover). */
/**
 * The editable project. ``settings`` / ``tracks`` / ``clips`` are the OPEN
 * sequence (``active``) so all timeline code works on it directly; the entry
 * for ``active`` inside ``sequences`` is stale while it's open (see
 * allSequences). Undo snapshots cover every sequence.
 */
export interface Doc {
  name: string
  settings: ProjectSettings
  tracks: Track[]
  clips: Clip[]
  active: string
  main: string
  sequences: Sequence[]
}

/** A keyframe selected in the graph editor (on the selected clip). */
export interface GraphKey {
  prop: AnimProp
  i: number
}

// Open sequence tabs, remembered per project in this browser.
const tabsKey = (projectId: string) => `yabbe.tabs.${projectId}`
function loadTabs(p: Project): string[] {
  const ids = new Set(p.sequences.map((s) => s.id))
  try {
    const saved: string[] = JSON.parse(localStorage.getItem(tabsKey(p.id)) ?? '[]')
    const tabs = saved.filter((id) => ids.has(id))
    return tabs.includes(p.main_sequence_id) || tabs.length ? tabs : [p.main_sequence_id]
  } catch {
    return [p.main_sequence_id]
  }
}
function saveTabs(projectId: string | null, tabs: string[]) {
  if (!projectId) return
  try {
    localStorage.setItem(tabsKey(projectId), JSON.stringify(tabs))
  } catch {
    /* ignore */
  }
}

// Snapping preferences (this browser).
function loadSnap(): { snapping: boolean; markers: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem('yabbe.snap') ?? '{}')
    return { snapping: v.snapping !== false, markers: v.markers !== false }
  } catch {
    return { snapping: true, markers: true }
  }
}
function saveSnap(v: { snapping: boolean; markers: boolean }) {
  try {
    localStorage.setItem('yabbe.snap', JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

const graphHiddenKey = (projectId: string) => `yabbe.graphHidden.${projectId}`
const collapsedKey = (projectId: string) => `yabbe.collapsed.${projectId}`

function loadMap(key: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}
function saveMap(key: string, value: Record<string, boolean>) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* ignore */
  }
}

function loadGraphHidden(projectId: string): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(graphHiddenKey(projectId)) ?? '{}')
  } catch {
    return {}
  }
}

export interface Upload {
  id: string
  name: string
  progress: number
}

const HISTORY_LIMIT = 200
export const MIN_CLIP = 0.04 // seconds
export const DEFAULT_IMAGE_DURATION = 5
export const DEFAULT_TEXT_DURATION = 5

export const DEFAULT_SHAPE: ShapeStyle = {
  kind: 'rectangle',
  width: 400,
  height: 400,
  fill: '#7c5cff',
  stroke: null,
  stroke_width: 0,
  radius: 0,
  sides: 6,
  inner: 0.45,
}

export const DEFAULT_TEXT: TextStyle = {
  content: 'Your text',
  font: 'DejaVu Sans',
  size: 96,
  color: '#ffffff',
  background: null,
  padding: 16,
  stroke_color: '#000000',
  stroke_width: 0,
  align: 'center',
  bold: true,
  italic: false,
  line_spacing: 1.2,
}

interface EditorState {
  projectId: string | null
  assets: Asset[]
  doc: Doc
  past: Doc[]
  future: Doc[]
  gestureStart: Doc | null
  version: number // bumps on every doc change (drives autosave + preview)
  savedVersion: number

  selection: string[]
  playhead: number
  playing: boolean
  zoom: number // px per second
  snapping: boolean
  /** Also snap to markers (only while snapping is on). */
  snapMarkers: boolean
  uploads: Upload[]
  textSizes: Record<string, { width: number; height: number }>

  // sequences
  /** Per-sequence playhead / zoom, restored when switching. */
  seqView: Record<string, { playhead: number; zoom: number }>
  /** Sequences shown as tabs above the timeline. */
  openTabs: string[]
  openSequence: (id: string) => void
  closeTab: (id: string) => void
  createSequence: (init: { name: string; settings: ProjectSettings }) => string
  duplicateSequence: (id: string) => string | null
  renameSequence: (id: string, name: string) => void
  deleteSequence: (id: string) => void
  setMainSequence: (id: string) => void
  /** Place a sequence on the open timeline. Returns an error message or null. */
  addSequenceClip: (sequenceId: string, opts?: { trackId?: string; start?: number }) => string | null
  /** Sequences above the open one when it was opened from a nested clip (breadcrumbs). */
  crumbs: string[]
  openNested: (sequenceId: string) => void
  /** Pre-compose the selected clips into a new sequence. Error message or null. */
  nestSelection: () => string | null
  /** Replace a nested clip with the clips inside it. Error message or null. */
  unnest: (clipId: string) => string | null
  /** Move the sound of the selected video clips onto audio tracks (linked). Error message or null. */
  separateAudio: () => string | null
  /** Give a separated video clip its sound back (removing its audio clip). */
  restoreAudio: (clipId: string) => void

  // graph editor (view state; not part of the project or undo history)
  graphOpen: boolean
  /** `${clipId}:${prop}` -> hidden from the graph editor. */
  graphHidden: Record<string, boolean>
  graphSel: GraphKey[]
  /** Collapsed tracks (view state, remembered per project in this browser). */
  collapsed: Record<string, boolean>
  toggleCollapsed: (trackId: string) => void
  setAllCollapsed: (collapsed: boolean) => void
  /** Selected transition, identified by the clip it leaves (clip A). */
  transSel: string | null
  selectTransition: (clipId: string | null) => void
  setTransition: (clipId: string, t: Transition | null) => void
  setGraphOpen: (open: boolean) => void
  setGraphHidden: (clipId: string, prop: AnimProp, hidden: boolean) => void
  setGraphSel: (sel: GraphKey[]) => void
  /** Replace a property's keyframes (sorted; auto handles recomputed). */
  setKeyframes: (clipId: string, prop: AnimProp, frames: Keyframe[]) => void

  load: (p: Project) => void
  setAssets: (assets: Asset[]) => void
  markSaved: (version: number) => void

  // history
  change: (fn: (d: Doc) => Doc) => void
  beginGesture: () => void
  endGesture: () => void
  undo: () => void
  redo: () => void

  // view state
  select: (ids: string[]) => void
  toggleSelect: (id: string) => void
  setPlayhead: (t: number) => void
  setPlaying: (p: boolean) => void
  setZoom: (z: number) => void
  setSnapping: (s: boolean) => void
  setSnapMarkers: (s: boolean) => void
  setUploads: (fn: (u: Upload[]) => Upload[]) => void
  setTextSize: (key: string, size: { width: number; height: number }) => void

  // edits
  rename: (name: string) => void
  updateSettings: (s: Partial<ProjectSettings>) => void
  updateClip: (id: string, patch: ClipPatch) => void
  /** Set animatable values at the playhead: keys them if animated, else static. */
  setProps: (id: string, values: Partial<Record<AnimProp, number | string | null>>) => void
  /** Add a keyframe at the playhead (current value), or remove the one there. */
  toggleKey: (id: string, prop: AnimProp) => void
  setKeyEase: (id: string, ease: Ease) => void
  clearKeys: (id: string, prop?: AnimProp) => void
  /** Retime a clip (same footage, new speed). Returns the speed actually applied. */
  setClipSpeed: (id: string, speed: number) => number
  /** Choose the speed that makes the clip's footage play for ``seconds``. */
  fitClipDuration: (id: string, seconds: number) => number
  /** Add a marker at the playhead on the selected clip; returns an error message or null. */
  addMarker: () => string | null
  /** Link the selected clips into one group (returns how many were linked). */
  linkSelected: () => number
  /** Remove the selected clips from their link groups. */
  unlinkSelected: () => number
  updateMarker: (clipId: string, markerId: string, patch: Partial<Omit<Marker, 'id'>>) => void
  removeMarker: (clipId: string, markerId: string) => void
  addAssetClip: (asset: Asset, opts?: { trackId?: string; start?: number }) => string | null
  addTextClip: () => string
  /** Add a shape at the playhead (top video track). */
  addShapeClip: (kind: ShapeKind) => string
  /** Freeze the frame under the playhead. Error message or null. */
  freezeFrame: () => string | null
  moveClip: (id: string, start: number, trackId: string) => void
  splitAtPlayhead: () => void
  deleteSelected: () => void
  duplicateSelected: () => void
  addTrack: (kind: TrackKind) => void
  updateTrack: (id: string, patch: Partial<Track>) => void
  removeTrack: (id: string) => void
  moveTrack: (id: string, dir: -1 | 1) => void
  removeAssetLocally: (assetId: string) => void
}

export type ClipPatch = Partial<Omit<Clip, 'transform' | 'crop' | 'text'>> & {
  transform?: Partial<Clip['transform']>
  crop?: Partial<Clip['crop']>
  text?: Partial<TextStyle>
}

const emptyDoc: Doc = {
  name: '',
  settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
  tracks: [],
  clips: [],
  active: '',
  main: '',
  sequences: [],
}

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4

/** Seconds from the clip's start to the next clip on its track (Infinity if none). */
export function gapAfter(clips: Clip[], clip: Clip): number {
  const next = clips
    .filter((c) => c.track_id === clip.track_id && c.id !== clip.id && c.start >= clipEnd(clip) - 1e-6)
    .reduce((m, c) => Math.min(m, c.start), Infinity)
  return next - clip.start
}

/** Allowed speed range for a clip: the slowest speed is limited by the next clip. */
export function speedRange(clips: Clip[], clip: Clip): { min: number; max: number; limitedByNext: boolean } {
  const footage = clip.duration * clip.speed
  const fitMin = footage / gapAfter(clips, clip)
  const min = Math.max(MIN_SPEED, fitMin)
  return { min: Math.min(min, MAX_SPEED), max: MAX_SPEED, limitedByNext: fitMin > MIN_SPEED }
}

/** Retime one clip, keeping its footage (source range), fades and key moments. */
function retime(c: Clip, speed: number): Clip {
  const footage = c.duration * c.speed
  const duration = Math.max(MIN_CLIP, footage / speed)
  const k = duration / c.duration
  const keyframes: Clip['keyframes'] = {}
  for (const [prop, frames] of Object.entries(c.keyframes ?? {}) as [AnimProp, Clip['keyframes'][AnimProp]][]) {
    keyframes[prop] = frames?.map((f) => ({
      ...f,
      t: f.t * k,
      hi: f.hi ? [f.hi[0] * k, f.hi[1]] : f.hi,
      ho: f.ho ? [f.ho[0] * k, f.ho[1]] : f.ho,
    }))
  }
  return {
    ...c,
    speed,
    duration,
    keyframes,
    markers: (c.markers ?? []).map((m) => ({ ...m, t: m.t * k })),
    fade_in: Math.min(c.fade_in, duration),
    fade_out: Math.min(c.fade_out, duration),
  }
}

/** Set a property's static (non-animated) value. */
function withStatic(c: Clip, prop: AnimProp, v: number | string | null): Clip {
  if (prop === 'volume') return { ...c, volume: v as number }
  const numField = TEXT_NUMERIC[prop]
  const colorField = TEXT_COLOR[prop]
  if (numField || colorField) {
    if (!c.text) return c
    const value = numField && ['size', 'stroke_width', 'padding'].includes(numField) ? Math.round(v as number) : v
    return { ...c, text: { ...c.text, [(numField ?? colorField)!]: value } }
  }
  return { ...c, transform: { ...c.transform, [prop]: v as number } }
}

export const clipEnd = (c: Clip) => c.start + c.duration
export const docDuration = (d: Doc) => d.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
export const textKey = (t: TextStyle) => JSON.stringify(t)

/** The open sequence's contents, for render requests. */
/** Unsaved editor state sent with render requests: the open sequence plus every
 * other one (nested sequences may have changed or be new since the last save). */
export function timelineOf(doc: Doc): Timeline {
  return { sequence_id: doc.active, sequences: allSequences(doc) }
}

// -- nested sequences ------------------------------------------------------------------

export const nestedAssetId = (sequenceId: string) => `seq:${sequenceId}`

/** A virtual asset describing a sequence, so nested clips work like footage. */
export function sequenceAsset(seq: Sequence): Asset {
  return {
    id: nestedAssetId(seq.id),
    kind: 'video',
    filename: '',
    original_name: seq.name,
    size: 0,
    duration: sequenceDuration(seq),
    width: seq.settings.width,
    height: seq.settings.height,
    fps: seq.settings.fps,
    has_video: true,
    has_audio: true,
    status: 'ready',
    error: null,
    thumb_count: 0,
    thumb_interval: 0,
    created_at: seq.created_at ?? 0,
  }
}

/** Key to look a clip's source up in assetsWithSequences(). */
export const assetKey = (c: Clip): string | null =>
  c.type === 'sequence' ? (c.sequence_id ? nestedAssetId(c.sequence_id) : null) : c.asset_id

/** Uploaded assets plus one virtual asset per sequence. */
export function assetsWithSequences(assets: Asset[], doc: Doc): Asset[] {
  return [...assets, ...allSequences(doc).map(sequenceAsset)]
}

/** Does ``outer`` use ``inner`` (directly or through other sequences)? */
export function sequenceContains(doc: Doc, outer: string, inner: string): boolean {
  const seqs = new Map(allSequences(doc).map((s) => [s.id, s]))
  const seen = new Set<string>()
  const todo = [outer]
  while (todo.length) {
    const cur = seqs.get(todo.pop()!)
    for (const c of cur?.clips ?? []) {
      if (c.type !== 'sequence' || !c.sequence_id) continue
      if (c.sequence_id === inner) return true
      if (!seen.has(c.sequence_id)) {
        seen.add(c.sequence_id)
        todo.push(c.sequence_id)
      }
    }
  }
  return false
}

/** Every sequence with the open one's live contents merged in. */
export function allSequences(doc: Doc): Sequence[] {
  return doc.sequences.map((s) =>
    s.id === doc.active ? { ...s, settings: doc.settings, tracks: doc.tracks, clips: doc.clips } : s,
  )
}

export const activeSequence = (doc: Doc): Sequence =>
  allSequences(doc).find((s) => s.id === doc.active) ?? allSequences(doc)[0]

export const sequenceDuration = (s: Sequence) => s.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)

/** Switch the open sequence inside a doc (pure). */
function withActive(doc: Doc, id: string): Doc {
  if (id === doc.active) return doc
  const seqs = allSequences(doc)
  const target = seqs.find((s) => s.id === id)
  if (!target) return doc
  return { ...doc, sequences: seqs, active: id, settings: target.settings, tracks: target.tracks, clips: target.clips }
}

export function trackKindFor(type: ClipType): TrackKind {
  return type === 'audio' ? 'audio' : 'video'
}

/** Max timeline length a clip can have given its source (for nested sequences the
 * virtual asset's duration). Infinity for stills/text. */
export function maxClipDuration(clip: Clip, asset: Asset | undefined): number {
  if (clip.type === 'text' || clip.type === 'image' || clip.type === 'shape' || clip.hold || !asset) return Infinity
  return Math.max(MIN_CLIP, (asset.duration - clip.in_point) / clip.speed)
}

export function overlaps(clips: Clip[], trackId: string, start: number, duration: number, ignore: Set<string>) {
  const end = start + duration
  return clips.some(
    (c) => c.track_id === trackId && !ignore.has(c.id) && c.start < end - 1e-6 && clipEnd(c) > start + 1e-6,
  )
}

/** First start >= wanted where [start, start+duration) is free on the track. */
export function findFreeStart(clips: Clip[], trackId: string, wanted: number, duration: number, ignore = new Set<string>()) {
  let start = Math.max(0, wanted)
  const onTrack = clips.filter((c) => c.track_id === trackId && !ignore.has(c.id)).sort((a, b) => a.start - b.start)
  for (const c of onTrack) {
    if (c.start < start + duration - 1e-6 && clipEnd(c) > start + 1e-6) start = clipEnd(c)
  }
  return start
}

function makeClip(partial: Partial<Clip> & Pick<Clip, 'track_id' | 'type'>): Clip {
  return {
    id: uid('c_'),
    asset_id: null,
    start: 0,
    duration: 5,
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
    ...partial,
  }
}

export function applyPatch(c: Clip, patch: ClipPatch): Clip {
  return {
    ...c,
    ...patch,
    transform: patch.transform ? { ...c.transform, ...patch.transform } : c.transform,
    crop: patch.crop ? { ...c.crop, ...patch.crop } : c.crop,
    text: patch.text && c.text ? { ...c.text, ...patch.text } : c.text,
    keyframes: patch.keyframes ?? c.keyframes ?? {},
    markers: patch.markers ?? c.markers ?? [],
  }
}

export const useEditor = create<EditorState>((set, get) => {
  const change = (fn: (d: Doc) => Doc) => {
    const s = get()
    const next = fn(s.doc)
    if (next === s.doc) return
    set({
      doc: next,
      version: s.version + 1,
      // During a gesture the snapshot is recorded once at the end.
      past: s.gestureStart ? s.past : [...s.past, s.doc].slice(-HISTORY_LIMIT),
      future: s.gestureStart ? s.future : [],
    })
  }

  const setClips = (fn: (clips: Clip[]) => Clip[]) => change((d) => ({ ...d, clips: fn(d.clips) }))

  return {
    projectId: null,
    assets: [],
    doc: emptyDoc,
    past: [],
    future: [],
    gestureStart: null,
    version: 0,
    savedVersion: 0,
    selection: [],
    playhead: 0,
    playing: false,
    zoom: 60,
    snapping: loadSnap().snapping,
    snapMarkers: loadSnap().markers,
    uploads: [],
    textSizes: {},
    graphOpen: false,
    graphHidden: {},
    graphSel: [],
    transSel: null,
    collapsed: {},

    toggleCollapsed: (trackId) => {
      const next = { ...get().collapsed }
      if (next[trackId]) delete next[trackId]
      else next[trackId] = true
      set({ collapsed: next })
      const pid = get().projectId
      if (pid) saveMap(collapsedKey(pid), next)
    },
    setAllCollapsed: (on) => {
      const next: Record<string, boolean> = {}
      if (on) for (const t of get().doc.tracks) next[t.id] = true
      set({ collapsed: next })
      const pid = get().projectId
      if (pid) saveMap(collapsedKey(pid), next)
    },

    seqView: {},
    openTabs: [],

    openSequence: (id) => {
      const s = get()
      if (id === s.doc.active || !s.doc.sequences.some((x) => x.id === id)) return
      const seqView = { ...s.seqView, [s.doc.active]: { playhead: s.playhead, zoom: s.zoom } }
      const view = seqView[id]
      const openTabs = s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id]
      saveTabs(s.projectId, openTabs)
      // Switching isn't an edit: no undo entry, no autosave needed.
      set({
        crumbs: [],
        doc: withActive(s.doc, id),
        seqView,
        openTabs,
        playhead: view?.playhead ?? 0,
        zoom: view?.zoom ?? s.zoom,
        playing: false,
        selection: [],
        graphSel: [],
        transSel: null,
      })
    },
    closeTab: (id) => {
      const s = get()
      if (s.openTabs.length <= 1) return
      const openTabs = s.openTabs.filter((t) => t !== id)
      saveTabs(s.projectId, openTabs)
      set({ openTabs })
      if (s.doc.active === id) get().openSequence(openTabs[Math.max(0, s.openTabs.indexOf(id) - 1)] ?? openTabs[0])
    },
    createSequence: ({ name, settings }) => {
      const seq: Sequence = {
        id: uid('s_'),
        name,
        settings,
        tracks: [
          { id: uid('t_'), kind: 'video', name: 'Video 2', muted: false, hidden: false, locked: false },
          { id: uid('t_'), kind: 'video', name: 'Video 1', muted: false, hidden: false, locked: false },
          { id: uid('t_'), kind: 'audio', name: 'Audio 1', muted: false, hidden: false, locked: false },
        ],
        clips: [],
        created_at: Date.now() / 1000,
      }
      change((d) => ({ ...d, sequences: [...allSequences(d), seq] }))
      get().openSequence(seq.id)
      return seq.id
    },
    duplicateSequence: (id) => {
      const src = allSequences(get().doc).find((s) => s.id === id)
      if (!src) return null
      const copy: Sequence = { ...structuredClone(src), id: uid('s_'), name: `${src.name} copy`, created_at: Date.now() / 1000 }
      // fresh ids so the copy is independent
      const trackMap = new Map(copy.tracks.map((t) => [t.id, uid('t_')]))
      copy.tracks = copy.tracks.map((t) => ({ ...t, id: trackMap.get(t.id)! }))
      const linkMap = new Map<string, string>()
      copy.clips = copy.clips.map((c) => ({
        ...c,
        id: uid('c_'),
        track_id: trackMap.get(c.track_id) ?? c.track_id,
        link: c.link ? (linkMap.get(c.link) ?? linkMap.set(c.link, uid('l_')).get(c.link)!) : null,
      }))
      change((d) => {
        const seqs = allSequences(d)
        const at = seqs.findIndex((s) => s.id === id)
        return { ...d, sequences: [...seqs.slice(0, at + 1), copy, ...seqs.slice(at + 1)] }
      })
      return copy.id
    },
    renameSequence: (id, name) =>
      change((d) => ({ ...d, sequences: allSequences(d).map((s) => (s.id === id ? { ...s, name } : s)) })),
    deleteSequence: (id) => {
      const s = get()
      if (id === s.doc.main || s.doc.sequences.length <= 1) return
      if (s.doc.active === id) get().openSequence(s.doc.main)
      change((d) => {
        const sequences = allSequences(d)
          .filter((x) => x.id !== id)
          .map((x) => ({ ...x, clips: x.clips.filter((c) => !(c.type === 'sequence' && c.sequence_id === id)) }))
        const open = sequences.find((x) => x.id === d.active)!
        return { ...d, sequences, settings: open.settings, tracks: open.tracks, clips: open.clips }
      })
      const openTabs = get().openTabs.filter((t) => t !== id)
      saveTabs(s.projectId, openTabs)
      set({ openTabs: openTabs.length ? openTabs : [get().doc.main] })
    },
    setMainSequence: (id) => change((d) => ({ ...d, main: id })),

    crumbs: [],
    openNested: (id) => {
      const s = get()
      const crumbs = [...s.crumbs, s.doc.active]
      get().openSequence(id)
      set({ crumbs })
    },

    addSequenceClip: (sequenceId, opts = {}) => {
      const { doc, playhead } = get()
      const seq = allSequences(doc).find((x) => x.id === sequenceId)
      if (!seq) return 'That sequence no longer exists'
      if (sequenceId === doc.active) return 'A sequence can’t contain itself'
      if (sequenceContains(doc, sequenceId, doc.active))
        return `“${seq.name}” already contains this sequence, so it can’t go inside it`
      let tracks = doc.tracks
      let track = doc.tracks.find((t) => t.id === opts.trackId && t.kind === 'video' && !t.locked)
      if (!track) track = [...doc.tracks].reverse().find((t) => t.kind === 'video' && !t.locked)
      if (!track) {
        track = { id: uid('t_'), kind: 'video', name: `Video ${doc.tracks.length + 1}`, muted: false, hidden: false, locked: false }
        tracks = [track, ...doc.tracks]
      }
      const duration = Math.max(sequenceDuration(seq), 1)
      const start = findFreeStart(doc.clips, track.id, opts.start ?? playhead, duration)
      const clip = makeClip({ track_id: track.id, type: 'sequence', sequence_id: sequenceId, start, duration })
      change((d) => ({ ...d, tracks, clips: [...d.clips, clip] }))
      set({ selection: [clip.id] })
      return null
    },

    nestSelection: () => {
      const { doc, selection } = get()
      const r = nestClips(doc, withLinked(selection, doc.clips))
      if (typeof r === 'string') return r
      change(() => r.doc)
      set({ selection: [r.clipId], transSel: null })
      return null
    },
    unnest: (clipId) => {
      const { doc } = get()
      const clip = doc.clips.find((c) => c.id === clipId)
      if (clip && doc.tracks.find((t) => t.id === clip.track_id)?.locked) return 'The track is locked'
      const r = unnestClip(doc, clipId)
      if (typeof r === 'string') return r
      change(() => r.doc)
      set({ selection: r.ids, transSel: null })
      return null
    },

    separateAudio: () => {
      const { doc, selection, assets } = get()
      const locked = new Set(doc.tracks.filter((t) => t.locked).map((t) => t.id))
      const targets = doc.clips.filter(
        (c) =>
          selection.includes(c.id) &&
          c.type === 'video' &&
          !c.audio_detached &&
          !locked.has(c.track_id) &&
          assets.find((a) => a.id === c.asset_id)?.has_audio,
      )
      if (!targets.length) return 'Select a video clip that has sound'
      let tracks = doc.tracks
      const added: Clip[] = []
      const updated = new Map<string, Clip>()
      for (const c of targets) {
        const all = [...doc.clips, ...added]
        let track = tracks.find((t) => t.kind === 'audio' && !t.locked && !overlaps(all, t.id, c.start, c.duration, new Set()))
        if (!track) {
          const n = tracks.filter((t) => t.kind === 'audio').length + 1
          track = { id: uid('t_'), kind: 'audio', name: `Audio ${n}`, muted: false, hidden: false, locked: false }
          tracks = [...tracks, track]
        }
        // Linked, so moving / trimming / deleting one keeps the other in sync.
        const link = c.link ?? uid('l_')
        const { volume: volumeKeys, ...otherKeys } = c.keyframes ?? {}
        added.push(
          makeClip({
            track_id: track.id,
            type: 'audio',
            asset_id: c.asset_id,
            start: c.start,
            duration: c.duration,
            in_point: c.in_point,
            speed: c.speed,
            volume: c.volume,
            muted: c.muted,
            fade_in: c.fade_in,
            fade_out: c.fade_out,
            keyframes: volumeKeys ? { volume: volumeKeys } : {},
            link,
          }),
        )
        updated.set(c.id, { ...c, link, audio_detached: true, volume: 1, muted: false, fade_in: 0, fade_out: 0, keyframes: otherKeys })
      }
      change((d) => ({ ...d, tracks, clips: [...d.clips.map((c) => updated.get(c.id) ?? c), ...added] }))
      set({ selection: [...targets.map((c) => c.id), ...added.map((c) => c.id)] })
      return null
    },
    restoreAudio: (clipId) => {
      const { doc } = get()
      const clip = doc.clips.find((c) => c.id === clipId)
      if (!clip?.audio_detached) return
      // Its separated audio: same file, same link group.
      const parts = doc.clips.filter((c) => c.type === 'audio' && c.asset_id === clip.asset_id && c.link && c.link === clip.link)
      const same = parts.find(
        (a) => Math.abs(a.start - clip.start) < 1e-6 && Math.abs(a.duration - clip.duration) < 1e-6 && Math.abs(a.in_point - clip.in_point) < 1e-6 && a.speed === clip.speed,
      )
      const gone = new Set(parts.map((c) => c.id))
      const back: Clip = {
        ...clip,
        audio_detached: false,
        ...(same
          ? {
              volume: same.volume,
              muted: same.muted,
              fade_in: same.fade_in,
              fade_out: same.fade_out,
              keyframes: { ...clip.keyframes, ...(same.keyframes?.volume ? { volume: same.keyframes.volume } : {}) },
            }
          : {}),
      }
      const rest = doc.clips.filter((c) => c.id !== clip.id && !gone.has(c.id))
      // Drop the link if nothing else is left in the group.
      if (back.link && !rest.some((c) => c.link === back.link)) back.link = null
      change((d) => ({ ...d, clips: [...rest, back] }))
      set({ selection: [clip.id] })
    },

    selectTransition: (clipId) => set(clipId ? { transSel: clipId, selection: [], graphSel: [] } : { transSel: null }),
    setTransition: (clipId, t) =>
      setClips((clips) => clips.map((c) => (c.id === clipId ? { ...c, transition: t } : c))),

    setGraphOpen: (graphOpen) => set({ graphOpen }),
    setGraphHidden: (clipId, prop, hidden) => {
      const next = { ...get().graphHidden }
      if (hidden) next[`${clipId}:${prop}`] = true
      else delete next[`${clipId}:${prop}`]
      set({ graphHidden: next, graphSel: get().graphSel.filter((k) => !(hidden && k.prop === prop)) })
      const pid = get().projectId
      if (pid) {
        try {
          localStorage.setItem(graphHiddenKey(pid), JSON.stringify(next))
        } catch {
          /* ignore */
        }
      }
    },
    setGraphSel: (graphSel) => set({ graphSel }),
    setKeyframes: (clipId, prop, frames) =>
      setClips((clips) =>
        clips.map((c) => {
          if (c.id !== clipId) return c
          const keyframes = { ...c.keyframes }
          if (frames.length) keyframes[prop] = recalcAuto([...frames].sort((a, b) => a.t - b.t), prop)
          else delete keyframes[prop]
          return { ...c, keyframes }
        }),
      ),

    load: (p) =>
      set({
        projectId: p.id,
        assets: p.assets,
        doc: (() => {
          const main = p.sequences.find((s) => s.id === p.main_sequence_id) ?? p.sequences[0]
          return {
            name: p.name,
            settings: main.settings,
            tracks: main.tracks,
            clips: main.clips,
            active: main.id,
            main: p.main_sequence_id,
            sequences: p.sequences,
          }
        })(),
        seqView: {},
        openTabs: loadTabs(p),
        past: [],
        future: [],
        gestureStart: null,
        version: 0,
        savedVersion: 0,
        selection: [],
        playhead: 0,
        playing: false,
        uploads: [],
        graphHidden: loadGraphHidden(p.id),
        collapsed: loadMap(collapsedKey(p.id)),
        graphSel: [],
      }),
    setAssets: (assets) => set({ assets }),
    markSaved: (version) => set({ savedVersion: Math.max(get().savedVersion, version) }),

    change,
    beginGesture: () => {
      if (!get().gestureStart) set({ gestureStart: get().doc })
    },
    endGesture: () => {
      const s = get()
      if (!s.gestureStart) return
      if (s.gestureStart !== s.doc) {
        set({ past: [...s.past, s.gestureStart].slice(-HISTORY_LIMIT), future: [], gestureStart: null })
      } else set({ gestureStart: null })
    },
    undo: () => {
      const s = get()
      if (!s.past.length) return
      const prev = s.past[s.past.length - 1]
      const ids = new Set(prev.clips.map((c) => c.id))
      set({
        doc: prev,
        past: s.past.slice(0, -1),
        future: [s.doc, ...s.future],
        version: s.version + 1,
        selection: s.selection.filter((id) => ids.has(id)),
      })
    },
    redo: () => {
      const s = get()
      if (!s.future.length) return
      const [next, ...rest] = s.future
      const ids = new Set(next.clips.map((c) => c.id))
      set({
        doc: next,
        past: [...s.past, s.doc],
        future: rest,
        version: s.version + 1,
        selection: s.selection.filter((id) => ids.has(id)),
      })
    },

    select: (ids) => {
      const same = ids.length === get().selection.length && ids.every((id, i) => id === get().selection[i])
      set(same ? { selection: ids, transSel: ids.length ? null : get().transSel } : { selection: ids, graphSel: [], transSel: null })
    },
    toggleSelect: (id) => {
      const sel = get().selection
      set({ selection: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
    },
    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    setPlaying: (playing) => set({ playing }),
    setZoom: (z) => set({ zoom: clamp(z, 4, 800) }),
    setSnapping: (snapping) => {
      set({ snapping })
      saveSnap({ snapping, markers: get().snapMarkers })
    },
    setSnapMarkers: (snapMarkers) => {
      set({ snapMarkers })
      saveSnap({ snapping: get().snapping, markers: snapMarkers })
    },
    setUploads: (fn) => set({ uploads: fn(get().uploads) }),
    setTextSize: (key, size) => set({ textSizes: { ...get().textSizes, [key]: size } }),

    rename: (name) => change((d) => ({ ...d, name })),
    updateSettings: (patch) => change((d) => ({ ...d, settings: { ...d.settings, ...patch } })),

    updateClip: (id, patch) => setClips((clips) => clips.map((c) => (c.id === id ? applyPatch(c, patch) : c))),

    setProps: (id, values) => {
      const { playhead, doc } = get()
      const fps = doc.settings.fps
      setClips((clips) =>
        clips.map((c) => {
          if (c.id !== id) return c
          let next = c
          for (const [prop, v] of Object.entries(values) as [AnimProp, number | string | null][]) {
            const frames = framesOf(next, prop)
            if (frames && v !== null) {
              const u = localTime(next, playhead, fps)
              next = { ...next, keyframes: { ...next.keyframes, [prop]: recalcAuto(upsertKey(frames, u, v, fps), prop) } }
            } else next = withStatic(next, prop, v)
          }
          return next
        }),
      )
    },

    toggleKey: (id, prop) => {
      const { playhead, doc } = get()
      const fps = doc.settings.fps
      setClips((clips) =>
        clips.map((c) => {
          if (c.id !== id) return c
          const frames = framesOf(c, prop)
          const u = localTime(c, playhead, fps)
          const i = keyIndexAt(frames, u, fps)
          if (frames && i >= 0) {
            const rest = frames.filter((_, j) => j !== i)
            const keyframes = { ...c.keyframes, [prop]: rest }
            if (!rest.length) {
              // Last key removed: keep the value it had as the static value.
              delete keyframes[prop]
              return withStatic({ ...c, keyframes }, prop, isColorProp(prop) ? (frames[i].c ?? null) : frames[i].v)
            }
            return { ...c, keyframes }
          }
          const v = isColorProp(prop)
            ? frames ? colorPropAt(c, prop, playhead) : staticColor(c, prop)
            : frames ? propAt(c, prop, playhead) : staticValue(c, prop)
          if (v === null) return c // e.g. no text box to animate
          return { ...c, keyframes: { ...c.keyframes, [prop]: recalcAuto(upsertKey(frames, u, v, fps), prop) } }
        }),
      )
    },

    setKeyEase: (id, ease) => {
      const { playhead, doc } = get()
      const fps = doc.settings.fps
      setClips((clips) =>
        clips.map((c) => {
          if (c.id !== id) return c
          const u = localTime(c, playhead, fps)
          const keyframes: Clip['keyframes'] = {}
          for (const [prop, frames] of Object.entries(c.keyframes ?? {}) as [AnimProp, Clip['keyframes'][AnimProp]][]) {
            const i = keyIndexAt(frames, u, fps)
            keyframes[prop] = i >= 0 ? frames!.map((k, j) => (j === i ? { ...k, ease } : k)) : frames
          }
          return { ...c, keyframes }
        }),
      )
    },

    setClipSpeed: (id, wanted) => {
      const clip = get().doc.clips.find((c) => c.id === id)
      if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) return clip?.speed ?? 1
      const { min, max } = speedRange(get().doc.clips, clip)
      const speed = Math.round(clamp(wanted, min, max) * 1000) / 1000
      if (Math.abs(speed - clip.speed) > 1e-9) setClips((clips) => clips.map((c) => (c.id === id ? retime(c, speed) : c)))
      return speed
    },

    fitClipDuration: (id, seconds) => {
      const clip = get().doc.clips.find((c) => c.id === id)
      if (!clip || seconds <= 0) return clip?.speed ?? 1
      return get().setClipSpeed(id, (clip.duration * clip.speed) / seconds)
    },

    linkSelected: () => {
      const { selection } = get()
      if (selection.length < 2) return 0
      const id = uid('l_')
      const sel = new Set(selection)
      setClips((clips) => clips.map((c) => (sel.has(c.id) ? { ...c, link: id } : c)))
      return selection.length
    },

    unlinkSelected: () => {
      const { selection, doc } = get()
      const sel = new Set(selection)
      const n = doc.clips.filter((c) => sel.has(c.id) && c.link).length
      if (!n) return 0
      setClips((clips) => {
        const next = clips.map((c) => (sel.has(c.id) ? { ...c, link: null } : c))
        // A group left with a single member isn't a link any more.
        const count = new Map<string, number>()
        for (const c of next) if (c.link) count.set(c.link, (count.get(c.link) ?? 0) + 1)
        return next.map((c) => (c.link && count.get(c.link) === 1 ? { ...c, link: null } : c))
      })
      return n
    },

    addMarker: () => {
      const { selection, doc, playhead } = get()
      if (selection.length !== 1) return 'Select one clip to add a marker to'
      const clip = doc.clips.find((c) => c.id === selection[0])
      if (!clip) return 'Select one clip to add a marker to'
      const fps = doc.settings.fps
      const t = Math.round((playhead - clip.start) * fps) / fps
      if (t < -1e-6 || t > clip.duration + 1e-6) return 'Move the playhead over the selected clip first'
      if (visibleMarkers(clip).some((m) => Math.abs(m.t - t) < 0.5 / fps)) return 'There is already a marker here'
      const n = (clip.markers ?? []).length + 1
      const marker: Marker = { id: uid('m_'), t, label: `Marker ${n}`, color: '#f2b84b' }
      setClips((clips) => clips.map((c) => (c.id === clip.id ? { ...c, markers: [...(c.markers ?? []), marker] } : c)))
      return null
    },

    updateMarker: (clipId, markerId, patch) =>
      setClips((clips) =>
        clips.map((c) =>
          c.id === clipId ? { ...c, markers: (c.markers ?? []).map((m) => (m.id === markerId ? { ...m, ...patch } : m)) } : c,
        ),
      ),

    removeMarker: (clipId, markerId) =>
      setClips((clips) =>
        clips.map((c) => (c.id === clipId ? { ...c, markers: (c.markers ?? []).filter((m) => m.id !== markerId) } : c)),
      ),

    clearKeys: (id, prop) => {
      const { playhead } = get()
      setClips((clips) =>
        clips.map((c) => {
          if (c.id !== id) return c
          const props = prop ? [prop] : (Object.keys(c.keyframes ?? {}) as AnimProp[])
          let next: Clip = { ...c, keyframes: { ...c.keyframes } }
          for (const p of props) {
            if (!framesOf(c, p)) continue
            // Freeze the value currently shown so nothing jumps.
            const v = isColorProp(p) ? colorPropAt(c, p, playhead) : propAt(c, p, playhead)
            delete next.keyframes[p]
            next = withStatic(next, p, v)
          }
          return next
        }),
      )
    },

    addAssetClip: (asset, opts = {}) => {
      const { doc, playhead } = get()
      const type: ClipType = asset.kind
      const kind = trackKindFor(type)
      let track = doc.tracks.find((t) => t.id === opts.trackId && t.kind === kind && !t.locked)
      if (!track) {
        // Bottom-most unlocked track of the right kind (the "main" track).
        track = [...doc.tracks].reverse().find((t) => t.kind === kind && !t.locked)
      }
      let tracks = doc.tracks
      if (!track) {
        track = { id: uid('t_'), kind, name: `${kind === 'audio' ? 'Audio' : 'Video'} ${doc.tracks.length + 1}`, muted: false, hidden: false, locked: false }
        tracks = kind === 'audio' ? [...doc.tracks, track] : [track, ...doc.tracks]
      }
      const duration = asset.kind === 'image' ? DEFAULT_IMAGE_DURATION : Math.max(MIN_CLIP, asset.duration)
      const start = findFreeStart(doc.clips, track.id, opts.start ?? playhead, duration)
      const clip = makeClip({ track_id: track.id, type, asset_id: asset.id, start, duration })
      change((d) => ({ ...d, tracks, clips: [...d.clips, clip] }))
      set({ selection: [clip.id] })
      return clip.id
    },

    addTextClip: () => {
      const { doc, playhead } = get()
      let tracks = doc.tracks
      let track = doc.tracks.find((t) => t.kind === 'video' && !t.locked)
      if (!track) {
        track = { id: uid('t_'), kind: 'video', name: 'Text', muted: false, hidden: false, locked: false }
        tracks = [track, ...tracks]
      }
      const start = findFreeStart(doc.clips, track.id, playhead, DEFAULT_TEXT_DURATION)
      const clip = makeClip({ track_id: track.id, type: 'text', start, duration: DEFAULT_TEXT_DURATION, text: { ...DEFAULT_TEXT } })
      change((d) => ({ ...d, tracks, clips: [...d.clips, clip] }))
      set({ selection: [clip.id] })
      return clip.id
    },

    addShapeClip: (kind) => {
      const { doc, playhead } = get()
      let tracks = doc.tracks
      let track = doc.tracks.find((t) => t.kind === 'video' && !t.locked)
      if (!track) {
        track = { id: uid('t_'), kind: 'video', name: 'Shapes', muted: false, hidden: false, locked: false }
        tracks = [track, ...tracks]
      }
      const start = findFreeStart(doc.clips, track.id, playhead, DEFAULT_TEXT_DURATION)
      const size = Math.round(Math.min(doc.settings.width, doc.settings.height) / 3)
      const line = kind === 'line' || kind === 'arrow'
      const shape: ShapeStyle = {
        ...DEFAULT_SHAPE,
        kind,
        width: line ? size * 2 : kind === 'rectangle' ? Math.round(size * 1.6) : size,
        height: line ? Math.max(4, Math.round(size / 12)) : size,
        fill: line ? null : DEFAULT_SHAPE.fill,
        stroke: line ? '#ffffff' : null,
        stroke_width: line ? Math.max(4, Math.round(size / 12)) : 0,
        sides: kind === 'star' ? 5 : 6,
      }
      const clip = makeClip({ track_id: track.id, type: 'shape', start, duration: DEFAULT_TEXT_DURATION, shape })
      change((d) => ({ ...d, tracks, clips: [...d.clips, clip] }))
      set({ selection: [clip.id] })
      return clip.id
    },

    freezeFrame: () => {
      const { doc, selection, playhead } = get()
      const r = freezeClips(doc, selection, playhead)
      if (typeof r === 'string') return r
      change(() => r.doc)
      set({ selection: [r.clipId], transSel: null })
      return null
    },

    moveClip: (id, start, trackId) =>
      setClips((clips) => clips.map((c) => (c.id === id ? { ...c, start: Math.max(0, start), track_id: trackId } : c))),

    splitAtPlayhead: () => {
      const { doc, playhead, selection } = get()
      const t = playhead
      const lockedTracks = new Set(doc.tracks.filter((tr) => tr.locked).map((tr) => tr.id))
      let targets = doc.clips.filter((c) => c.start + MIN_CLIP < t && clipEnd(c) - MIN_CLIP > t && !lockedTracks.has(c.track_id))
      if (selection.length) {
        const selected = targets.filter((c) => selection.includes(c.id))
        if (selected.length) targets = selected
      }
      if (!targets.length) return
      const ids = new Set(targets.map((c) => c.id))
      const newSel: string[] = []
      const rightLink = new Map<string, string>() // right halves of a linked group form their own group
      setClips((clips) =>
        clips.flatMap((c) => {
          if (!ids.has(c.id)) return [c]
          const left = t - c.start
          const inFirst = (m: Marker) => m.t < left - 1e-6
          const a: Clip = { ...c, duration: left, fade_out: 0, markers: (c.markers ?? []).filter(inFirst), transition: null }
          const b: Clip = {
            ...c,
            id: uid('c_'),
            start: t,
            duration: c.duration - left,
            in_point: c.hold ? c.in_point : c.in_point + left * c.speed, // a freeze keeps its frame
            fade_in: 0,
            keyframes: shiftKeyframes(c.keyframes, -left) ?? {},
            markers: shiftMarkers((c.markers ?? []).filter((m) => !inFirst(m)), -left),
            link: c.link ? (rightLink.get(c.link) ?? rightLink.set(c.link, uid('l_')).get(c.link)!) : null,
          }
          newSel.push(b.id)
          return [a, b]
        }),
      )
      set({ selection: newSel })
    },

    deleteSelected: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      const locked = new Set(doc.tracks.filter((t) => t.locked).map((t) => t.id))
      const sel = new Set(selection)
      setClips((clips) => clips.filter((c) => !sel.has(c.id) || locked.has(c.track_id)))
      set({ selection: [] })
    },

    duplicateSelected: () => {
      const { selection, doc } = get()
      if (!selection.length) return
      const added: Clip[] = []
      const linkMap = new Map<string, string>()
      for (const c of doc.clips.filter((c) => selection.includes(c.id))) {
        const all = [...doc.clips, ...added]
        const start = findFreeStart(all, c.track_id, clipEnd(c), c.duration)
        const copy = structuredClone(c)
        const link = copy.link ? (linkMap.get(copy.link) ?? linkMap.set(copy.link, uid('l_')).get(copy.link)!) : null
        added.push({ ...copy, id: uid('c_'), start, link, markers: (copy.markers ?? []).map((m) => ({ ...m, id: uid('m_') })) })
      }
      setClips((clips) => [...clips, ...added])
      set({ selection: added.map((c) => c.id) })
    },

    addTrack: (kind) =>
      change((d) => {
        const n = d.tracks.filter((t) => t.kind === kind).length + 1
        const track: Track = {
          id: uid('t_'),
          kind,
          name: `${kind === 'audio' ? 'Audio' : 'Video'} ${n}`,
          muted: false,
          hidden: false,
          locked: false,
        }
        // Video tracks stack on top, audio tracks at the bottom.
        return { ...d, tracks: kind === 'video' ? [track, ...d.tracks] : [...d.tracks, track] }
      }),
    updateTrack: (id, patch) =>
      change((d) => ({ ...d, tracks: d.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    removeTrack: (id) =>
      change((d) => ({
        ...d,
        tracks: d.tracks.filter((t) => t.id !== id),
        clips: d.clips.filter((c) => c.track_id !== id),
      })),
    moveTrack: (id, dir) =>
      change((d) => {
        const i = d.tracks.findIndex((t) => t.id === id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= d.tracks.length || d.tracks[j].kind !== d.tracks[i].kind) return d
        const tracks = [...d.tracks]
        ;[tracks[i], tracks[j]] = [tracks[j], tracks[i]]
        return { ...d, tracks }
      }),
    removeAssetLocally: (assetId) => {
      // The server already dropped these clips; purge them from history too so
      // undo can never resurrect clips that point at deleted media.
      const s = get()
      const purge = (d: Doc): Doc =>
        d.clips.some((c) => c.asset_id === assetId) ? { ...d, clips: d.clips.filter((c) => c.asset_id !== assetId) } : d
      set({
        assets: s.assets.filter((a) => a.id !== assetId),
        doc: purge(s.doc),
        past: s.past.map(purge),
        future: s.future.map(purge),
        gestureStart: s.gestureStart && purge(s.gestureStart),
        selection: s.selection.filter((id) => s.doc.clips.find((c) => c.id === id)?.asset_id !== assetId),
        version: s.version + 1,
      })
    },
  }
})

/** ``ids`` plus every clip linked to one of them. */
export function withLinked(ids: string[], clips: Clip[]): string[] {
  const links = new Set(clips.filter((c) => ids.includes(c.id) && c.link).map((c) => c.link))
  if (!links.size) return ids
  const out = new Set(ids)
  for (const c of clips) if (c.link && links.has(c.link)) out.add(c.id)
  return [...out]
}

/** Pairs of touching visual clips on the same track (where transitions can go). */
export function cuts(doc: Doc): { a: Clip; b: Clip; time: number }[] {
  const fps = doc.settings.fps
  const videoTracks = new Set(doc.tracks.filter((t) => t.kind === 'video').map((t) => t.id))
  const byTrack = new Map<string, Clip[]>()
  for (const c of doc.clips) {
    if (c.type === 'audio' || !videoTracks.has(c.track_id)) continue
    byTrack.set(c.track_id, [...(byTrack.get(c.track_id) ?? []), c])
  }
  const out: { a: Clip; b: Clip; time: number }[] = []
  for (const list of byTrack.values()) {
    list.sort((x, y) => x.start - y.start)
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]
      const b = list[i + 1]
      if (Math.abs(b.start - clipEnd(a)) <= 0.5 / fps) out.push({ a, b, time: clipEnd(a) })
    }
  }
  return out
}

/** Effective transition length (never longer than either clip). */
export const transitionLength = (a: Clip, b: Clip) => Math.min(a.transition?.duration ?? 0, a.duration, b.duration)

/** Every visible marker on the timeline, in time order. */
export function allMarkers(doc: Doc) {
  return doc.clips
    .flatMap((c) => visibleMarkers(c).map((m) => ({ clip: c, marker: m, time: c.start + m.t })))
    .sort((a, b) => a.time - b.time)
}

export const selectDuration = (s: EditorState) => docDuration(s.doc)
