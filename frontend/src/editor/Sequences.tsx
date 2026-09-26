import { Clapperboard, Copy, MoreHorizontal, Pencil, Plus, Settings2, Star, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { Sequence } from '../api/types'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { toast } from '../components/toast'
import { Button, Field, inputClass, Modal } from '../components/ui'
import { formatDuration } from '../lib/format'
import { FPS_PRESETS, RESOLUTION_PRESETS } from '../lib/presets'
import { ProjectSettingsDialog } from './ProjectSettings'
import { prerenderMenuItems, RenderBadge } from './Renders'
import { SequenceThumb } from './SequenceThumb'
import { allSequences, sequenceDuration, useEditor } from './store'

export const SEQUENCE_MIME = 'application/x-yabbe-sequence'

/** Left-panel list of every sequence in the project. */
export function SequencesPanel({ onOpened }: { onOpened?: () => void }) {
  const doc = useEditor((s) => s.doc)
  const seqs = allSequences(doc)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Sequence | null>(null)
  const [settingsFor, setSettingsFor] = useState(false)
  const s = useEditor.getState()

  const open = (id: string) => {
    s.openSequence(id)
    onOpened?.()
  }
  const addToTimeline = (id: string) => {
    const err = s.addSequenceClip(id)
    if (err) toast.info(err)
    else onOpened?.()
  }
  const usesOf = (id: string) => seqs.reduce((n, x) => n + x.clips.filter((c) => c.type === 'sequence' && c.sequence_id === id).length, 0)
  const items = (seq: Sequence): (MenuItem | 'divider')[] => [
    { label: 'Open', icon: <Clapperboard size={13} />, onSelect: () => open(seq.id) },
    {
      label: 'Add to timeline',
      icon: <Plus size={13} />,
      disabled: seq.id === doc.active,
      onSelect: () => addToTimeline(seq.id),
    },
    { label: 'Rename', icon: <Pencil size={13} />, onSelect: () => setRenaming(seq.id) },
    { label: 'Duplicate', icon: <Copy size={13} />, onSelect: () => s.duplicateSequence(seq.id) },
    {
      label: 'Settings…',
      icon: <Settings2 size={13} />,
      onSelect: () => {
        s.openSequence(seq.id)
        setSettingsFor(true)
      },
    },
    { label: 'Set as main', icon: <Star size={13} />, disabled: seq.id === doc.main, onSelect: () => s.setMainSequence(seq.id) },
    'divider',
    ...prerenderMenuItems(seq.id, sequenceDuration(seq) <= 0),
    'divider',
    {
      label: 'Delete',
      icon: <Trash2 size={13} />,
      danger: true,
      disabled: seq.id === doc.main,
      onSelect: () => setConfirmDelete(seq),
    },
  ]

  return (
    <>
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-xs text-muted">
          {seqs.length} sequence{seqs.length === 1 ? '' : 's'}
        </span>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={13} /> New sequence
        </Button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {seqs.map((seq) => {
          const active = seq.id === doc.active
          return (
            <li
              key={seq.id}
              draggable={seq.id !== doc.active}
              onDragStart={(e) => {
                e.dataTransfer.setData(SEQUENCE_MIME, seq.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title={seq.id === doc.active ? undefined : 'Drag onto the timeline to use it inside the open sequence'}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: seq.id, x: e.clientX, y: e.clientY })
              }}
              className={`group mb-1 flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                active ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:bg-raised'
              }`}
            >
              <button type="button" onClick={() => open(seq.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                <SequenceThumb sequenceId={seq.id} active={active} className="h-8 w-14" />
                <span className="min-w-0 flex-1">
                  {renaming === seq.id ? (
                    <input
                      autoFocus
                      defaultValue={seq.name}
                      maxLength={120}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v && v !== seq.name) s.renameSequence(seq.id, v)
                        setRenaming(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setRenaming(null)
                      }}
                      className="h-6 w-full rounded border border-accent bg-bg px-1 text-xs outline-none"
                      aria-label="Sequence name"
                    />
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium" onDoubleClick={() => setRenaming(seq.id)}>
                        {seq.name}
                      </span>
                      {seq.id === doc.main && (
                        <span className="rounded bg-warn/20 px-1 text-[9px] font-semibold text-warn uppercase" title="Main sequence: exported by default and shown on the dashboard">
                          Main
                        </span>
                      )}
                      <span className="ml-auto">
                        <RenderBadge sequenceId={seq.id} />
                      </span>
                    </span>
                  )}
                  <span className="block truncate text-[11px] text-faint">
                    {seq.settings.width}×{seq.settings.height} · {seq.settings.fps} fps · {formatDuration(sequenceDuration(seq))}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`${seq.name} options`}
                onClick={(e) => setMenu({ id: seq.id, x: e.clientX, y: e.clientY })}
                className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-white/5 hover:text-fg pointer-coarse:opacity-100"
              >
                <MoreHorizontal size={14} />
              </button>
            </li>
          )
        })}
      </ul>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={items(seqs.find((x) => x.id === menu.id)!)} />
      )}
      {creating && <NewSequenceDialog onClose={() => setCreating(false)} onCreated={onOpened} />}
      {settingsFor && <ProjectSettingsDialog onClose={() => setSettingsFor(false)} />}
      {confirmDelete && (
        <Modal
          title="Delete sequence?"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  s.deleteSequence(confirmDelete.id)
                  setConfirmDelete(null)
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-muted">
            “<span className="text-fg">{confirmDelete.name}</span>” and everything on its timeline will be removed
            {usesOf(confirmDelete.id) > 0 && (
              <>
                , along with the <span className="text-fg">{usesOf(confirmDelete.id)}</span> clip
                {usesOf(confirmDelete.id) === 1 ? '' : 's'} using it in other sequences
              </>
            )}
            . Media files stay in the project. You can undo this.
          </p>
        </Modal>
      )}
    </>
  )
}

