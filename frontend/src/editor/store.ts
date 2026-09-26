import { create } from 'zustand'
import type { AnimProp, Asset, Clip, ClipType, Ease, Project, ProjectSettings, TextStyle, Timeline, Track, TrackKind } from '../api/types'
import { clamp, uid } from '../lib/format'
import { colorPropAt, framesOf, isColorProp, keyIndexAt, localTime, propAt, shiftKeyframes, staticColor, staticValue, TEXT_COLOR, TEXT_NUMERIC, upsertKey } from './keyframes'

/** The user-editable part of a project (what undo/redo and autosave cover). */
export interface Doc {
  name: string
  settings: ProjectSettings
  tracks: Track[]
  clips: Clip[]
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
  uploads: Upload[]
  textSizes: Record<string, { width: number; height: number }>

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
  addAssetClip: (asset: Asset, opts?: { trackId?: string; start?: number }) => string | null
  addTextClip: () => string
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
    keyframes[prop] = frames?.map((f) => ({ ...f, t: f.t * k }))
  }
  return {
    ...c,
    speed,
    duration,
    keyframes,
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

export function timelineOf(doc: Doc): Timeline {
  return { settings: doc.settings, tracks: doc.tracks, clips: doc.clips }
}

export function trackKindFor(type: ClipType): TrackKind {
  return type === 'audio' ? 'audio' : 'video'
}

/** Max timeline length a clip can have given its source. Infinity for stills/text. */
export function maxClipDuration(clip: Clip, asset: Asset | undefined): number {
  if (clip.type === 'text' || clip.type === 'image' || !asset) return Infinity
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
    snapping: true,
    uploads: [],
    textSizes: {},

    load: (p) =>
      set({
        projectId: p.id,
        assets: p.assets,
        doc: { name: p.name, settings: p.settings, tracks: p.tracks, clips: p.clips },
        past: [],
        future: [],
        gestureStart: null,
        version: 0,
        savedVersion: 0,
        selection: [],
        playhead: 0,
        playing: false,
        uploads: [],
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

    select: (ids) => set({ selection: ids }),
    toggleSelect: (id) => {
      const sel = get().selection
      set({ selection: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
    },
    setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
    setPlaying: (playing) => set({ playing }),
    setZoom: (z) => set({ zoom: clamp(z, 4, 800) }),
    setSnapping: (snapping) => set({ snapping }),
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
              next = { ...next, keyframes: { ...next.keyframes, [prop]: upsertKey(frames, u, v, fps) } }
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
          return { ...c, keyframes: { ...c.keyframes, [prop]: upsertKey(frames, u, v, fps) } }
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
      setClips((clips) =>
        clips.flatMap((c) => {
          if (!ids.has(c.id)) return [c]
          const left = t - c.start
          const a: Clip = { ...c, duration: left, fade_out: 0 }
          const b: Clip = {
            ...c,
            id: uid('c_'),
            start: t,
            duration: c.duration - left,
            in_point: c.in_point + left * c.speed,
            fade_in: 0,
            keyframes: shiftKeyframes(c.keyframes, -left) ?? {},
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
      for (const c of doc.clips.filter((c) => selection.includes(c.id))) {
        const all = [...doc.clips, ...added]
        const start = findFreeStart(all, c.track_id, clipEnd(c), c.duration)
        added.push({ ...structuredClone(c), id: uid('c_'), start })
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

export const selectDuration = (s: EditorState) => docDuration(s.doc)
