import type { Clip, Sequence, Track } from '../api/types'
import { uid } from '../lib/format'
import { shiftKeyframes, shiftMarkers } from './keyframes'
import { allSequences, clipEnd, cuts, type Doc, MIN_CLIP, overlaps, sequenceDuration } from './store'

const EPS = 1e-6

function newTrack(kind: Track['kind'], name: string): Track {
  return { id: uid('t_'), kind, name, muted: false, hidden: false, locked: false }
}

/** Fresh link ids per group, so moved/copied clips never link to the originals. */
function relinker() {
  const map = new Map<string, string>()
  return (link: string | null | undefined) => (link ? (map.get(link) ?? map.set(link, uid('l_')).get(link)!) : null)
}

/** Name like "Nested sequence 3" that isn't taken yet. */
function freeName(doc: Doc, base: string) {
  const names = new Set(allSequences(doc).map((s) => s.name))
  for (let n = 1; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`
}

/**
 * Pre-compose: move clips of the open sequence into a new sequence and put
 * that sequence in their place (like After Effects' pre-compose). The new
 * sequence has the same canvas and keeps each clip's track layering and
 * timing; the nested clip starts where the earliest clip started, on the
 * lowest track they used (so un-nesting puts everything back where it was).
 * Returns the new doc + nested clip id, or an error message.
 */
export function nestClips(doc: Doc, ids: string[], name?: string): { doc: Doc; clipId: string; sequenceId: string } | string {
  const locked = new Set(doc.tracks.filter((t) => t.locked).map((t) => t.id))
  const picked = doc.clips.filter((c) => ids.includes(c.id) && !locked.has(c.track_id))
  if (!picked.length) return 'Select the clips to nest first'
  const t0 = Math.min(...picked.map((c) => c.start))
  const t1 = Math.max(...picked.map(clipEnd))
  const pickedIds = new Set(picked.map((c) => c.id))

  // Tracks the clips were on, in the same order (top first).
  const usedTracks = doc.tracks.filter((t) => picked.some((c) => c.track_id === t.id))
  const trackMap = new Map(usedTracks.map((t) => [t.id, uid('t_')]))
  const tracks: Track[] = usedTracks.map((t) => ({ ...t, id: trackMap.get(t.id)!, locked: false }))
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift(newTrack('video', 'Video 1'))
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push(newTrack('audio', 'Audio 1'))

  // A transition stays only if both of its clips move.
  const next = new Map(cuts(doc).map((x) => [x.a.id, x.b.id]))
  const relink = relinker()
  const clips: Clip[] = picked.map((c) => ({
    ...structuredClone(c),
    id: uid('c_'),
    start: c.start - t0,
    track_id: trackMap.get(c.track_id)!,
    link: relink(c.link),
    transition: c.transition && pickedIds.has(next.get(c.id) ?? '') ? c.transition : null,
  }))
  const seq: Sequence = {
    id: uid('s_'),
    name: name?.trim() || freeName(doc, 'Nested sequence'),
    settings: { ...doc.settings },
    tracks,
    clips,
    created_at: Date.now() / 1000,
  }

  // Where the nested clip goes: the lowest video track the clips used, else the
  // bottom video track; a new track right above it if something else is in the way.
  const remaining = doc.clips.filter((c) => !pickedIds.has(c.id))
  let parentTracks = doc.tracks
  const visualTracks = usedTracks.filter((t) => t.kind === 'video')
  let track = visualTracks[visualTracks.length - 1] ?? [...doc.tracks].reverse().find((t) => t.kind === 'video' && !t.locked)
  if (!track || overlaps(remaining, track.id, t0, t1 - t0, new Set())) {
    const added = newTrack('video', `Video ${doc.tracks.filter((t) => t.kind === 'video').length + 1}`)
    const at = track ? doc.tracks.indexOf(track) : 0
    parentTracks = [...doc.tracks.slice(0, at), added, ...doc.tracks.slice(at)]
    track = added
  }
  const nested: Clip = {
    id: uid('c_'),
    asset_id: null,
    type: 'sequence',
    sequence_id: seq.id,
    track_id: track.id,
    start: t0,
    duration: t1 - t0,
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
  }
  return {
    doc: { ...doc, sequences: [...allSequences(doc), seq], tracks: parentTracks, clips: [...remaining, nested] },
    clipId: nested.id,
    sequenceId: seq.id,
  }
}

const isDefault = (c: Clip) =>
  c.transform.x === 0 &&
  c.transform.y === 0 &&
  c.transform.scale === 1 &&
  c.transform.rotation === 0 &&
  c.transform.opacity === 1 &&
  !c.transform.flip_h &&
  !c.transform.flip_v &&
  !c.crop.left &&
  !c.crop.top &&
  !c.crop.right &&
  !c.crop.bottom &&
  !Object.values(c.keyframes ?? {}).some((f) => f?.length)

/** Why a nested clip can't be un-nested (null when it can). Un-nesting keeps the
 * picture identical, so the nested clip itself must be unchanged apart from trims. */
export function unnestBlocker(doc: Doc, clip: Clip): string | null {
  if (clip.type !== 'sequence' || !clip.sequence_id) return 'Not a nested sequence'
  const seq = allSequences(doc).find((s) => s.id === clip.sequence_id)
  if (!seq) return 'The sequence no longer exists'
  if (seq.settings.width !== doc.settings.width || seq.settings.height !== doc.settings.height)
    return `“${seq.name}” has a different canvas size (${seq.settings.width}×${seq.settings.height})`
  if (Math.abs(clip.speed - 1) > EPS) return 'The nested clip’s speed is changed'
  if (!isDefault(clip)) return 'The nested clip has transform, crop or keyframe changes'
  if (Math.abs(clip.volume - 1) > EPS || clip.muted || clip.fade_in || clip.fade_out)
    return 'The nested clip’s volume or fades are changed'
  const into = cuts(doc).find((x) => x.b.id === clip.id && x.a.transition)
  if (clip.transition || into) return 'The nested clip has a transition'
  return null
}

/**
 * Un-nest: replace a nested clip with the clips inside it (the part its trim
 * shows), keeping their layering: the child's video tracks go onto the nested
 * clip's track and the tracks directly above it (new ones are inserted when
 * those are busy), its audio onto free audio tracks.
 */
export function unnestClip(doc: Doc, clipId: string): { doc: Doc; ids: string[] } | string {
  const clip = doc.clips.find((c) => c.id === clipId)
  if (!clip) return 'Clip not found'
  const why = unnestBlocker(doc, clip)
  if (why) return why
  const seq = allSequences(doc).find((s) => s.id === clip.sequence_id)!
  const from = clip.in_point
  const to = Math.min(clip.in_point + clip.duration, sequenceDuration(seq))
  const offset = clip.start - clip.in_point // child time -> parent time
  const childTracks = new Map(seq.tracks.map((t) => [t.id, t]))
  const relink = relinker()

  const cut: Clip[] = []
  for (const c of seq.clips) {
    const tr = childTracks.get(c.track_id)
    if (!tr || (tr.hidden && tr.kind === 'video')) continue
    const s = Math.max(c.start, from)
    const e = Math.min(clipEnd(c), to)
    if (e - s < MIN_CLIP) continue
    const left = s - c.start
    cut.push({
      ...structuredClone(c),
      id: uid('c_'),
      start: s + offset,
      duration: e - s,
      in_point: c.in_point + left * c.speed,
      fade_in: left > EPS ? 0 : c.fade_in,
      fade_out: e < clipEnd(c) - EPS ? 0 : c.fade_out,
      keyframes: shiftKeyframes(c.keyframes, -left) ?? {},
      markers: shiftMarkers(c.markers, -left),
      transition: e < clipEnd(c) - EPS ? null : c.transition,
      muted: c.muted || (tr.muted && c.type !== 'text' && c.type !== 'image'),
      link: relink(c.link),
    })
  }

  let tracks = [...doc.tracks]
  let clips = doc.clips.filter((c) => c.id !== clip.id)
  const s0 = clip.start
  const len = clip.duration
  const free = (t: Track) => !t.locked && !overlaps(clips, t.id, s0, len, new Set())
  const target = new Map<string, string>() // child track -> parent track
  const used = (id: string) => cut.some((c) => c.track_id === id)

  // Video: bottom child track onto the nested clip's track, then upwards.
  let cursor = tracks.findIndex((t) => t.id === clip.track_id)
  const childVideo = seq.tracks.filter((t) => t.kind === 'video' && used(t.id)).reverse()
  childVideo.forEach((ct, i) => {
    if (i > 0) {
      const above = tracks[cursor - 1]
      if (above && above.kind === 'video' && free(above)) cursor -= 1
      else {
        tracks = [...tracks.slice(0, cursor), newTrack('video', `${seq.name} · ${ct.name}`), ...tracks.slice(cursor)]
      }
    }
    target.set(ct.id, tracks[cursor].id)
  })
  // Audio: any free audio track, else a new one at the bottom.
  for (const ct of seq.tracks.filter((t) => t.kind === 'audio' && used(t.id))) {
    let tr = tracks.find((t) => t.kind === 'audio' && free(t) && ![...target.values()].includes(t.id))
    if (!tr) {
      tr = newTrack('audio', `${seq.name} · ${ct.name}`)
      tracks = [...tracks, tr]
    }
    target.set(ct.id, tr.id)
  }
  const placed = cut.map((c) => ({ ...c, track_id: target.get(c.track_id)! }))
  clips = [...clips, ...placed]
  return { doc: { ...doc, tracks, clips }, ids: placed.map((c) => c.id) }
}
