import { Clapperboard } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { allSequences, sequenceContains, sequenceDuration, useEditor } from './store'

const HEIGHT = 72
const cache = new Map<string, Promise<string>>() // content key -> blob URL
const MAX_CACHED = 200

// At most two thumbnail renders at a time so they never crowd out the preview.
let running = 0
const waiting: (() => void)[] = []
function limited<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--
          waiting.shift()?.()
        })
    }
    if (running < 2) go()
    else waiting.push(go)
  })
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

// Hash per object identity: unchanged sequences keep their arrays, so edits
// (and drags) elsewhere don't re-serialise them.
const hashes = new WeakMap<object, string>()
const hashOf = (o: object) => hashes.get(o) ?? (hashes.set(o, hash(JSON.stringify(o))), hashes.get(o)!)

/**
 * A small frame from the middle of a sequence (blob URL), or null when it's
 * empty / still loading. Re-rendered after edits to the sequence or anything
 * nested in it, once they are saved (the server renders the saved project).
 */
export function useSequenceThumb(sequenceId: string | null | undefined): string | null {
  const projectId = useEditor((s) => s.projectId)
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const saved = useEditor((s) => s.version === s.savedVersion)
  const job = useMemo(() => {
    const seqs = allSequences(doc)
    const seq = seqs.find((x) => x.id === sequenceId)
    if (!seq || !projectId) return null
    const duration = sequenceDuration(seq)
    if (duration <= 0) return null
    const involved = seqs.filter((x) => x.id === seq.id || sequenceContains(doc, seq.id, x.id))
    const ready = assets.filter((a) => a.status === 'ready').length
    const parts = involved.map((x) => `${x.id}.${hashOf(x.settings)}.${hashOf(x.tracks)}.${hashOf(x.clips)}`)
    const key = `${projectId}:${seq.id}:${ready}:${hash(parts.join('|'))}`
    return { key, id: seq.id, t: duration / 2 }
  }, [doc, assets, sequenceId, projectId])
  const [shown, setShown] = useState<{ id: string; src: string } | null>(null)

  useEffect(() => {
    if (!job || !projectId) return
    let alive = true
    const cached = cache.get(job.key)
    if (!cached && !saved) return // wait for autosave so the server sees the change
    const timer = window.setTimeout(
      () => {
        let p = cache.get(job.key)
        if (!p) {
          p = limited(() => api.frame(projectId, job.t, HEIGHT, { sequence_id: job.id })).then((b) => URL.createObjectURL(b))
          p.catch(() => cache.delete(job.key))
          cache.set(job.key, p)
          if (cache.size > MAX_CACHED) {
            const [oldKey, old] = cache.entries().next().value!
            cache.delete(oldKey)
            old.then((u) => URL.revokeObjectURL(u)).catch(() => {})
          }
        }
        p.then((src) => alive && setShown({ id: job.id, src })).catch(() => {})
      },
      cached ? 0 : 600,
    )
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [job, saved, projectId])

  if (!job) return null
  return shown?.id === job.id ? shown.src : null
}

/** Thumbnail tile for a sequence (falls back to an icon). */
export function SequenceThumb({ sequenceId, active, className = '' }: { sequenceId: string; active?: boolean; className?: string }) {
  const src = useSequenceThumb(sequenceId)
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-md ${
        active ? 'bg-accent text-white ring-1 ring-accent' : 'bg-panel-2 text-muted'
      } ${className}`}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} /> : <Clapperboard size={15} />}
    </span>
  )
}
