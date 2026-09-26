import { ArrowLeft, ChartSpline, Check, Download, Film, Keyboard, Redo2, Settings2, SlidersHorizontal, Type, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { Logo } from '../components/Logo'
import { toast } from '../components/toast'
import { Button, IconButton, Modal, Spinner } from '../components/ui'
import { useIsMobile, useMediaQuery } from '../lib/useMedia'
import { ExportDialog } from '../editor/ExportDialog'
import { useAssetPolling, useAutosave, useShortcuts, useTextMeasurements } from '../editor/hooks'
import { Inspector } from '../editor/Inspector'
import { MediaBin } from '../editor/MediaBin'
import { ProjectSettingsDialog } from '../editor/ProjectSettings'
import { useEditor } from '../editor/store'
import { Timeline } from '../editor/Timeline'
import { Viewer } from '../editor/Viewer'
import { GraphEditor } from '../editor/graph/GraphEditor'
import { SequencesPanel, SequenceTabs } from '../editor/Sequences'
import { RenderQueueButton, useRenderPolling, useRenders } from '../editor/Renders'

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
        useRenders.setState({ projectId: p.id, status: {}, jobs: [], auto: p.auto_prerender ?? true })
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
  useRenderPolling(projectId)

  const name = useEditor((s) => s.doc.name)
  const mobile = useIsMobile()
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

  const dialogs = (
    <>
      {exporting && <ExportDialog projectId={projectId} onClose={() => setExporting(false)} />}
      {settingsOpen && <ProjectSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </>
  )
  const openExport = async () => {
    await flush()
    setExporting(true)
  }

  if (mobile)
    return (
      <MobileEditor projectId={projectId} onBack={() => flush()} onExport={openExport}>
        {dialogs}
      </MobileEditor>
    )

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
        <RenderQueueButton />
        <IconButton label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
          <Keyboard size={16} />
        </IconButton>
        <IconButton label="Sequence settings" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={16} />
        </IconButton>
        <Button
          variant="primary"
          size="sm"
          className="ml-1 h-8"
          onClick={openExport}
        >
          <Download size={14} /> Export
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
          <LeftPanel projectId={projectId} />
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
      <div style={{ height: timelineHeight }} className="flex shrink-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <SequenceTabs />
          <div className="min-h-0 flex-1">
            <Timeline projectId={projectId} />
          </div>
        </div>
        <GraphPanel />
      </div>

      {dialogs}
    </div>
  )
}

/** Desktop: resizable graph editor docked to the right of the timeline. */
function GraphPanel() {
  const open = useEditor((s) => s.graphOpen)
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorageGet('yabbe.graphWidth'))
    return saved > 280 ? saved : Math.round(window.innerWidth * 0.45)
  })
  if (!open) return null
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = width
    let last = w0
    const move = (ev: PointerEvent) => {
      last = Math.min(window.innerWidth - 360, Math.max(300, w0 - (ev.clientX - x0)))
      setWidth(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      localStorageSet('yabbe.graphWidth', String(last))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <>
      <div onPointerDown={startResize} className="group relative w-1.5 shrink-0 cursor-col-resize border-l border-line bg-panel" title="Drag to resize">
        <div className="absolute inset-y-0 -left-1 w-2 group-hover:bg-accent/30" />
      </div>
      <div style={{ width }} className="min-w-0 shrink-0">
        <GraphEditor onClose={() => useEditor.getState().setGraphOpen(false)} />
      </div>
    </>
  )
}

