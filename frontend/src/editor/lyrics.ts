/**
 * Lyrics: a lyrics clip shows the words of a song clip (same file), timed to it,
 * on a video track. It's turned on / off from the song clip; turning it on adds
 * the lyrics clip (linked to the song, so they move and trim together) and
 * starts finding + timing the lyrics on the server.
 */
import { create } from 'zustand'
import { api } from '../api/client'
import type { Clip, LyricLine, LyricsStyle } from '../api/types'
import { uid } from '../lib/format'
import { type Doc, makeClip, overlaps, useEditor } from './store'

export const DEFAULT_LYRICS_STYLE: LyricsStyle = {
  preset: 'karaoke',
  layout: 'line',
  lines_shown: 2,
  words_shown: 3,
  word_fx: 'fill',
  line_in: 'fade',
  line_out: 'fade',
  transition_ms: 250,
  font: 'DejaVu Sans',
  size: 72,
  bold: true,
  italic: false,
  case: 'as_is',
  letter_spacing: 0,
  line_spacing: 1.25,
  color: '#ffffff',
  upcoming_color: '#ffffff80',
  past_color: '#ffffff',
  other_lines_opacity: 0.45,
  outline_color: '#000000',
  outline: 3,
  shadow_color: '#00000099',
  shadow: 2,
  blur: 0,
  box: 'none',
  box_color: '#000000aa',
  box_padding: 12,
  active_box_color: null,
  active_scale: 1,
  active_color: null,
  align: 'center',
  anchor: 'bottom',
  margin: 0.08,
  width: 0.85,
  offset_ms: 0,
  lead_ms: 300,
  hold_ms: 600,
}

export interface LyricsPreset {
  id: string
  name: string
  hint: string
  style: Partial<LyricsStyle>
}

/** Starting points; every setting can be changed afterwards. */
export const LYRICS_PRESETS: LyricsPreset[] = [
  { id: 'karaoke', name: 'Karaoke', hint: 'Words fill in as they’re sung', style: {} },
  {
    id: 'highlight', name: 'Highlight', hint: 'A box jumps to the word being sung',
    style: { word_fx: 'highlight', box: 'active', box_color: '#ffffff', active_box_color: '#ffffff', active_color: '#111111',
      upcoming_color: '#ffffff', past_color: '#ffffff', outline: 0, shadow: 2, box_padding: 8 },
  },
  {
    id: 'typewriter', name: 'Typewriter', hint: 'Words appear one by one',
    style: { word_fx: 'reveal', font: 'DejaVu Sans Mono', bold: false, case: 'lower', line_in: 'none', line_out: 'fade', outline: 2 },
  },
  {
    id: 'pop', name: 'Pop', hint: 'Two big words at a time, popping as they’re sung',
    style: { layout: 'words', words_shown: 2, word_fx: 'pop', size: 130, case: 'upper', anchor: 'middle', active_color: '#ffd43b',
      upcoming_color: '#ffffff', line_in: 'zoom', transition_ms: 150, outline: 5 },
  },
  {
    id: 'bounce', name: 'Bounce', hint: 'Each word jumps when it’s sung',
    style: { word_fx: 'bounce', active_color: '#69db7c', active_scale: 1.15, upcoming_color: '#ffffffb3', line_in: 'slide_up' },
  },
  {
    id: 'big', name: 'One word', hint: 'One huge word at a time',
    style: { layout: 'words', words_shown: 1, word_fx: 'none', size: 190, case: 'upper', anchor: 'middle', line_in: 'zoom',
      line_out: 'none', transition_ms: 120, outline: 6, shadow: 4 },
  },
  {
    id: 'scroll', name: 'Scroll', hint: 'The song scrolls by, the current line in the middle',
    style: { layout: 'scroll', lines_shown: 5, word_fx: 'highlight', anchor: 'middle', other_lines_opacity: 0.5, size: 60,
      upcoming_color: '#ffffff', active_color: '#ffd43b', past_color: '#ffffff', transition_ms: 300 },
  },
  {
    id: 'stack', name: 'Next line', hint: 'The current line with the next one under it',
    style: { layout: 'stack', lines_shown: 2, word_fx: 'fill', other_lines_opacity: 0.5, line_in: 'slide_up' },
  },
  {
    id: 'verse', name: 'Verse', hint: 'The whole verse, left aligned, words fading in',
    style: { layout: 'page', lines_shown: 4, word_fx: 'fade', align: 'left', anchor: 'middle', size: 64,
      upcoming_color: '#ffffff59', past_color: '#ffffff', other_lines_opacity: 1 },
  },
  {
    id: 'neon', name: 'Neon', hint: 'The sung word glows',
    style: { word_fx: 'glow', active_color: '#ff2bd6', color: '#ffffff', outline: 1.5, outline_color: '#ff2bd6', shadow: 0,
      upcoming_color: '#ffffff99', past_color: '#ffffff' },
  },
  {
    id: 'boxed', name: 'Boxed', hint: 'Each word on its own label',
    style: { word_fx: 'highlight', box: 'words', box_color: '#000000cc', outline: 0, shadow: 0, active_color: '#ffd43b',
      upcoming_color: '#ffffff', past_color: '#ffffff', box_padding: 10 },
  },
  {
    id: 'subtitle', name: 'Subtitle', hint: 'Plain lines on a dark strip',
    style: { word_fx: 'none', size: 56, bold: false, box: 'line', box_color: '#000000aa', outline: 0, shadow: 0, margin: 0.06,
      box_padding: 14 },
  },
]

