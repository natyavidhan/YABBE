import { ArrowLeft, Check, Download, Keyboard, Redo2, Settings2, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { Logo } from '../components/Logo'
import { toast } from '../components/toast'
import { Button, IconButton, Modal, Spinner } from '../components/ui'
import { ExportDialog } from '../editor/ExportDialog'
import { useAssetPolling, useAutosave, useShortcuts, useTextMeasurements } from '../editor/hooks'
import { Inspector } from '../editor/Inspector'
import { MediaBin } from '../editor/MediaBin'
import { ProjectSettingsDialog } from '../editor/ProjectSettings'
import { useEditor } from '../editor/store'
import { Timeline } from '../editor/Timeline'
import { Viewer } from '../editor/Viewer'

export default function Editor() {
  const { projectId = '' } = useParams()
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    setStatus('loading')
    api
      .getProject(projectId)
      .then((p) => {
        if (!alive) return
        useEditor.getState().load(p)
        setStatus('ready')
      })
      .catch((e) => {
        if (!alive) return
        if (e?.status === 404) setStatus('missing')
        else {
          toast.error(e)
          navigate('/')
        }
      })
    return () => {
      alive = false
    }
  }, [projectId, navigate])

  if (status === 'loading')
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner size={22} />
      </div>
    )
  if (status === 'missing')
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-muted">This project doesn’t exist (it may have been deleted).</p>
        <Link to="/">
          <Button>
            <ArrowLeft size={15} /> Back to projects
          </Button>
        </Link>
      </div>
    )
  return <EditorShell projectId={projectId} />
}

function EditorShell({ projectId }: { projectId: string }) {
  const flush = useAutosave(projectId)
  useAssetPolling(projectId)
  useTextMeasurements()
  useShortcuts()

  const name = useEditor((s) => s.doc.name)
  const [exporting, setExporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [timelineHeight, setTimelineHeight] = useState(() => {
    const saved = Number(localStorageGet('yabbe.timelineHeight'))
    return saved > 120 ? saved : 300
  })

  useEffect(() => {
    document.title = `${name || 'Untitled'} · YABBE`
  }, [name])

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = timelineHeight
    let last = startH
    const move = (ev: PointerEvent) => {
      last = Math.min(window.innerHeight - 220, Math.max(160, startH - (ev.clientY - startY)))
      setTimelineHeight(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      localStorageSet('yabbe.timelineHeight', String(last))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <Link to="/" onClick={() => flush()} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" title="All projects">
          <ArrowLeft size={16} />
        </Link>
        <Logo compact />
        <span className="mx-1 text-faint">/</span>
        <ProjectName />
        <SaveIndicator />
        <div className="flex-1" />
        <UndoRedo />
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
          <Keyboard size={16} />
        </IconButton>
        <IconButton label="Project settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={16} />
        </IconButton>
        <Button
          variant="primary"
          size="sm"
          className="ml-1 h-8"
          onClick={async () => {
            await flush()
            setExporting(true)
          }}
        >
          <Download size={14} /> Export
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
          <MediaBin projectId={projectId} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <Viewer projectId={projectId} />
        </main>
        <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-panel">
          <Inspector />
        </aside>
      </div>

      <div
        onPointerDown={startResize}
        className="group relative h-1.5 shrink-0 cursor-row-resize border-t border-line bg-panel"
        title="Drag to resize"
      >
        <div className="absolute inset-x-0 -top-1 h-2 group-hover:bg-accent/30" />
      </div>
      <div style={{ height: timelineHeight }} className="shrink-0">
        <Timeline projectId={projectId} />
      </div>

      {exporting && <ExportDialog projectId={projectId} onClose={() => setExporting(false)} />}
      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function ProjectName() {
  const name = useEditor((s) => s.doc.name)
  const rename = useEditor((s) => s.rename)
  const [draft, setDraft] = useState<string | null>(null)
  const ref = useRef<HTMLInputElement>(null)
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== name) rename(draft.trim())
    setDraft(null)
  }
  return (
    <input
      ref={ref}
      value={draft ?? name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') ref.current?.blur()
        if (e.key === 'Escape') {
          setDraft(null)
          setTimeout(() => ref.current?.blur())
        }
      }}
      className="w-56 truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 font-medium outline-none hover:border-line focus:border-accent focus:bg-bg"
      aria-label="Project name"
      maxLength={120}
    />
  )
}

function SaveIndicator() {
  const dirty = useEditor((s) => s.version !== s.savedVersion)
  return (
    <span className="flex items-center gap-1 text-xs text-faint" aria-live="polite">
      {dirty ? (
        <>
          <Spinner size={10} /> Saving…
        </>
      ) : (
        <>
          <Check size={12} /> Saved
        </>
      )}
    </span>
  )
}

function UndoRedo() {
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  return (
    <>
      <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Undo2 size={16} />
      </IconButton>
      <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Redo2 size={16} />
      </IconButton>
    </>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Previous / next frame (Shift: 1 s)'],
  ['Home / End', 'Jump to start / end'],
  ['S or Ctrl+B', 'Split at playhead'],
  ['Delete', 'Delete selected clips'],
  ['Ctrl+D', 'Duplicate selected clips'],
  ['Ctrl+A', 'Select all clips'],
  ['Shift+Click', 'Add / remove clip from selection'],
  ['T', 'Add a text clip at the playhead'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['+ / − or Ctrl+Wheel', 'Zoom timeline'],
  ['Esc', 'Clear selection'],
]

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd>
            </dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
