import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Crop as CropIcon,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Maximize,
  Minimize,
  MousePointerClick,
  Move,
  RotateCcw,
  Timer,
  Type,
  Volume2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { Asset, Clip } from '../api/types'
import { IconButton, inputClass, NumberInput } from '../components/ui'
import { formatDuration } from '../lib/format'
import { fillScale, sourceSize } from './geometry'
import { ProjectSettingsForm } from './ProjectSettings'
import { clipEnd, maxClipDuration, MIN_CLIP, overlaps, useEditor, type ClipPatch } from './store'

export function Inspector() {
  const selection = useEditor((s) => s.selection)
  const clip = useEditor((s) => (s.selection.length === 1 ? s.doc.clips.find((c) => c.id === s.selection[0]) : undefined))
  const asset = useEditor((s) => (clip?.asset_id ? s.assets.find((a) => a.id === clip.asset_id) : undefined))

  if (selection.length > 1)
    return (
      <Empty icon={<MousePointerClick size={18} />} title={`${selection.length} clips selected`}>
        Drag them together on the timeline, or press Delete / Ctrl+D.
      </Empty>
    )
  if (!clip)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelTitle>Project</PanelTitle>
        <div className="p-3">
          <ProjectSettingsForm />
        </div>
        <p className="px-3 pb-4 text-xs leading-relaxed text-faint">
          Select a clip on the timeline or in the preview to edit its position, crop, text or audio.
        </p>
      </div>
    )
  return <ClipInspector key={clip.id} clip={clip} asset={asset} />
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="text-faint">{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="text-xs text-muted">{children}</span>
    </div>
  )
}

function PanelTitle({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-10 items-center border-b border-line px-3 text-xs font-semibold tracking-wide text-muted uppercase">
      {children}
    </div>
  )
}

function Section({
  icon,
  title,
  children,
  onReset,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  onReset?: () => void
}) {
  return (
    <section className="border-b border-line px-3 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-faint">{icon}</span>
        <h3 className="flex-1 text-xs font-semibold">{title}</h3>
        {onReset && (
          <IconButton label={`Reset ${title.toLowerCase()}`} onClick={onReset} className="h-6! w-6!">
            <RotateCcw size={12} />
          </IconButton>
        )}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Slider + number that records a single undo step per drag. */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
  display = (v) => v,
  parse = (v) => v,
  precision = 2,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  suffix?: string
  display?: (v: number) => number
  parse?: (v: number) => number
  precision?: number
}) {
  const { beginGesture, endGesture } = useEditor.getState()
  return (
    <Row label={label}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={display(value)}
          onPointerDown={beginGesture}
          onPointerUp={endGesture}
          onKeyUp={endGesture}
          onChange={(e) => onChange(parse(Number(e.target.value)))}
          className="min-w-0 flex-1"
          aria-label={label}
        />
        <div className="w-[76px] shrink-0">
          <NumberInput
            value={display(value)}
            onChange={(v) => onChange(parse(v))}
            step={step}
            min={min}
            max={max}
            precision={precision}
            suffix={suffix}
          />
        </div>
      </div>
    </Row>
  )
}

