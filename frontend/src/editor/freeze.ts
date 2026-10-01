import type { Clip } from '../api/types'
import { uid } from '../lib/format'
import { shiftKeyframes, shiftMarkers, transformAt } from './keyframes'
import { clipEnd, type Doc, MIN_CLIP, withLinked } from './store'

export const FREEZE_SECONDS = 2

/**
 * Freeze frame: split the video clip under the playhead and put a still of
 * that frame between the halves (`duration` long). The rest of the clip, and
 * everything after it on its track, moves right to make room; clips linked to
 * it (e.g. its separated audio) are split and moved the same way, leaving a
 * silent gap. The still keeps the clip's look at that moment (keyframed
 * transform values become static) and is silent.
 * Returns the new doc + the still's id, or an error message.
 */
export function freezeFrame(doc: Doc, selection: string[], t: number, duration = FREEZE_SECONDS): { doc: Doc; clipId: string } | string {
  const fps = doc.settings.fps
  t = Math.round(t * fps) / fps
  const locked = new Set(doc.tracks.filter((tr) => tr.locked).map((tr) => tr.id))
  const rank = new Map(doc.tracks.map((tr, i) => [tr.id, i]))
  const under = (c: Clip) => c.start <= t + 1e-6 && clipEnd(c) > t + 1e-6 && !locked.has(c.track_id)
  const videos = doc.clips.filter((c) => c.type === 'video' && !c.hold && c.asset_id && under(c))
  if (!videos.length) return 'Put the playhead over a video clip to freeze its frame'
  const target =
    videos.find((c) => selection.includes(c.id)) ?? [...videos].sort((a, b) => (rank.get(a.track_id) ?? 0) - (rank.get(b.track_id) ?? 0))[0]

  // The clip and anything linked to it that's playing at that moment.
  const groupIds = new Set(withLinked([target.id], doc.clips).filter((id) => {
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
      if (c.id === target.id) {
        still = {
          ...c,
          id: uid('c_'),
          start: t,
          duration,
          in_point: srcT,
          hold: true,
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