/** Left panel: Media bin or the project's sequences. */
function LeftPanel({ projectId, onDone }: { projectId: string; onDone?: () => void }) {
  const [tab, setTab] = useState<'media' | 'sequences'>(() =>
    localStorageGet('yabbe.leftTab') === 'sequences' ? 'sequences' : 'media',
  )
  const pick = (t: 'media' | 'sequences') => {
    setTab(t)
    localStorageSet('yabbe.leftTab', t)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line px-2 pt-2" role="tablist">
        {(['media', 'sequences'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => pick(t)}
            className={`-mb-px rounded-t-md border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              tab === t ? 'border-line border-b-panel bg-panel text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'media' ? <MediaBin projectId={projectId} onAdded={onDone} /> : <SequencesPanel onOpened={onDone} />}
    </div>
  )
}

type SheetKind = 'media' | 'edit' | null

/** Phone layout: preview on top, timeline below, panels as bottom sheets. */
function MobileEditor({
  projectId,
  onBack,
  onExport,
  children,
}: {
  projectId: string
  onBack: () => void
  onExport: () => void
  children: React.ReactNode
}) {
  const [sheet, setSheet] = useState<SheetKind>(null)
  const selected = useEditor((s) => s.selection.length)
  const transSel = useEditor((s) => s.transSel)
  const graphOpen = useEditor((s) => s.graphOpen)
  const closeGraph = () => useEditor.getState().setGraphOpen(false)
  // Tapping a cut's + (or a transition) opens its settings straight away.
  useEffect(() => {
    if (transSel) setSheet('edit')
  }, [transSel])
  const timelineArea = graphOpen ? (
    <GraphEditor compact onClose={closeGraph} />
  ) : (
    <div className="flex h-full flex-col">
      <SequenceTabs />
      <div className="min-h-0 flex-1">
        <Timeline projectId={projectId} />
      </div>
    </div>
  )
  // Landscape phones: preview and timeline side by side, panels slide over the timeline.
  const landscape = useMediaQuery('(orientation: landscape)')
  const PREVIEW_H = '38dvh'
  const sheetStyle: React.CSSProperties = landscape
    ? { top: 48, right: 0, bottom: 0, width: '55vw' }
    : { left: 0, right: 0, bottom: 0, height: `calc(100dvh - ${PREVIEW_H} - 48px)`, minHeight: 280 }
  const tabs = (
    <>
      <TabButton icon={<Film size={18} />} label="Media" compact={landscape} active={sheet === 'media'} onClick={() => setSheet(sheet === 'media' ? null : 'media')} />
      <TabButton
        icon={<Type size={18} />}
        label="Text"
        compact={landscape}
        onClick={() => {
          useEditor.getState().addTextClip()
          setSheet('edit')
        }}
      />
      <TabButton
        icon={<SlidersHorizontal size={18} />}
        label={transSel ? 'Transition' : selected ? 'Edit clip' : 'Settings'}
        compact={landscape}
        badge={selected > 0 || !!transSel}
        active={sheet === 'edit'}
        onClick={() => setSheet(sheet === 'edit' ? null : 'edit')}
      />
      <TabButton
        icon={<ChartSpline size={18} />}
        label="Graph"
        compact={landscape}
        active={graphOpen}
        onClick={() => {
          setSheet(null)
          useEditor.getState().setGraphOpen(!graphOpen)
        }}
      />
    </>
  )
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-panel px-1.5">
        <Link to="/" onClick={onBack} className="rounded-md p-2 text-muted hover:text-fg" aria-label="All projects">
          <ArrowLeft size={18} />
        </Link>
        <ProjectName className="min-w-0 flex-1" />
        <SaveIndicator compact />
        <UndoRedo />
        <RenderQueueButton />
        <Button variant="primary" size="sm" className="ml-1 h-8" onClick={onExport} aria-label="Export">
          <Download size={14} />
        </Button>
      </header>

      {landscape ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[45vw] shrink-0 flex-col border-r border-line bg-bg">
            <Viewer projectId={projectId} compact />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">{timelineArea}</div>
            <nav className="grid shrink-0 grid-cols-4 border-t border-line bg-panel">{tabs}</nav>
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col bg-bg" style={{ height: PREVIEW_H, minHeight: 200 }}>
            <Viewer projectId={projectId} compact />
          </div>
          <div className="min-h-0 flex-1 border-t border-line">{timelineArea}</div>
          <nav className="grid shrink-0 grid-cols-4 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">{tabs}</nav>
        </>
      )}

      {sheet && (
        <div
          className={`toast-in fixed z-40 flex flex-col border-line-strong bg-panel shadow-2xl shadow-black/70 ${
            landscape ? 'border-l' : 'rounded-t-2xl border-t'
          }`}
          // Covers the timeline + tab bar but leaves the preview visible for live feedback.
          style={sheetStyle}
          role="dialog"
          aria-label={sheet === 'media' ? 'Media' : 'Properties'}
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-xs font-semibold tracking-wide text-muted uppercase">
              {sheet === 'media' ? 'Media' : transSel ? 'Transition' : selected ? 'Clip properties' : 'Sequence settings'}
            </span>
            <IconButton label="Close panel" onClick={() => setSheet(null)} className="h-8! w-8!">
              <X size={18} />
            </IconButton>
          </div>
          <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">
            {sheet === 'media' ? <LeftPanel projectId={projectId} onDone={() => setSheet(null)} /> : <Inspector />}
          </div>
        </div>
      )}
      {children}
    </div>
  )
}

function TabButton({
  icon,
  label,
  onClick,
  active = false,
  badge = false,
  compact = false,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  active?: boolean
  badge?: boolean
  compact?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center justify-center text-[11px] transition-colors ${
        compact ? 'h-10 gap-1.5' : 'h-14 flex-col gap-0.5'
      } ${
        active ? 'text-accent-2' : 'text-muted active:text-fg'
      }`}
    >
      <span className="relative">
        {icon}
        {badge && <span className="absolute -top-0.5 -right-1.5 h-2 w-2 rounded-full bg-accent" />}
      </span>
      {label}
    </button>
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

function ProjectName({ className = 'w-56' }: { className?: string }) {
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
      className={`${className} truncate rounded-md border border-transparent bg-transparent px-1.5 py-1 font-medium outline-none hover:border-line focus:border-accent focus:bg-bg`}
      aria-label="Project name"
      maxLength={120}
    />
  )
}

function SaveIndicator({ compact = false }: { compact?: boolean }) {
  const dirty = useEditor((s) => s.version !== s.savedVersion)
  if (compact)
    return (
      <span className="px-1 text-faint" aria-live="polite" title={dirty ? 'Saving…' : 'Saved'}>
        {dirty ? <Spinner size={10} /> : <Check size={13} />}
      </span>
    )
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
  ['M', 'Add a marker on the selected clip'],
  ['Drag on empty timeline', 'Box-select clips (Shift adds)'],
  ['Right-click a clip', 'Link / unlink, split, duplicate, delete'],
  ['Ctrl+L · Ctrl+Shift+L', 'Link / unlink selected clips (Alt+click picks one linked clip)'],
  ['[ / ]', 'Previous / next marker'],
  ['G', 'Open / close the graph editor'],
  ['F9', 'Easy ease the selected keys (Shift: in, Ctrl+Shift: out)'],
  ['F · Delete · Ctrl+A', 'In the graph: fit view, delete keys, select all'],
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