export function presetStyle(id: string, keep?: LyricsStyle): LyricsStyle {
  const p = LYRICS_PRESETS.find((x) => x.id === id) ?? LYRICS_PRESETS[0]
  const timing = keep ? { offset_ms: keep.offset_ms, lead_ms: keep.lead_ms, hold_ms: keep.hold_ms } : {}
  return { ...DEFAULT_LYRICS_STYLE, ...p.style, ...timing, preset: p.id }
}

/** Clips that can have lyrics: sound from a real file. */
export function canHaveLyrics(clip: Clip, hasAudio: boolean): boolean {
  return (clip.type === 'audio' || clip.type === 'video') && hasAudio && !!clip.asset_id && !clip.audio_detached && !clip.hold
}

/** The lyrics clips shown for a song clip (same file, same link group). */
export function lyricsClipsOf(doc: Doc, song: Clip): Clip[] {
  return doc.clips.filter((c) => c.type === 'lyrics' && c.asset_id === song.asset_id && !!c.link && c.link === song.link)
}

/** Add a lyrics clip for ``song`` on a video track (a new one at the top if
 * none is free there), linked to it. */
export function addLyricsClip(doc: Doc, song: Clip, style: LyricsStyle = DEFAULT_LYRICS_STYLE): { doc: Doc; clipId: string } {
  const link = song.link ?? uid('l_')
  let tracks = doc.tracks
  let track = tracks.find(
    (t) => t.kind === 'video' && !t.locked && !overlaps(doc.clips, t.id, song.start, song.duration, new Set()),
  )
  if (!track) {
    track = { id: uid('t_'), kind: 'video', name: 'Lyrics', muted: false, hidden: false, locked: false }
    tracks = [track, ...tracks]
  }
  const clip = makeClip({
    track_id: track.id,
    type: 'lyrics',
    asset_id: song.asset_id,
    start: song.start,
    duration: song.duration,
    in_point: song.in_point,
    speed: song.speed,
    link,
    lyrics: { lines: [], style, source: null, isolate: false },
  })
  const clips = doc.clips.map((c) => (c.id === song.id ? { ...c, link } : c))
  return { doc: { ...doc, tracks, clips: [...clips, clip] }, clipId: clip.id }
}

export function removeLyricsClips(doc: Doc, song: Clip): Doc {
  const ids = new Set(lyricsClipsOf(doc, song).map((c) => c.id))
  return { ...doc, clips: doc.clips.filter((c) => !ids.has(c.id)) }
}

/** Song time at a timeline time, for a lyrics clip. */
export function songTime(clip: Clip, t: number): number {
  return clip.in_point + (t - clip.start) * clip.speed
}

/** Timeline time of a song time. */
export function timelineTime(clip: Clip, songT: number): number {
  return clip.start + (songT - clip.in_point) / clip.speed
}

