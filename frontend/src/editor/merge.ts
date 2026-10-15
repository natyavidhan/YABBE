/**
 * Three-way merge of timelines, for when this editor has unsaved edits and
 * someone else (another tab, an AI agent) saved meanwhile: start from their
 * version and redo what changed here since the last sync - clip by clip,
 * track by track, sequence by sequence. When both changed the same thing,
 * this editor's version wins (the person is looking at it).
 */
import type { Sequence } from '../api/types'

export interface TimelineState {
  name: string
  main: string
  sequences: Sequence[]
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Merge lists of {id} items: base → local changes replayed on remote. */
function mergeById<T extends { id: string }>(base: T[], local: T[], remote: T[], merge?: (b: T, l: T, r: T) => T): T[] {
  const b = new Map(base.map((x) => [x.id, x]))
  const l = new Map(local.map((x) => [x.id, x]))
  const out: T[] = []
  for (const r of remote) {
    const bx = b.get(r.id)
    const lx = l.get(r.id)
    if (bx && !lx) continue // deleted here
    if (!bx || !lx) {
      out.push(r) // added there (or added on both: theirs)
      continue
    }
    if (merge) out.push(merge(bx, lx, r))
    else out.push(same(bx, lx) ? r : lx) // changed here: ours
  }
  const inRemote = new Set(remote.map((x) => x.id))
  local.forEach((lx, i) => {
    if (inRemote.has(lx.id)) return
    const bx = b.get(lx.id)
    if (bx && same(bx, lx)) return // deleted there, untouched here: stays deleted
    // added here (or changed here but deleted there: keep ours), near where it was
    const prev = local[i - 1]
    const at = prev ? out.findIndex((x) => x.id === prev.id) + 1 : 0
    out.splice(at > 0 ? at : i === 0 ? 0 : out.length, 0, lx)
  })
  return out
}

function mergeSequence(base: Sequence, local: Sequence, remote: Sequence): Sequence {
  return {
    ...remote,
    name: base.name !== local.name ? local.name : remote.name,
    settings: same(base.settings, local.settings) ? remote.settings : local.settings,
    tracks: mergeById(base.tracks, local.tracks, remote.tracks),
    clips: mergeById(base.clips, local.clips, remote.clips),
  }
}

export function mergeTimelines(base: TimelineState, local: TimelineState, remote: TimelineState): TimelineState {
  const sequences = mergeById(base.sequences, local.sequences, remote.sequences, mergeSequence)
  const ids = new Set(sequences.map((s) => s.id))
  let main = base.main !== local.main ? local.main : remote.main
  if (!ids.has(main)) main = ids.has(remote.main) ? remote.main : sequences[0]?.id
  return { name: base.name !== local.name ? local.name : remote.name, main, sequences }
}