export function NewSequenceDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const current = useEditor((s) => s.doc.settings)
  const count = useEditor((s) => s.doc.sequences.length)
  const [name, setName] = useState(`Sequence ${count + 1}`)
  const presetIndex = RESOLUTION_PRESETS.findIndex((p) => p.width === current.width && p.height === current.height)
  const [preset, setPreset] = useState(presetIndex >= 0 ? presetIndex : -1)
  const [fps, setFps] = useState(current.fps)
  const [background, setBackground] = useState(current.background)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const size = preset >= 0 ? RESOLUTION_PRESETS[preset] : { width: current.width, height: current.height }
    useEditor.getState().createSequence({
      name: name.trim() || 'Sequence',
      settings: { width: size.width, height: size.height, fps, background },
    })
    onCreated?.()
    onClose()
  }

  return (
    <Modal title="New sequence" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <Field label="Canvas">
          <select className={inputClass} value={preset} onChange={(e) => setPreset(Number(e.target.value))}>
            {preset < 0 && <option value={-1}>Same as current ({current.width}×{current.height})</option>}
            {RESOLUTION_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Frame rate" group>
          <div className="flex gap-1.5">
            {[...new Set([...FPS_PRESETS, current.fps])].sort((a, b) => a - b).map((f) => (
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
        <Field label="Background" group>
          <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2">
            <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0" />
            <span className="font-mono text-xs text-muted uppercase">{background}</span>
          </label>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Create sequence
          </Button>
        </div>
      </form>
    </Modal>
  )
}

/** Tabs of open sequences above the timeline. */
export function SequenceTabs() {
  const doc = useEditor((s) => s.doc)
  const tabs = useEditor((s) => s.openTabs)
  const crumbs = useEditor((s) => s.crumbs)
  const [creating, setCreating] = useState(false)
  const seqs = allSequences(doc)
  const s = useEditor.getState()
  const list = tabs.map((id) => seqs.find((x) => x.id === id)).filter((x): x is Sequence => !!x)
  if (!list.some((x) => x.id === doc.active)) {
    const cur = seqs.find((x) => x.id === doc.active)
    if (cur) list.push(cur)
  }
  return (
    <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-bg px-1.5" role="tablist" aria-label="Open sequences">
      {crumbs.length > 0 && (
        <nav aria-label="Nested in" className="mr-1 flex h-7 shrink-0 items-center gap-0.5 text-[11px] text-muted">
          {crumbs.map((id, i) => {
            const seq = seqs.find((x) => x.id === id)
            if (!seq) return null
            return (
              <span key={id + i} className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    s.openSequence(id)
                    useEditor.setState({ crumbs: crumbs.slice(0, i) })
                  }}
                  className="rounded px-1 py-0.5 hover:bg-raised hover:text-fg"
                  title={`Back to ${seq.name}`}
                >
                  {seq.name}
                </button>
                <span className="text-faint">›</span>
              </span>
            )
          })}
        </nav>
      )}
      {list.map((seq) => {
        const active = seq.id === doc.active
        return (
          <div
            key={seq.id}
            role="tab"
            aria-selected={active}
            className={`group flex h-7 shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 pr-1 pl-2.5 text-xs transition-colors ${
              active ? 'border-line bg-panel text-fg' : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            <button type="button" onClick={() => s.openSequence(seq.id)} className="flex items-center gap-1.5">
              <Clapperboard size={12} className={active ? 'text-accent-2' : ''} />
              <span className="max-w-40 truncate">{seq.name}</span>
              {seq.id === doc.main && <Star size={10} className="text-warn" aria-label="Main sequence" />}
            </button>
            {list.length > 1 && (
              <button
                type="button"
                aria-label={`Close ${seq.name} tab`}
                onClick={() => s.closeTab(seq.id)}
                className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg pointer-coarse:opacity-100"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => setCreating(true)}
        aria-label="New sequence"
        title="New sequence"
        className="mb-0.5 ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
      >
        <Plus size={13} />
      </button>
      {creating && <NewSequenceDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
