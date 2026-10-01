import type { Clip } from '../api/types'
import { uid } from '../lib/format'
import { shiftKeyframes, shiftMarkers, transformAt } from './keyframes'
import { clipEnd, type Doc, MIN_CLIP, withLinked } from './store'

export const FREEZE_SECONDS = 2

export interface FreezeTarget {
  clip: Clip
  /** Timeline time (snapped to a frame). */
  t: number
  /** Source time of that frame. */
  sourceT: number
}

/** The video clip a freeze frame would come from: the selected one under the
 * playhead, else the top-most. */
export function freezeTarget(doc: Doc, selection: string[], playhead: number): FreezeTarget | string {
  const fps = doc.settings.fps
  const t = Math.round(playhead * fps) / fps
  const locked = new Set(doc.tracks.filter((tr) => tr.locked).map((tr) => tr.id))
  const rank = new Map(doc.tracks.map((tr, i) => [tr.id, i]))
  const videos = doc.clips.filter(
    (c) => c.type === 'video' && !c.hold && c.asset_id && c.start <= t + 1e-6 && clipEnd(c) > t + 1e-6 && !locked.has(c.track_id),
  )
  if (!videos.length) return 'Put the playhead over a video clip to freeze its frame'
  const clip =
    videos.find((c) => selection.includes(c.id)) ?? [...videos].sort((a, b) => (rank.get(a.track_id) ?? 0) - (rank.get(b.track_id) ?? 0))[0]
  return { clip, t, sourceT: clip.in_point + (t - clip.start) * clip.speed }
}

/**
 * Freeze frame: split the clip at the target and put a still of that frame -
 * an ordinary photo clip of `imageAssetId` (the frame, saved as an image) -
 * between the halves, `duration` long. The rest of the clip, and everything
 * after it on its track, moves right to make room; clips linked to it (e.g.
 * its separated audio) are split and moved the same way, leaving a silent
 * gap. The photo keeps the clip's look at that moment (crop, blend, key; the
 * keyframed transform values at that moment become static).
 * Returns the new doc + the photo clip's id.
 */
export function freezeFrame(doc: Doc, target: FreezeTarget, imageAssetId: string, duration = FREEZE_SECONDS): { doc: Doc; clipId: string } {
  const { t } = target
  const tgt = target.clip
  const locked = new Set(doc.tracks.filter((tr) => tr.locked).map((tr) => tr.id))
  const under = (c: Clip) => c.start <= t + 1e-6 && clipEnd(c) > t + 1e-6 && !locked.has(c.track_id)

  // The clip and anything linked to it that's playing at that moment.
  const groupIds = new Set(withLinked([tgt.id], doc.clips).filter((id) => {
    const c = doc.clips.find((x) => x.id === id)!
    return under(c)
  }))
  const tracks = new Set(doc.clips.filter((c) => groupIds.has(c.id)).map((c) => c.track_id))
  const rightLink = new Map<string, string>()
  const relink = (l: string | null | undefined) => (l ? (rightLink.get(l) ?? rightLink.set(l, uid('l_')).get(l)!) : null)

  const out: Clip[] = []
  let still: Clip | null = null
  for (const c of doc.clips) {
    if (groupIds.has(c.id)) {
      const left = t - c.start
      const srcT = c.in_point + left * c.speed
      if (left >= MIN_CLIP) {
        out.push({ ...c, duration: left, fade_out: 0, transition: null })
      }
      const keepLeft = left >= MIN_CLIP
      out.push({
        ...c,
        id: keepLeft ? uid('c_') : c.id,
        start: t + duration,
        duration: c.duration - left,
        in_point: srcT,
        fade_in: 0,
        keyframes: shiftKeyframes(c.keyframes, -left) ?? {},
        markers: shiftMarkers(c.markers ?? [], -left),
        link: keepLeft ? relink(c.link) : c.link,
      })
      if (c.id === tgt.id) {
        still = {
          ...c,
          id: uid('c_'),
          type: 'image',
          asset_id: imageAssetId,
          start: t,
          duration,
          in_point: 0,
          hold: false,
          audio_detached: false,
          speed: 1,
          volume: 1,
          muted: false,
          fade_in: 0,
          fade_out: 0,
          transform: transformAt(c, t),
          keyframes: {},
          markers: [],
          transition: null,
          link: null,
          trackers: [],
          follow: null,
          pin: null,
          stabilize: null,
          roto: null,
        }
      }
    } else if (tracks.has(c.track_id) && c.start >= t - 1e-6) {
      out.push({ ...c, start: c.start + duration }) // ripple: make room on the same track
    } else {
      out.push(c)
    }
  }
  return { doc: { ...doc, clips: [...out, still!] }, clipId: still!.id }
}