function ClipInspector({ clip, asset }: { clip: Clip; asset: Asset | undefined }) {
  const { updateClip, beginGesture, endGesture } = useEditor.getState()
  const settings = useEditor((s) => s.doc.settings)
  const textSizes = useEditor((s) => s.textSizes)
  const locked = useEditor((s) => s.doc.tracks.find((t) => t.id === clip.track_id)?.locked ?? false)
  const set = (patch: ClipPatch) => {
    if (!locked) updateClip(clip.id, patch)
  }
  const assetMap = useMemo(() => new Map(asset ? [[asset.id, asset]] : []), [asset])
  const size = sourceSize(clip, assetMap, textSizes)
  const visual = clip.type !== 'audio'
  const hasAudio = (clip.type === 'audio' || clip.type === 'video') && (asset?.has_audio ?? false)
  const scrub = { onScrubStart: beginGesture, onScrubEnd: endGesture }

  const title =
    clip.type === 'text' ? 'Text' : (asset?.original_name ?? 'Missing media')

  // Changing duration/speed must not overlap the next clip or exceed the source.
  const setDuration = (d: number) => {
    const s = useEditor.getState()
    const max = Math.min(maxClipDuration(clip, asset), nextGap(s.doc.clips, clip))
    set({ duration: Math.max(MIN_CLIP, Math.min(d, max)) })
  }
  const setStart = (start: number) => {
    const s = useEditor.getState()
    if (!overlaps(s.doc.clips, clip.track_id, start, clip.duration, new Set([clip.id]))) set({ start: Math.max(0, start) })
  }
  const setSpeed = (speed: number) => {
    // Keep the same source range: timeline duration scales inversely.
    const srcLen = clip.duration * clip.speed
    let duration = srcLen / speed
    const s = useEditor.getState()
    duration = Math.min(duration, nextGap(s.doc.clips, clip))
    set({ speed, duration: Math.max(MIN_CLIP, duration) })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex h-10 items-center gap-2 border-b border-line px-3">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${typeBadge[clip.type]}`}>
          {clip.type === 'image' ? 'photo' : clip.type}
        </span>
        <span className="truncate font-medium" title={title}>
          {title}
        </span>
      </div>
      {locked && <div className="bg-warn/10 px-3 py-2 text-xs text-warn">This clip is on a locked track.</div>}

      {clip.type === 'text' && clip.text && <TextSection clip={clip} set={set} />}

      <Section icon={<Timer size={14} />} title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput label="Start" value={clip.start} onChange={setStart} step={0.1} min={0} precision={2} suffix="s" {...scrub} scrubScale={0.2} />
          <NumberInput label="Length" value={clip.duration} onChange={setDuration} step={0.1} min={MIN_CLIP} precision={2} suffix="s" {...scrub} scrubScale={0.2} />
          {(clip.type === 'video' || clip.type === 'audio') && (
            <>
              <NumberInput
                label="In"
                value={clip.in_point}
                onChange={(v) => {
                  const maxIn = Math.max(0, (asset?.duration ?? Infinity) - clip.duration * clip.speed)
                  set({ in_point: Math.max(0, Math.min(v, maxIn)) })
                }}
                step={0.1}
                min={0}
                precision={2}
                suffix="s"
                {...scrub}
                scrubScale={0.2}
              />
              <NumberInput label="Speed" value={clip.speed} onChange={setSpeed} step={0.05} min={0.25} max={4} precision={2} suffix="×" {...scrub} scrubScale={0.2} />
            </>
          )}
        </div>
        {asset && asset.duration > 0 && (
          <p className="text-[11px] text-faint">
            Source {formatDuration(asset.duration)} · ends at {clipEnd(clip).toFixed(2)}s
          </p>
        )}
      </Section>

      {visual && (
        <Section
          icon={<Move size={14} />}
          title="Transform"
          onReset={() => set({ transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false } })}
        >
          <div className="grid grid-cols-2 gap-2">
            <NumberInput label="X" value={clip.transform.x} onChange={(x) => set({ transform: { x } })} step={1} precision={0} suffix="px" {...scrub} />
            <NumberInput label="Y" value={clip.transform.y} onChange={(y) => set({ transform: { y } })} step={1} precision={0} suffix="px" {...scrub} />
            <NumberInput
              label="Scale"
              value={clip.transform.scale * 100}
              onChange={(v) => set({ transform: { scale: Math.max(1, v) / 100 } })}
              step={1}
              min={1}
              max={2000}
              precision={1}
              suffix="%"
              {...scrub}
            />
            <NumberInput
              label="Rotate"
              value={clip.transform.rotation}
              onChange={(rotation) => set({ transform: { rotation } })}
              step={1}
              min={-360}
              max={360}
              precision={1}
              suffix="°"
              {...scrub}
            />
          </div>
          <SliderRow
            label="Opacity"
            value={clip.transform.opacity}
            min={0}
            max={100}
            step={1}
            precision={0}
            suffix="%"
            display={(v) => Math.round(v * 100)}
            parse={(v) => v / 100}
            onChange={(opacity) => set({ transform: { opacity } })}
          />
          <div className="flex items-center gap-1">
            <IconButton label="Flip horizontally" active={clip.transform.flip_h} onClick={() => set({ transform: { flip_h: !clip.transform.flip_h } })}>
              <FlipHorizontal2 size={15} />
            </IconButton>
            <IconButton label="Flip vertically" active={clip.transform.flip_v} onClick={() => set({ transform: { flip_v: !clip.transform.flip_v } })}>
              <FlipVertical2 size={15} />
            </IconButton>
            <div className="flex-1" />
            {clip.type !== 'text' && (
              <>
                <button
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
                  onClick={() => set({ transform: { scale: 1, x: 0, y: 0 } })}
                  title="Fit inside the canvas"
                >
                  <Minimize size={12} /> Fit
                </button>
                <button
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
                  onClick={() => size && set({ transform: { scale: Math.round(fillScale(clip, settings, size) * 1000) / 1000, x: 0, y: 0 } })}
                  title="Fill the whole canvas"
                >
                  <Maximize size={12} /> Fill
                </button>
              </>
            )}
          </div>
        </Section>
      )}

      {(clip.type === 'video' || clip.type === 'image') && (
        <Section icon={<CropIcon size={14} />} title="Crop" onReset={() => set({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })}>
          {(['left', 'right', 'top', 'bottom'] as const).map((side) => {
            const opposite = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' } as const
            const maxV = Math.max(0, 95 - clip.crop[opposite[side]] * 100)
            return (
              <SliderRow
                key={side}
                label={side[0].toUpperCase() + side.slice(1)}
                value={clip.crop[side]}
                min={0}
                max={95}
                step={0.5}
                precision={1}
                suffix="%"
                display={(v) => Math.round(v * 1000) / 10}
                parse={(v) => Math.min(v, maxV) / 100}
                onChange={(v) => set({ crop: { [side]: v } })}
              />
            )
          })}
          {size && (
            <p className="text-[11px] text-faint">
              Result {Math.round(size.width * (1 - clip.crop.left - clip.crop.right))}×
              {Math.round(size.height * (1 - clip.crop.top - clip.crop.bottom))} px of {size.width}×{size.height}
            </p>
          )}
        </Section>
      )}

      {hasAudio && (
        <Section icon={<Volume2 size={14} />} title="Audio" onReset={() => set({ volume: 1, fade_in: 0, fade_out: 0, muted: false })}>
          <SliderRow
            label="Volume"
            value={clip.volume}
            min={0}
            max={400}
            step={1}
            precision={0}
            suffix="%"
            display={(v) => Math.round(v * 100)}
            parse={(v) => v / 100}
            onChange={(volume) => set({ volume })}
          />
          <SliderRow label="Fade in" value={clip.fade_in} min={0} max={Math.min(10, clip.duration)} step={0.1} precision={1} suffix="s" onChange={(fade_in) => set({ fade_in })} />
          <SliderRow label="Fade out" value={clip.fade_out} min={0} max={Math.min(10, clip.duration)} step={0.1} precision={1} suffix="s" onChange={(fade_out) => set({ fade_out })} />
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={clip.muted} onChange={(e) => set({ muted: e.target.checked })} className="accent-accent" />
            Mute this clip
          </label>
        </Section>
      )}
    </div>
  )
}

