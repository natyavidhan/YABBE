import { Copy, Download, Film, MoreHorizontal, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { ProjectSummary } from '../api/types'
import { Logo } from '../components/Logo'
import { toast } from '../components/toast'
import { Button, Field, inputClass, Modal, ProgressBar, Spinner } from '../components/ui'
import { formatDuration, formatRelative } from '../lib/format'
import { FPS_PRESETS, RESOLUTION_PRESETS } from '../lib/presets'


export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState<number | null>(null)
  const [bust] = useState(() => Date.now())
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const refresh = useCallback(() => {
    api.listProjects().then(setProjects).catch((e) => {
      toast.error(e)
      setProjects([])
    })
  }, [])

  useEffect(() => {
    document.title = 'Projects · YABBE'
    refresh()
  }, [refresh])

  const onImport = async (file: File) => {
    setImporting(0)
    try {
      const project = await api.importPackage(file, setImporting)
      toast.success(`Imported “${project.name}”`)
      refresh()
    } catch (e) {
      toast.error(e)
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <Logo />
          <div className="flex-1" />
          <input
            ref={fileRef}
            type="file"
            accept=".yabbe,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) onImport(f)
            }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={importing !== null} aria-label="Import project">
            {importing !== null ? <Spinner size={14} /> : <Upload size={15} />}
            <span className={importing !== null ? '' : 'hidden sm:inline'}>
              {importing !== null ? `${Math.round(importing * 100)}%` : 'Import project'}
            </span>
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New<span className="hidden sm:inline"> project</span>
          </Button>
        </div>
        {importing !== null && <ProgressBar value={importing} className="rounded-none" />}
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          {projects && projects.length > 0 && (
            <span className="text-muted">
              {projects.length} project{projects.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {projects === null ? (
          <div className="flex justify-center py-24 text-muted">
            <Spinner size={22} />
          </div>
        ) : projects.length === 0 ? (
          <EmptyState onCreate={() => setCreating(true)} onImport={() => fileRef.current?.click()} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 sm:gap-5">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} bust={bust} onChanged={refresh} onOpen={() => navigate(`/p/${p.id}`)} />
            ))}
          </div>
        )}
      </main>

      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/p/${id}`)}
        />
      )}
    </div>
  )
}

function EmptyState({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line px-6 py-20 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/15 text-accent-2">
        <Film size={22} />
      </div>
      <h2 className="text-base font-semibold">No projects yet</h2>
      <p className="mt-1 max-w-sm text-muted">
        Create a project to start editing, or import a <code className="text-fg">.yabbe</code> file exported from another
        YABBE server.
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={onImport}>
          <Upload size={15} /> Import project
        </Button>
        <Button variant="primary" onClick={onCreate}>
          <Plus size={16} /> New project
        </Button>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  bust,
  onOpen,
  onChanged,
}: {
  project: ProjectSummary
  bust: number
  onOpen: () => void
  onChanged: () => void
}) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [thumbOk, setThumbOk] = useState(project.has_thumbnail)
  const aspect = project.width / project.height

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  const duplicate = async () => {
    try {
      await api.duplicateProject(project.id)
      toast.success('Project duplicated')
      onChanged()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors duration-150 hover:border-line-strong">
      <button onClick={onOpen} className="relative block aspect-video overflow-hidden bg-bg" aria-label={`Open ${project.name}`}>
        {thumbOk ? (
          <img
            src={api.thumbnailUrl(project.id, bust)}
            alt=""
            onError={() => setThumbOk(false)}
            className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div
              className="flex items-center justify-center rounded border border-line bg-panel-2 text-faint"
              style={{ height: aspect >= 1 ? 56 / aspect : 72, width: aspect >= 1 ? 56 : 72 * aspect }}
            >
              <Film size={16} />
            </div>
          </div>
        )}
        {project.duration > 0 && (
          <span className="tabular absolute right-2 bottom-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium">
            {formatDuration(project.duration)}
          </span>
        )}
      </button>
      <div className="flex items-start gap-2 px-3.5 py-3">
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate font-medium">{project.name}</div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {project.width}×{project.height} · edited {formatRelative(project.updated_at)}
          </div>
        </button>
        <div className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMenu((m) => !m)
            }}
            className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg"
            aria-label="Project actions"
          >
            <MoreHorizontal size={16} />
          </button>
          {menu && (
            <div className="toast-in absolute right-0 bottom-full z-20 mb-1 w-48 overflow-hidden rounded-lg border border-line bg-raised py-1 shadow-xl shadow-black/50">
              <MenuItem icon={<Pencil size={14} />} onClick={() => setRenaming(true)}>
                Rename
              </MenuItem>
              <MenuItem icon={<Copy size={14} />} onClick={duplicate}>
                Duplicate
              </MenuItem>
              <a
                href={api.packageUrl(project.id)}
                download
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/5"
              >
                <Download size={14} className="text-muted" /> Export .yabbe
              </a>
              <div className="my-1 border-t border-line" />
              <MenuItem icon={<Trash2 size={14} />} danger onClick={() => setConfirmDelete(true)}>
                Delete
              </MenuItem>
            </div>
          )}
        </div>
      </div>

      {renaming && <RenameDialog project={project} onClose={() => setRenaming(false)} onDone={onChanged} />}
      {confirmDelete && (
        <Modal
          title="Delete project?"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  try {
                    await api.deleteProject(project.id)
                    toast.success('Project deleted')
                    onChanged()
                  } catch (e) {
                    toast.error(e)
                  }
                  setConfirmDelete(false)
                }}
              >
                Delete forever
              </Button>
            </>
          }
        >
          <p className="text-muted">
            “<span className="text-fg">{project.name}</span>” and all of its media and exports will be permanently removed
            from this server. Export a .yabbe first if you want a backup.
          </p>
        </Modal>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/5 ${danger ? 'text-danger' : ''}`}
    >
      <span className={danger ? '' : 'text-muted'}>{icon}</span>
      {children}
    </button>
  )
}

function RenameDialog({ project, onClose, onDone }: { project: ProjectSummary; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(project.name)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.saveProject(project.id, { name })
      onDone()
      onClose()
    } catch (err) {
      toast.error(err)
    }
  }
  return (
    <Modal title="Rename project" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(0)
  const [fps, setFps] = useState(30)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const { width, height } = RESOLUTION_PRESETS[preset]
      const project = await api.createProject({ name: name.trim() || 'Untitled project', width, height, fps })
      onCreated(project.id)
    } catch (err) {
      toast.error(err)
      setBusy(false)
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input
            className={inputClass}
            value={name}
            placeholder="Untitled project"
            onChange={(e) => setName(e.target.value)}
            autoFocus
            maxLength={120}
          />
        </Field>
        <Field label="Canvas">
          <select className={inputClass} value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {RESOLUTION_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Frame rate" group>
          <div className="flex gap-1.5">
            {FPS_PRESETS.map((f) => (
              <button
                type="button"
                key={f}
                onClick={() => setFps(f)}
                className={`h-8 flex-1 rounded-md border text-xs font-medium transition-colors ${
                  fps === f ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-strong'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && <Spinner size={14} />} Create project
          </Button>
        </div>
      </form>
    </Modal>
  )
}
