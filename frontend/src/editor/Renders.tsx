import { CheckCircle2, Clock, Layers, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import type { Job, PrerenderQuality, SequenceRenderStatus } from '../api/types'
import type { MenuItem } from '../components/ContextMenu'
import { toast } from '../components/toast'
import { IconButton, ProgressBar, Spinner } from '../components/ui'
import { formatBytes } from '../lib/format'
import { allSequences, useEditor } from './store'

/** Pre-render status of every sequence + this project's background jobs. */
interface RendersState {
  projectId: string
  status: Record<string, SequenceRenderStatus>
  jobs: Job[]
  auto: boolean
  refresh: () => Promise<void>
}

export const useRenders = create<RendersState>()((set, get) => ({
  projectId: '',
  status: {},
  jobs: [],
  auto: true,
  refresh: async () => {
    const id = get().projectId
    if (!id) return
    try {
      const [rows, jobs] = await Promise.all([api.prerenders(id), api.listJobs(id)])
      if (get().projectId !== id) return
      set({
        status: Object.fromEntries(rows.map((r) => [r.sequence_id, r])),
        jobs: jobs.filter((j) => j.kind === 'prerender' || j.kind === 'export'),
      })
    } catch {
      /* offline for a moment: the next poll catches up */
    }
  },
}))

export const QUALITY_LABEL: Record<PrerenderQuality, string> = { draft: 'Draft', preview: '720p', full: 'Full' }
const QUALITY_HINT: Record<PrerenderQuality, string> = {
  draft: 'Draft (480p)',
  preview: 'Preview (720p)',
  full: 'Full quality',
}

/** Poll while the editor is open: quickly while something renders. */
export function useRenderPolling(projectId: string) {
  const busy = useRenders((s) => s.jobs.some((j) => j.status === 'queued' || j.status === 'running'))
  const version = useEditor((s) => s.savedVersion)
  useEffect(() => {
    if (useRenders.getState().projectId !== projectId) useRenders.setState({ projectId, status: {}, jobs: [] })
  }, [projectId])
  useEffect(() => {
    useRenders.getState().refresh()
    const id = window.setInterval(() => useRenders.getState().refresh(), busy ? 1500 : 4000)
    return () => window.clearInterval(id)
  }, [projectId, busy, version])
}

export interface RenderSummary {
  state: 'rendering' | 'queued' | 'fresh' | 'stale' | 'none'
  quality?: PrerenderQuality
  progress: number
  text: string
}

export function summarize(st: SequenceRenderStatus | undefined): RenderSummary {
  const q = st?.qualities ?? []
  const rendering = q.find((x) => x.state === 'rendering')
  if (rendering)
    return {
      state: 'rendering',
      quality: rendering.quality,
      progress: rendering.progress,
      text: `Pre-rendering (${QUALITY_HINT[rendering.quality]}) · ${Math.round(rendering.progress * 100)}%`,
    }
  const queued = q.find((x) => x.state === 'queued')
  if (queued) return { state: 'queued', quality: queued.quality, progress: 0, text: `Waiting to pre-render (${QUALITY_HINT[queued.quality]})` }
  const fresh = [...q].reverse().find((x) => x.state === 'fresh')
  if (fresh)
    return {
      state: 'fresh',
      quality: fresh.quality,
      progress: 1,
      text: `Pre-rendered: ${QUALITY_HINT[fresh.quality]}, ${fresh.height}p · ${formatBytes(fresh.size)} — plays from the pre-render`,
    }
  if (q.some((x) => x.state === 'stale'))
    return { state: 'stale', progress: 0, text: 'Pre-render out of date — changed since it was made; rendered live until it’s redone' }
  return { state: 'none', progress: 0, text: '' }
}

/** Small status marker for a sequence (panel rows, nested clips). */
export function RenderBadge({ sequenceId, iconOnly = false }: { sequenceId: string; iconOnly?: boolean }) {
  const sum = summarize(useRenders((s) => s.status[sequenceId]))
  if (sum.state === 'none') return null
  const size = iconOnly ? 10 : 11
  const body =
    sum.state === 'rendering' ? (
      <>
        <RefreshCw size={size} className="animate-spin" />
        {!iconOnly && `${Math.round(sum.progress * 100)}%`}
      </>
    ) : sum.state === 'queued' ? (
      <Clock size={size} />
    ) : sum.state === 'fresh' ? (
      <>
        <CheckCircle2 size={size} />
        {!iconOnly && QUALITY_LABEL[sum.quality!]}
      </>
    ) : (
      <>
        <RefreshCw size={size} />
        {!iconOnly && 'Stale'}
      </>
    )
  const color =
    sum.state === 'fresh' ? 'text-ok' : sum.state === 'stale' ? 'text-warn' : sum.state === 'rendering' ? 'text-accent-2' : 'text-muted'
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium tabular-nums ${iconOnly ? 'text-white/85' : color}`}
      title={sum.text}
      aria-label={sum.text}
      data-render-state={sum.state}
    >
      {body}
    </span>
  )
}

export async function startPrerender(sequenceId: string, quality: PrerenderQuality) {
  const { projectId, refresh } = useRenders.getState()
  try {
    const job = await api.startPrerender(projectId, sequenceId, quality)
    if (!job) toast.info('Already pre-rendered — nothing changed since')
    await refresh()
  } catch (e) {
    toast.error(e)
  }
}

export async function clearPrerenders(sequenceId: string) {
  const { projectId, refresh } = useRenders.getState()
  try {
    await api.clearPrerender(projectId, sequenceId)
    await refresh()
  } catch (e) {
    toast.error(e)
  }
}

/** Context-menu entries for pre-rendering a sequence. */
export function prerenderMenuItems(sequenceId: string, empty: boolean): MenuItem[] {
  const st = useRenders.getState().status[sequenceId]
  const has = st?.qualities.some((q) => q.state !== 'none')
  return [
    ...(['draft', 'preview', 'full'] as PrerenderQuality[]).map((q) => ({
      label: `Pre-render ${QUALITY_HINT[q].replace(/^./, (c) => c.toLowerCase())}`,
      icon: <Layers size={13} />,
      disabled: empty,
      onSelect: () => startPrerender(sequenceId, q),
    })),
    { label: 'Clear pre-renders', icon: <Trash2 size={13} />, disabled: !has, onSelect: () => clearPrerenders(sequenceId) },
  ]
}

/** Header button + popover: running renders with progress/cancel, stored pre-renders, auto toggle. */
export function RenderQueueButton() {
  const [open, setOpen] = useState(false)
  const jobs = useRenders((s) => s.jobs)
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const running = active.find((j) => j.status === 'running')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <IconButton label={active.length ? `Renders (${active.length} running)` : 'Renders'} onClick={() => setOpen(!open)} active={open}>
        <span className="relative">
          {running ? <RefreshCw size={16} className="animate-spin text-accent-2" /> : <Layers size={16} />}
          {active.length > 0 && (
            <span className="absolute -top-1.5 -right-2 rounded-full bg-accent px-1 text-[9px] leading-3.5 font-semibold text-white">
              {active.length}
            </span>
          )}
        </span>
      </IconButton>
      {open && <RenderQueue />}
    </div>
  )
}

function RenderQueue() {
  const { jobs, status, auto, projectId, refresh } = useRenders()
  const doc = useEditor((s) => s.doc)
  const seqs = allSequences(doc)
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const recent = jobs.filter((j) => j.status === 'error' || j.status === 'cancelled').slice(0, 3)
  const stored = seqs
    .map((seq) => ({ seq, rows: (status[seq.id]?.qualities ?? []).filter((q) => q.state === 'fresh') }))
    .filter((x) => x.rows.length)
  const total = stored.reduce((n, x) => n + x.rows.reduce((m, r) => m + r.size, 0), 0)

  const toggleAuto = async () => {
    const next = !auto
    useRenders.setState({ auto: next })
    try {
      await api.setAutoPrerender(projectId, next)
    } catch (e) {
      useRenders.setState({ auto: !next })
      toast.error(e)
    }
  }
  const cancel = async (job: Job) => {
    try {
      await api.cancelJob(job.id)
      await refresh()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Renders"
      className="fixed top-12 right-2 z-50 flex max-h-[70vh] w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60"
    >
      <div className="border-b border-line px-3 py-2 text-xs font-semibold tracking-wide text-muted uppercase">Renders</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="px-3 py-2">
          {active.length === 0 ? (
            <p className="py-1 text-xs text-faint">Nothing rendering.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {active.map((j) => (
                <li key={j.id}>
                  <div className="flex items-center gap-2">
                    {j.status === 'running' ? <Spinner size={11} /> : <Clock size={12} className="text-faint" />}
                    <span className="min-w-0 flex-1 truncate text-xs" title={j.label}>
                      {j.label}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums">
                      {j.status === 'queued' ? 'queued' : `${Math.round(j.progress * 100)}%`}
                    </span>
                    <button
                      type="button"
                      aria-label={`Cancel ${j.label}`}
                      onClick={() => cancel(j)}
                      className="rounded p-0.5 text-faint hover:bg-white/10 hover:text-fg"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {j.status === 'running' && (
                    <>
                      <ProgressBar value={j.progress} className="mt-1" />
                      {j.message && <div className="mt-0.5 truncate text-[11px] text-faint">{j.message}</div>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {recent.map((j) => (
            <div key={j.id} className="mt-1.5 truncate text-[11px] text-faint" title={j.error ?? undefined}>
              {j.label}: {j.status === 'error' ? <span className="text-danger">{j.error ?? 'failed'}</span> : 'cancelled'}
            </div>
          ))}
        </section>

        <section className="border-t border-line px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted">
            <span>Pre-rendered sequences</span>
            {total > 0 && <span className="text-faint">{formatBytes(total)}</span>}
          </div>
          {stored.length === 0 ? (
            <p className="text-xs text-faint">None yet. Pre-render a sequence from its menu in the Sequences panel.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {stored.map(({ seq, rows }) => (
                <li key={seq.id} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{seq.name}</span>
                  <span className="text-[11px] text-muted">{rows.map((r) => QUALITY_LABEL[r.quality]).join(' · ')}</span>
                  <button
                    type="button"
                    aria-label={`Clear pre-renders of ${seq.name}`}
                    title="Delete these pre-renders"
                    onClick={() => clearPrerenders(seq.id)}
                    className="rounded p-0.5 text-faint hover:bg-white/10 hover:text-fg"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <label className="flex cursor-pointer items-start gap-2 border-t border-line px-3 py-2.5">
          <input type="checkbox" checked={auto} onChange={toggleAuto} className="mt-0.5 accent-(--color-accent)" />
          <span className="text-xs">
            Pre-render nested sequences automatically
            <span className="block text-[11px] text-faint">
              Makes a draft of each sequence used inside another a few seconds after you stop editing it, so
              playback doesn’t have to render it live.
            </span>
          </span>
        </label>
      </div>
    </div>
  )
}