function nextGap(clips: Clip[], clip: Clip) {
  const next = clips
    .filter((c) => c.track_id === clip.track_id && c.id !== clip.id && c.start >= clipEnd(clip) - 1e-6)
    .reduce((m, c) => Math.min(m, c.start), Infinity)
  return next - clip.start
}

const typeBadge: Record<Clip['type'], string> = {
  video: 'bg-clip-video/25 text-[#91a7ff]',
  image: 'bg-clip-image/25 text-[#66d9e8]',
  text: 'bg-clip-text/25 text-[#e599f7]',
  audio: 'bg-clip-audio/25 text-[#8ce99a]',
}

let fontsPromise: Promise<string[]> | null = null

function TextSection({ clip, set }: { clip: Clip; set: (p: ClipPatch) => void }) {
  const t = clip.text!
  const [fonts, setFonts] = useState<string[]>([])
  const [draft, setDraft] = useState(t.content)
  const { beginGesture, endGesture } = useEditor.getState()

  useEffect(() => {
    fontsPromise ??= api.fonts().catch(() => [])
    fontsPromise.then(setFonts)
  }, [])

  // Typing is committed after a short pause so each keystroke isn't an undo step.
  useEffect(() => setDraft(t.content), [t.content])
  useEffect(() => {
    if (draft === t.content) return
    const id = window.setTimeout(() => set({ text: { content: draft } }), 350)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  return (
    <Section icon={<Type size={14} />} title="Text">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={3}
        className={`${inputClass} h-auto resize-y py-1.5 leading-snug`}
        placeholder="Type something…"
      />
      <Row label="Font">
        <select value={t.font} onChange={(e) => set({ text: { font: e.target.value } })} className={`${inputClass} h-7 text-xs`}>
          {!fonts.includes(t.font) && <option value={t.font}>{t.font}</option>}
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Style">
        <div className="flex items-center gap-1">
          <div className="w-20">
            <NumberInput value={t.size} onChange={(size) => set({ text: { size: Math.round(size) } })} min={4} max={1000} step={1} precision={0} suffix="px" onScrubStart={beginGesture} onScrubEnd={endGesture} />
          </div>
          <IconButton label="Bold" active={t.bold} onClick={() => set({ text: { bold: !t.bold } })}>
            <Bold size={14} />
          </IconButton>
          <IconButton label="Italic" active={t.italic} onClick={() => set({ text: { italic: !t.italic } })}>
            <Italic size={14} />
          </IconButton>
          <div className="mx-0.5 h-4 w-px bg-line" />
          {(['left', 'center', 'right'] as const).map((a) => (
            <IconButton key={a} label={`Align ${a}`} active={t.align === a} onClick={() => set({ text: { align: a } })}>
              {a === 'left' ? <AlignLeft size={14} /> : a === 'center' ? <AlignCenter size={14} /> : <AlignRight size={14} />}
            </IconButton>
          ))}
        </div>
      </Row>
      <Row label="Colour">
        <ColorInput value={t.color} onChange={(color) => set({ text: { color } })} />
      </Row>
      <Row label="Outline">
        <div className="flex items-center gap-2">
          <ColorInput value={t.stroke_color} onChange={(stroke_color) => set({ text: { stroke_color } })} />
          <div className="w-20">
            <NumberInput value={t.stroke_width} onChange={(v) => set({ text: { stroke_width: Math.round(v) } })} min={0} max={100} step={1} precision={0} suffix="px" />
          </div>
        </div>
      </Row>
      <Row label="Box">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={t.background !== null}
            onChange={(e) => set({ text: { background: e.target.checked ? '#000000aa' : null } })}
            className="accent-accent"
            aria-label="Background box"
          />
          {t.background !== null && (
            <>
              <ColorInput value={t.background.slice(0, 7)} onChange={(c) => set({ text: { background: c + (t.background!.slice(7) || '') } })} />
              <select
                className="h-7 rounded-md border border-line bg-bg px-1 text-xs"
                value={t.background.slice(7) || 'ff'}
                onChange={(e) => set({ text: { background: t.background!.slice(0, 7) + e.target.value } })}
                aria-label="Box opacity"
              >
                <option value="ff">100%</option>
                <option value="cc">80%</option>
                <option value="aa">67%</option>
                <option value="80">50%</option>
                <option value="55">33%</option>
              </select>
              <div className="w-16">
                <NumberInput value={t.padding} onChange={(v) => set({ text: { padding: Math.round(v) } })} min={0} max={500} step={1} precision={0} suffix="px" />
              </div>
            </>
          )}
        </div>
      </Row>
      <SliderRow label="Spacing" value={t.line_spacing} min={0.5} max={3} step={0.05} precision={2} suffix="×" onChange={(line_spacing) => set({ text: { line_spacing } })} />
    </Section>
  )
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-fA-F]{6}/.test(value) ? value.slice(0, 7) : '#ffffff'
  return (
    <label className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-1.5">
      <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0" />
      <span className="font-mono text-[11px] text-muted uppercase">{hex}</span>
    </label>
  )
}
