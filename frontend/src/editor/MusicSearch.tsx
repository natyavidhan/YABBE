import { Check, Download, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { MusicResult } from '../api/types'
import { toast } from '../components/toast'
import { IconButton, Spinner } from '../components/ui'
import { formatDuration } from '../lib/format'
import { useEditor } from './store'

let available: Promise<{ available: boolean; max_minutes: number } | null> | null = null
const musicInfo = () => (available ??= api.musicInfo().catch(() => null))

/** Videos added in this session (by project), so results show them as added. */
const added = new Map<string, Set<string>>()

/**
 * Search YouTube for music and add a result's audio (the best quality MP3) to
 * the project's media. The server does the search and download with yt-dlp.
 */
export function MusicSearch({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<{ available: boolean; max_minutes: number } | null>(null)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<MusicResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [, bump] = useState(0)
  const abort = useRef<AbortController | null>(null)
  const uploads = useEditor((s) => s.uploads)

  useEffect(() => {
    musicInfo().then(setInfo)
    return () => abort.current?.abort()
  }, [])
  if (!info?.available) return null

  const search = async () => {
    const query = q.trim()
    if (!query) return
    abort.current?.abort()
    const ctl = (abort.current = new AbortController())
    setSearching(true)
    try {
      setResults(await api.musicSearch(query, ctl.signal))
    } catch (e) {
      if (!ctl.signal.aborted) toast.error(e)
    } finally {
      if (abort.current === ctl) setSearching(false)
    }
  }

  const done = added.get(projectId) ?? new Set<string>()
  const busy = new Set(uploads.map((d) => d.id))

  return (
    <div className="mb-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
        className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2 focus-within:border-accent"
      >
        <Search size={13} className="shrink-0 text-faint" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find music on YouTube"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          aria-label="Find music on YouTube"
          enterKeyHint="search"
        />
        {searching ? (
          <Spinner size={12} />
        ) : results ? (
          <button
            type="button"
            onClick={() => {
              setResults(null)
              setQ('')
            }}
            className="text-faint hover:text-fg"
            aria-label="Clear music results"
          >
            <X size={13} />
          </button>
        ) : null}
      </form>

      {results && (
        <div className="mt-2 rounded-lg border border-line bg-panel-2">
          {results.length === 0 && <p className="px-2.5 py-3 text-xs text-faint">Nothing found.</p>}
          <ul className="max-h-56 overflow-y-auto">
            {results.map((r) => {
              const tooLong = r.duration > info.max_minutes * 60
              const state = busy.has(`yt_${r.id}`) ? 'busy' : done.has(r.id) ? 'done' : null
              return (
                <li key={r.id} className="flex items-center gap-2 border-b border-line px-2 py-1.5 last:border-b-0">
                  <img
                    src={r.thumbnail}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-9 w-16 shrink-0 rounded bg-bg object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[11px] leading-snug" title={r.title}>
                      {r.title}
                    </span>
                    <span className="block truncate text-[10px] text-faint">
                      {r.channel ? `${r.channel} · ` : ''}
                      <span className="tabular">{formatDuration(r.duration)}</span>
                    </span>
                  </span>
                  {state === 'busy' ? (
                    <span className="flex h-7 w-7 items-center justify-center text-muted">
                      <Spinner size={12} />
                    </span>
                  ) : state === 'done' ? (
                    <span className="flex h-7 w-7 items-center justify-center text-accent-2" title="Added to media">
                      <Check size={14} />
                    </span>
                  ) : (
                    <IconButton
                      label={tooLong ? `Too long (over ${info.max_minutes} minutes)` : `Add “${r.title}” to media`}
                      disabled={tooLong}
                      className="disabled:opacity-35"
                      onClick={() => {
                        addMusic(projectId, r).then((ok) => {
                          if (ok) {
                            added.set(projectId, new Set(added.get(projectId)).add(r.id))
                            bump((n) => n + 1)
                          }
                        })
                      }}
                    >
                      <Download size={14} />
                    </IconButton>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="px-2.5 py-1.5 text-[10px] text-faint">Added as the best quality MP3. Use only music you’re allowed to use.</p>
        </div>
      )}
    </div>
  )
}

/** Download a result's audio into the project; shown in the media list while it runs. */
async function addMusic(projectId: string, r: MusicResult): Promise<boolean> {
  const id = `yt_${r.id}`
  const { setUploads } = useEditor.getState()
  if (useEditor.getState().uploads.some((u) => u.id === id)) return false
  setUploads((u) => [...u, { id, name: r.title, progress: 0, message: 'Starting' }])
  const patch = (p: Partial<{ progress: number; message: string; jobId: string }>) =>
    setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)))
  try {
    let job = await api.addMusic(projectId, r.id)
    patch({ jobId: job.id })
    while (job.status === 'queued' || job.status === 'running') {
      await new Promise((res) => setTimeout(res, 700))
      job = await api.getJob(job.id)
      patch({ progress: job.progress, message: job.message })
    }
    if (job.status === 'cancelled') return false
    if (job.status === 'error') throw new Error(job.error ?? 'Download failed')
    const s = useEditor.getState()
    if (s.projectId === projectId) s.setAssets((await api.getProject(projectId)).assets)
    return true
  } catch (e) {
    toast.error(`${r.title}: ${e instanceof Error ? e.message : e}`)
    return false
  } finally {
    setUploads((u) => u.filter((x) => x.id !== id))
  }
}
