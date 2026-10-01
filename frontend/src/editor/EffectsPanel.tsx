import { GripVertical, Plus, Search, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ClipType } from '../api/types'
import { toast } from '../components/toast'
import { addEffectToClips, cannotAdd, EFFECT_MIME, EFFECTS, type EffectDef, kindName } from './effects'
import { useInspectorTab } from './inspectorTab'
import { allSequences, sequenceAsset, useEditor } from './store'

const CATEGORY_ORDER: EffectDef['category'][] = ['Picture', 'Time', 'Keying & masks', 'Motion', 'Audio']
const KIND_SHORT: Record<ClipType, string> = {
  video: 'Video', image: 'Photo', audio: 'Audio', text: 'Text', shape: 'Shape', sequence: 'Nested',
}

/** The Effects tab: browse effects, drag them onto clips (or add to the selection). */
export function EffectsPanel() {
  const [q, setQ] = useState('')
  const selection = useEditor((s) => s.selection)
  const clips = useEditor((s) => s.doc.clips)
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const selected = useMemo(() => clips.filter((c) => selection.includes(c.id)), [clips, selection])
  const assetOf = (c: (typeof selected)[number]) => {
    if (c.type === 'sequence') {
      const seq = allSequences(doc).find((x) => x.id === c.sequence_id)
      return seq ? sequenceAsset(seq) : undefined
    }
    return c.asset_id ? assets.find((a) => a.id === c.asset_id) : undefined
  }
  const query = q.trim().toLowerCase()
  const shown = EFFECTS.filter(
    (e) => !query || e.name.toLowerCase().includes(query) || e.description.toLowerCase().includes(query) || e.category.toLowerCase().includes(query),
  )

  const add = (e: EffectDef) => {
    const msg = addEffectToClips(
      selected.map((c) => c.id),
      e.id,
    )
    if (msg) toast.info(msg)
    else useInspectorTab.getState().setTab('properties')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2 focus-within:border-accent">
          <Search size={13} className="text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search effects"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            aria-label="Search effects"
          />
        </label>
        <p className="mt-1.5 text-[11px] text-faint">
          Drag an effect onto a clip on the timeline{selected.length ? ', or add it to the selected clip' + (selected.length > 1 ? 's' : '') : ''}.
          Its settings then appear in Properties.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {CATEGORY_ORDER.map((cat) => {
          const list = shown.filter((e) => e.category === cat)
          if (!list.length) return null
          return (
            <section key={cat} className="mb-3">
              <h3 className="mb-1 px-1 text-[10px] font-semibold tracking-wide text-faint uppercase">{cat}</h3>
              <ul className="flex flex-col gap-1">
                {list.map((e) => {
                  const why = selected.length
                    ? (selected.map((c) => cannotAdd(e, c, assetOf(c))).find((r) => r) ?? null)
                    : null
                  const fitsSome = selected.some((c) => !cannotAdd(e, c, assetOf(c)))
                  return (
                    <li
                      key={e.id}
                      draggable
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData(EFFECT_MIME, e.id)
                        ev.dataTransfer.setData('text/plain', e.name)
                        ev.dataTransfer.effectAllowed = 'copy'
                      }}
                      className="group flex cursor-grab items-start gap-2 rounded-lg border border-line bg-panel-2 px-2 py-2 hover:border-line-strong active:cursor-grabbing"
                      title={`Drag onto a clip · works on ${e.targets.map(kindName).join(', ')} clips`}
                    >
                      <GripVertical size={13} className="mt-0.5 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
                      <span className="mt-0.5 shrink-0 text-accent-2">{e.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{e.name}</span>
                        <span className="block text-[11px] leading-snug text-faint">{e.description}</span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {e.targets.map((t) => (
                            <span key={t} className="rounded bg-white/5 px-1 text-[9px] font-medium text-muted uppercase">
                              {KIND_SHORT[t]}
                            </span>
                          ))}
                        </span>
                      </span>
                      {selected.length > 0 && (
                        <button
                          type="button"
                          onClick={() => add(e)}
                          disabled={!fitsSome}
                          title={fitsSome ? `Add to the selected clip${selected.length > 1 ? 's' : ''}` : (why ?? '')}
                          aria-label={`Add ${e.name}`}
                          className="flex h-6 shrink-0 items-center gap-0.5 rounded-md border border-line px-1.5 text-[11px] text-muted hover:border-accent hover:text-fg disabled:opacity-35"
                        >
                          <Plus size={11} /> Add
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
        {!shown.length && <p className="px-1 text-xs text-faint">No effect matches “{q}”.</p>}
        <p className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-faint">
          <Sparkles size={11} /> More effects (shake, audio reverb, distortion…) will appear here.
        </p>
      </div>
    </div>
  )
}
