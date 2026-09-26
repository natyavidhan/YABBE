import { AlertTriangle, CheckCircle2, Download, Film, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { ExportRecord, Job, Quality } from '../api/types'
import { toast } from '../components/toast'
import { Button, Field, IconButton, Modal, ProgressBar, Spinner } from '../components/ui'
import { formatBytes, formatDuration, formatRelative } from '../lib/format'
import { docDuration, useEditor } from './store'

const QUALITIES: { value: Quality; label: string; hint: string }[] = [
  { value: 'high', label: 'High', hint: 'Best quality, slower, bigger file' },
  { value: 'medium', label: 'Balanced', hint: 'Good quality, reasonable size' },
  { value: 'low', label: 'Draft', hint: 'Fast, small file' },
]

export function ExportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const settings = useEditor((s) => s.doc.settings)
  const duration = useEditor((s) => docDuration(s.doc))
  const pendingMedia = useEditor((s) =>
    s.assets.filter((a) => a.status === 'processing' && s.doc.clips.some((c) => c.asset_id === a.id)).length,
  )
  const [height, setHeight] = useState<number | null>(null)
  const [quality, setQuality] = useState<Quality>('medium')
  const [exports, setExports] = useState<ExportRecord[]>([])
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  const [starting, setStarting] = useState(false)

  const heights = [settings.height, 2160, 1440, 1080, 720, 480, 360]
    .filter((h, i, arr) => h <= settings.height && arr.indexOf(h) === i)
    .sort((a, b) => b - a)
  const width = (h: number) => Math.round((settings.width * h) / settings.height / 2) * 2

  const refresh = useCallback(async () => {
    try {
      const [ex, js] = await Promise.all([api.listExports(projectId), api.listJobs(projectId)])
      setExports(ex)
      setJobs(Object.fromEntries(js.filter((j) => j.kind === 'export').map((j) => [j.id, j])))
    } catch (e) {
      toast.error(e)
    }
  }, [projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const active = exports.some((e) => e.status === 'rendering')
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(refresh, 1000)
    return () => window.clearInterval(id)
  }, [active, refresh])

  const start = async () => {
    setStarting(true)
    try {
      await api.startExport(projectId, { height: height === settings.height ? null : height, quality })
      await refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal title="Export video" onClose={onClose} width="max-w-xl">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Resolution">
            <select
              className="h-8 rounded-md border border-line bg-bg px-2 text-fg outline-none focus:border-accent"
              value={height ?? settings.height}
              onChange={(e) => setHeight(Number(e.target.value))}
            >
              {heights.map((h) => (
                <option key={h} value={h}>
                  {width(h)}×{h}
                  {h === settings.height ? ' (project)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Format" group>
            <div className="flex h-8 items-center rounded-md border border-line px-2.5 text-muted">
              MP4 · H.264 + AAC · {settings.fps} fps
            </div>
          </Field>
        </div>
        <Field label="Quality" group>
          <div className="grid grid-cols-3 gap-2">
            {QUALITIES.map((q) => (
              <button
                key={q.value}
                onClick={() => setQuality(q.value)}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  quality === q.value ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'
                }`}
              >
                <div className="text-sm font-medium">{q.label}</div>
                <div className="mt-0.5 hidden text-[11px] text-muted sm:block">{q.hint}</div>
              </button>
            ))}
          </div>
        </Field>

        {pendingMedia > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle size={14} /> {pendingMedia} media file{pendingMedia === 1 ? ' is' : 's are'} still processing.
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">Duration {formatDuration(duration)}</span>
          <Button variant="primary" onClick={start} disabled={starting || duration <= 0 || pendingMedia > 0}>
            {starting ? <Spinner size={14} /> : <Film size={15} />} Start export
          </Button>
        </div>

        {exports.length > 0 && (
          <div className="border-t border-line pt-3">
            <h3 className="mb-2 text-xs font-semibold text-muted">Exports</h3>
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
              {exports.map((ex) => (
                <ExportRow key={ex.id} projectId={projectId} record={ex} job={ex.job_id ? jobs[ex.job_id] : undefined} onChanged={refresh} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ExportRow({
  projectId,
  record,
  job,
  onChanged,
}: {
  projectId: string
  record: ExportRecord
  job: Job | undefined
  onChanged: () => void
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2">
      <span className="shrink-0">
        {record.status === 'done' ? (
          <CheckCircle2 size={16} className="text-ok" />
        ) : record.status === 'rendering' ? (
          <Spinner size={14} />
        ) : (
          <AlertTriangle size={16} className="text-danger" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{record.name}</div>
        {record.status === 'rendering' ? (
          <div className="mt-1 flex items-center gap-2">
            <ProgressBar value={job?.progress ?? 0} className="flex-1" />
            <span className="tabular w-9 text-right text-[11px] text-muted">{Math.round((job?.progress ?? 0) * 100)}%</span>
          </div>
        ) : (
          <div className="text-[11px] text-muted">
            {record.status === 'done'
              ? `${formatBytes(record.size)} · ${record.quality} · ${formatRelative(record.created_at)}`
              : record.status === 'cancelled'
                ? 'Cancelled'
                : record.error || 'Failed'}
          </div>
        )}
      </div>
      {record.status === 'done' && (
        <a href={api.downloadExportUrl(projectId, record.id)} download>
          <Button size="sm" variant="secondary">
            <Download size={13} /> Download
          </Button>
        </a>
      )}
      {record.status === 'rendering' && record.job_id && (
        <IconButton
          label="Cancel export"
          onClick={async () => {
            await api.cancelJob(record.job_id!).catch(toast.error)
            onChanged()
          }}
        >
          <X size={14} />
        </IconButton>
      )}
      {record.status !== 'rendering' && (
        <IconButton
          label="Delete export"
          onClick={async () => {
            await api.deleteExport(projectId, record.id).catch(toast.error)
            onChanged()
          }}
        >
          <Trash2 size={13} />
        </IconButton>
      )}
    </li>
  )
}
