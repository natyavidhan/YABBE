import { ArrowRightLeft, CopyCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { ApiImg } from '../lib/apiImage'
import { useMediaQuery } from '../lib/useMedia'
import { api } from '../api/client'
import { toast } from '../components/toast'
import { Button, NumberInput, Spinner } from '../components/ui'
import { cuts, transitionLength, useEditor } from './store'
import { useTransitionCatalog } from './transitionCatalog'
import { Section } from '../components/Section'

/** Inspector for the selected transition (identified by the clip it leaves). */
export function TransitionPanel({ clipId }: { clipId: string }) {
  const doc = useEditor((s) => s.doc)
  const assets = useEditor((s) => s.assets)
  const catalog = useTransitionCatalog()
  const cut = cuts(doc).find((c) => c.a.id === clipId)
  const t = cut?.a.transition
  const [category, setCategory] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const coarse = useMediaQuery('(pointer: coarse)')
  const { setTransition, selectTransition, beginGesture, endGesture } = useEditor.getState()
  const locked = doc.tracks.find((tr) => tr.id === cut?.a.track_id)?.locked ?? false

  if (!cut || !t)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted">
        <ArrowRightLeft size={18} className="text-faint" />
        This transition no longer applies — its clips don’t touch any more.
        <Button size="sm" onClick={() => selectTransition(null)}>
          OK
        </Button>
      </div>
    )

  const label = (c: typeof cut.a) =>
    c.type === 'text' ? (c.text?.content.split('\n')[0] ?? 'Text') : (assets.find((a) => a.id === c.asset_id)?.original_name ?? 'Clip')
  const maxD = Math.min(catalog?.max_duration ?? 5, cut.a.duration, cut.b.duration)
  const minD = catalog?.min_duration ?? 0.1
  const current = catalog?.transitions.find((x) => x.id === t.kind)
  const cat = category ?? current?.category ?? catalog?.categories[0] ?? 'Basic'
  const list = catalog?.transitions.filter((x) => x.category === cat) ?? []
  const effective = transitionLength(cut.a, cut.b)

  const applyAll = () => {
    const targets = cuts(doc).filter((c) => c.a.track_id === cut.a.track_id)
    beginGesture()
    for (const c of targets)
      setTransition(c.a.id, { kind: t.kind, duration: Math.min(t.duration, c.a.duration, c.b.duration) })
    endGesture()
    toast.success(`Applied “${current?.name ?? t.kind}” to ${targets.length} cut${targets.length === 1 ? '' : 's'}`)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent-2 uppercase">
          Transition
        </span>
        <span className="truncate text-xs font-medium" title={`${label(cut.a)} → ${label(cut.b)}`}>
          {label(cut.a)} → {label(cut.b)}
        </span>
      </div>

      <Section icon={<ArrowRightLeft size={14} />} title="Transition settings">
        <p className="-mt-1 text-[11px] text-faint">{current?.name ?? t.kind} · centred on the cut</p>
        <div className="flex items-center gap-2">
          <span className="w-14 text-xs text-muted">Duration</span>
          <input
            type="range"
            min={minD}
            max={Math.max(minD, maxD)}
            step={0.05}
            value={Math.min(t.duration, maxD)}
            disabled={locked}
            onPointerDown={beginGesture}
            onPointerUp={endGesture}
            onChange={(e) => setTransition(cut.a.id, { ...t, duration: Number(e.target.value) })}
            className="min-w-0 flex-1"
            aria-label="Transition duration"
          />
          <div className="w-20 shrink-0">
            <NumberInput
              value={effective}
              onChange={(v) => !locked && setTransition(cut.a.id, { ...t, duration: Math.max(minD, Math.min(maxD, v)) })}
              step={0.05}
              min={minD}
              max={maxD}
              precision={2}
              suffix="s"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted" title="Blend the two clips' sound over the transition">
          <input
            type="checkbox"
            checked={t.audio !== false}
            disabled={locked}
            onChange={(e) => setTransition(cut.a.id, { ...t, audio: e.target.checked })}
            className="accent-accent"
          />
          Crossfade audio
        </label>
        {t.duration > maxD + 1e-6 && (
          <p className="text-[11px] text-warn">Limited to {maxD.toFixed(2)} s by the shorter clip.</p>
        )}
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" disabled={locked} onClick={applyAll} title="Use this transition on every cut of this track">
            <CopyCheck size={13} /> Apply to all cuts
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={locked}
            onClick={() => {
              setTransition(cut.a.id, null)
              selectTransition(null)
            }}
          >
            <Trash2 size={13} /> Remove
          </Button>
        </div>
      </Section>

      {!catalog ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner size={16} />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-2">
            {catalog.categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`shrink-0 rounded-md px-2 py-1 text-xs transition-colors ${
                  c === cat ? 'bg-raised text-fg' : 'text-muted hover:text-fg'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-3">
            {list.map((x) => (
              <button
                key={x.id}
                type="button"
                disabled={locked}
                onPointerEnter={() => setHovered(x.id)}
                onPointerLeave={() => setHovered((h) => (h === x.id ? null : h))}
                onFocus={() => setHovered(x.id)}
                onBlur={() => setHovered((h) => (h === x.id ? null : h))}
                onClick={() => setTransition(cut.a.id, { ...t, kind: x.id })}
                className={`group overflow-hidden rounded-lg border text-left transition-colors ${
                  x.id === t.kind ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong'
                }`}
                title={`Use “${x.name}”`}
              >
                <div className="relative aspect-video w-full bg-bg">
                  {/* Still mid-transition; plays the animated preview on hover (or when chosen).
                      Not lazy-loaded: some browsers never load lazy images inside scroll panes. */}
                  <PreviewImage src={api.transitionPosterUrl(x.id)} />
                  {(hovered === x.id || (x.id === t.kind && (coarse || hovered === null))) && (
                    <PreviewImage src={api.transitionPreviewUrl(x.id)} />
                  )}
                </div>
                <div className="truncate px-2 py-1 text-[11px]">{x.name}</div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Image that fills its tile (loaded via fetch; see lib/apiImage) with a visible failure state. */
function PreviewImage({ src }: { src: string }) {
  return (
    <ApiImg
      url={src}
      alt=""
      decoding="async"
      draggable={false}
      className="absolute inset-0 h-full w-full object-cover"
      fallback={
        <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted">
          Preview unavailable
        </span>
      }
    />
  )
}