export function visibleLines(clip: Clip): LyricLine[] {
  const lines = clip.lyrics?.lines ?? []
  const a = clip.in_point
  const b = clip.in_point + clip.duration * clip.speed
  return lines.filter((l) => l.end > a && l.start < b)
}

// -- computing (server jobs) ------------------------------------------------------------------

export interface LyricsJobState {
  jobId?: string
  progress: number
  message: string
  error?: string
}

export const useLyricsJobs = create<{ jobs: Record<string, LyricsJobState> }>(() => ({ jobs: {} }))

function setJob(clipId: string, s: LyricsJobState | null) {
  useLyricsJobs.setState((st) => {
    const jobs = { ...st.jobs }
    if (s) jobs[clipId] = s
    else delete jobs[clipId]
    return { jobs }
  })
}

export interface ComputeOptions {
  isolate?: boolean
  lrclib_id?: number
  text?: string
}

/** Find + time the lyrics of a lyrics clip's song (or use the given ones). */
export async function computeLyrics(clipId: string, opts: ComputeOptions = {}): Promise<void> {
  const s = useEditor.getState()
  const clip = s.doc.clips.find((c) => c.id === clipId)
  if (!clip?.asset_id || !s.projectId || clip.type !== 'lyrics') return
  const projectId = s.projectId
  const isolate = opts.isolate ?? clip.lyrics?.isolate ?? false
  const running = useLyricsJobs.getState().jobs[clipId]
  if (running && !running.error) return
  setJob(clipId, { progress: 0, message: 'Starting' })
  try {
    let job = await api.computeLyrics(projectId, clip.asset_id, { isolate, lrclib_id: opts.lrclib_id, text: opts.text })
    setJob(clipId, { jobId: job.id, progress: job.progress, message: job.message })
    while (job.status === 'queued' || job.status === 'running') {
      await new Promise((r) => setTimeout(r, 1000))
      if (!useLyricsJobs.getState().jobs[clipId]) return // turned off meanwhile
      job = await api.getJob(job.id)
      setJob(clipId, { jobId: job.id, progress: job.progress, message: job.message })
    }
    if (job.status === 'cancelled') {
      setJob(clipId, null)
      return
    }
    if (job.status === 'error') throw new Error(job.error ?? 'Couldn’t get the lyrics')
    const result = job.result as { lines: LyricLine[]; source: string } | null
    const now = useEditor.getState()
    const fresh = now.projectId === projectId ? now.doc.clips.find((c) => c.id === clipId) : undefined
    if (fresh?.lyrics) {
      now.updateClip(clipId, { lyrics: { ...fresh.lyrics, lines: result?.lines ?? [], source: result?.source ?? null, isolate } })
    }
    setJob(clipId, null)
  } catch (e) {
    setJob(clipId, { progress: 0, message: '', error: e instanceof Error ? e.message : String(e) })
  }
}

export function cancelLyrics(clipId: string) {
  const j = useLyricsJobs.getState().jobs[clipId]
  if (j?.jobId) api.cancelJob(j.jobId).catch(() => {})
  setJob(clipId, null)
}

/** Turn lyrics on / off for a song clip. Returns an error message or null. */
export function setLyricsOn(songId: string, on: boolean): string | null {
  const s = useEditor.getState()
  const song = s.doc.clips.find((c) => c.id === songId)
  if (!song) return 'Clip not found'
  const existing = lyricsClipsOf(s.doc, song)
  if (on) {
    if (existing.length) return null
    let clipId = ''
    s.change((d) => {
      const r = addLyricsClip(d, d.clips.find((c) => c.id === songId) ?? song)
      clipId = r.clipId
      return r.doc
    })
    void computeLyrics(clipId)
    return null
  }
  existing.forEach((c) => cancelLyrics(c.id))
  s.change((d) => removeLyricsClips(d, d.clips.find((c) => c.id === songId) ?? song))
  s.select(s.selection.filter((id) => !existing.some((c) => c.id === id)))
  return null
}

/** The song clip a lyrics clip belongs to. */
export function songOf(doc: Doc, lyrics: Clip): Clip | undefined {
  return doc.clips.find((c) => c.type !== 'lyrics' && c.asset_id === lyrics.asset_id && !!c.link && c.link === lyrics.link)
}

