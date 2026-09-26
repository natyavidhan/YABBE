import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Gauge,
  Minus,
  Plus,
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
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { AnimProp, Asset, Clip, Ease } from '../api/types'
import { IconButton, inputClass, NumberInput } from '../components/ui'
import { formatDuration } from '../lib/format'
import { fillScale, sourceSize } from './geometry'
import { allKeyTimes, EASES, framesOf, keyIndexAt, localTime, propAt, textStyleAt } from './keyframes'
import { ProjectSettingsForm } from './ProjectSettings'
import { clipEnd, gapAfter, MAX_SPEED, maxClipDuration, MIN_CLIP, MIN_SPEED, overlaps, speedRange, useEditor, type ClipPatch } from './store'

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
    <div className="grid grid-cols-[84px_1fr] items-center gap-2">
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
  after,
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
  after?: ReactNode
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
        {after}
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
  const playhead = useEditor((s) => s.playhead)
  // Animatable values shown/edited at the playhead (keyframed props auto-key).
  const val = (p: AnimProp) => propAt(clip, p, playhead)
  const setP = (values: Partial<Record<AnimProp, number>>) => {
    if (!locked) useEditor.getState().setProps(clip.id, values)
  }
  const key = (p: AnimProp) => <KeyButton clip={clip} prop={p} disabled={locked} />
  const withKey = (p: AnimProp, input: ReactNode) => (
    <div className="flex min-w-0 items-center gap-1">
      <div className="min-w-0 flex-1">{input}</div>
      {key(p)}
    </div>
  )
  const withoutKeys = (props: AnimProp[]): Clip['keyframes'] => {
    const kf = { ...clip.keyframes }
    for (const p of props) delete kf[p]
    return kf
  }

  const title =
    clip.type === 'text' ? 'Text' : (asset?.original_name ?? 'Missing media')

  // Changing duration/speed must not overlap the next clip or exceed the source.
  const setDuration = (d: number) => {
    const s = useEditor.getState()
    const max = Math.min(maxClipDuration(clip, asset), gapAfter(s.doc.clips, clip))
    set({ duration: Math.max(MIN_CLIP, Math.min(d, max)) })
  }
  const setStart = (start: number) => {
    const s = useEditor.getState()
    if (!overlaps(s.doc.clips, clip.track_id, start, clip.duration, new Set([clip.id]))) set({ start: Math.max(0, start) })
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

      {clip.type === 'text' && clip.text && <TextSection clip={clip} set={set} locked={locked} />}

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
            </>
          )}
        </div>
        {asset && asset.duration > 0 && (
          <p className="text-[11px] text-faint">
            Source {formatDuration(asset.duration)} · ends at {clipEnd(clip).toFixed(2)}s
          </p>
        )}
      </Section>

      {(clip.type === 'video' || clip.type === 'audio') && <SpeedSection clip={clip} locked={locked} />}

      {visual && (
        <Section
          icon={<Move size={14} />}
          title="Transform"
          onReset={() =>
            set({
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip_h: false, flip_v: false },
              keyframes: withoutKeys(['x', 'y', 'scale', 'rotation', 'opacity']),
            })
          }
        >
          <KeyframeBar clip={clip} disabled={locked} />
          <div className="grid grid-cols-2 gap-2">
            {withKey('x', <NumberInput label="X" value={val('x')} onChange={(x) => setP({ x })} step={1} precision={0} suffix="px" {...scrub} />)}
            {withKey('y', <NumberInput label="Y" value={val('y')} onChange={(y) => setP({ y })} step={1} precision={0} suffix="px" {...scrub} />)}
            {withKey(
              'scale',
              <NumberInput
                label="Scale"
                value={val('scale') * 100}
                onChange={(v) => setP({ scale: Math.max(1, v) / 100 })}
                step={1}
                min={1}
                max={2000}
                precision={1}
                suffix="%"
                {...scrub}
              />,
            )}
            {withKey(
              'rotation',
              <NumberInput
                label="Rotate"
                value={val('rotation')}
                onChange={(rotation) => setP({ rotation })}
                step={1}
                min={-3600}
                max={3600}
                precision={1}
                suffix="°"
                {...scrub}
              />,
            )}
          </div>
          <SliderRow
            label="Opacity"
            after={key('opacity')}
            value={val('opacity')}
            min={0}
            max={100}
            step={1}
            precision={0}
            suffix="%"
            display={(v) => Math.round(v * 100)}
            parse={(v) => v / 100}
            onChange={(opacity) => setP({ opacity })}
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
                  onClick={() => setP({ scale: 1, x: 0, y: 0 })}
                  title="Fit inside the canvas"
                >
                  <Minimize size={12} /> Fit
                </button>
                <button
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-fg"
                  onClick={() => size && setP({ scale: Math.round(fillScale(clip, settings, size) * 1000) / 1000, x: 0, y: 0 })}
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
        <Section
          icon={<Volume2 size={14} />}
          title="Audio"
          onReset={() => set({ volume: 1, fade_in: 0, fade_out: 0, muted: false, keyframes: withoutKeys(['volume']) })}
        >
          {!visual && <KeyframeBar clip={clip} disabled={locked} />}
          <SliderRow
            label="Volume"
            after={key('volume')}
            value={val('volume')}
            min={0}
            max={400}
            step={1}
            precision={0}
            suffix="%"
            display={(v) => Math.round(v * 100)}
            parse={(v) => v / 100}
            onChange={(volume) => setP({ volume })}
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

/** ◆ next to an animatable field: add/remove a keyframe at the playhead. */
function KeyButton({ clip, prop, disabled }: { clip: Clip; prop: AnimProp; disabled?: boolean }) {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.doc.settings.fps)
  const frames = framesOf(clip, prop)
  const u = localTime(clip, playhead, fps)
  const inside = u >= -1e-6 && u <= clip.duration + 1e-6
  const onKey = keyIndexAt(frames, u, fps) >= 0
  const label = !inside
    ? 'Move the playhead over this clip to add keyframes'
    : onKey
      ? 'Remove keyframe here'
      : frames
        ? 'Add keyframe here (edits here also add one)'
        : 'Animate: add a keyframe here'
  return (
    <button
      type="button"
      disabled={disabled || !inside}
      onClick={() => useEditor.getState().toggleKey(clip.id, prop)}
      title={label}
      aria-label={label}
      aria-pressed={onKey}
      className={`flex h-7 w-6 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-30 ${
        onKey ? 'text-warn' : frames ? 'text-warn/70 hover:text-warn' : 'text-faint hover:text-fg'
      }`}
    >
      <Diamond size={12} fill={onKey ? 'currentColor' : 'none'} strokeWidth={2.2} />
    </button>
  )
}

/** Keyframe navigation + easing for the keys under the playhead. */
function KeyframeBar({ clip, disabled }: { clip: Clip; disabled?: boolean }) {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.doc.settings.fps)
  const times = allKeyTimes(clip)
  if (!times.length)
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-faint">
        <Diamond size={10} /> Click a diamond to animate a property over time.
      </p>
    )
  const u = localTime(clip, playhead, fps)
  const tol = 0.5 / fps
  const prev = [...times].reverse().find((t) => t < u - tol)
  const next = times.find((t) => t > u + tol)
  const here = (Object.keys(clip.keyframes) as AnimProp[])
    .map((p) => {
      const f = framesOf(clip, p)
      const i = keyIndexAt(f, u, fps)
      return i >= 0 ? f![i] : null
    })
    .filter((k) => k !== null)
  const ease = here[0]?.ease
  const jump = (t: number) => {
    const s = useEditor.getState()
    s.setPlaying(false)
    s.setPlayhead(clip.start + t)
  }
  return (
    <div className="flex items-center gap-1 rounded-md bg-warn/10 px-1.5 py-1">
      <Diamond size={11} className="ml-0.5 text-warn" fill="currentColor" />
      <span className="text-[11px] text-warn">{times.length} key{times.length === 1 ? '' : 's'}</span>
      <IconButton label="Previous keyframe" disabled={prev === undefined} onClick={() => prev !== undefined && jump(prev)} className="h-6! w-6!">
        <ChevronLeft size={14} />
      </IconButton>
      <IconButton label="Next keyframe" disabled={next === undefined} onClick={() => next !== undefined && jump(next)} className="h-6! w-6!">
        <ChevronRight size={14} />
      </IconButton>
      <select
        className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-1 text-[11px] disabled:opacity-40"
        value={ease ?? ''}
        disabled={disabled || !here.length}
        onChange={(e) => useEditor.getState().setKeyEase(clip.id, e.target.value as Ease)}
        title={here.length ? 'Easing from this keyframe to the next' : 'Move to a keyframe to change its easing'}
        aria-label="Keyframe easing"
      >
        {!here.length && <option value="">Easing…</option>}
        {EASES.map((e) => (
          <option key={e.value} value={e.value}>
            {e.label}
          </option>
        ))}
      </select>
      <IconButton
        label="Remove all keyframes"
        disabled={disabled}
        onClick={() => useEditor.getState().clearKeys(clip.id)}
        className="h-6! w-6! hover:text-danger!"
      >
        <X size={13} />
      </IconButton>
    </div>
  )
}

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

/** Press-and-hold repeat for stepper buttons (one undo step per hold). */
function useHoldRepeat() {
  const timer = useRef<number | undefined>(undefined)
  const stop = () => {
    window.clearTimeout(timer.current)
    window.clearInterval(timer.current)
    timer.current = undefined
    useEditor.getState().endGesture()
  }
  useEffect(() => stop, [])
  const start = (fn: () => void) => {
    useEditor.getState().beginGesture()
    fn()
    timer.current = window.setTimeout(() => {
      timer.current = window.setInterval(fn, 70)
    }, 380)
  }
  return { start, stop }
}

/** Speed stepper + "fit to duration": retimes the same footage. */
function SpeedSection({ clip, locked }: { clip: Clip; locked: boolean }) {
  const clips = useEditor((s) => s.doc.clips)
  const { fitClipDuration } = useEditor.getState()
  const [draft, setDraft] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const hold = useHoldRepeat()
  const range = speedRange(clips, clip)
  const footage = clip.duration * clip.speed
  const gap = gapAfter(clips, clip)

  const apply = (wanted: number) => {
    if (locked) return clip.speed
    const got = useEditor.getState().setClipSpeed(clip.id, wanted)
    setNote(
      wanted < got - 1e-6 && range.limitedByNext
        ? `The next clip starts ${gap.toFixed(2)} s after this one, so ${got.toFixed(2)}× is the slowest that fits.`
        : wanted > got + 1e-6 || wanted < got - 1e-6
          ? `Speed is limited to ${MIN_SPEED}×–${MAX_SPEED}×.`
          : null,
    )
    return got
  }
  // Step from the *current* value in the store (holds read it every tick).
  const step = (dir: 1 | -1, big: boolean) => {
    const cur = useEditor.getState().doc.clips.find((c) => c.id === clip.id)?.speed ?? clip.speed
    const inc = big ? 0.25 : 0.05
    apply(Math.round((cur + dir * inc) / inc) * inc)
  }
  const commitDraft = () => {
    if (draft === null) return
    const v = parseFloat(draft)
    if (!Number.isNaN(v) && v > 0) apply(v)
    setDraft(null)
  }

  const stepButton = (dir: 1 | -1) => (
    <button
      type="button"
      disabled={locked || (dir < 0 ? clip.speed <= range.min + 1e-6 : clip.speed >= range.max - 1e-6)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const big = e.shiftKey
        hold.start(() => step(dir, big))
      }}
      onPointerUp={hold.stop}
      onPointerLeave={hold.stop}
      onPointerCancel={hold.stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          step(dir, e.shiftKey)
        }
      }}
      aria-label={dir > 0 ? 'Faster' : 'Slower'}
      title={`${dir > 0 ? 'Faster' : 'Slower'} (hold to repeat, Shift for bigger steps)`}
      className="flex h-full w-8 shrink-0 touch-none items-center justify-center text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-30 pointer-coarse:w-10"
    >
      {dir > 0 ? <Plus size={14} /> : <Minus size={14} />}
    </button>
  )

  return (
    <Section icon={<Gauge size={14} />} title="Speed" onReset={() => apply(1)}>
      <div className="flex items-center gap-2">
        <div className="flex h-8 flex-1 items-stretch overflow-hidden rounded-md border border-line bg-bg focus-within:border-accent">
          {stepButton(-1)}
          <input
            className="tabular w-full min-w-0 border-x border-line bg-transparent text-center text-sm font-medium outline-none"
            value={draft ?? `${Number(clip.speed.toFixed(2))}×`}
            inputMode="decimal"
            aria-label="Speed"
            disabled={locked}
            onFocus={(e) => {
              setDraft(String(Number(clip.speed.toFixed(3))))
              requestAnimationFrame(() => e.target.select())
            }}
            onChange={(e) => setDraft(e.target.value.replace('×', ''))}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              else if (e.key === 'Escape') {
                setDraft(null)
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault()
                step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
                setDraft(null)
              }
            }}
            onWheel={(e) => {
              if (document.activeElement !== e.currentTarget) return
              step(e.deltaY < 0 ? 1 : -1, e.shiftKey)
              setDraft(null)
            }}
          />
          {stepButton(1)}
        </div>
      </div>
      <div className="flex gap-1">
        {SPEED_PRESETS.map((p) => (
          <button
            key={p}
            disabled={locked || p < range.min - 1e-6 || p > range.max + 1e-6}
            onClick={() => apply(p)}
            className={`h-7 flex-1 rounded-md border text-xs transition-colors disabled:opacity-30 ${
              Math.abs(clip.speed - p) < 1e-6 ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-strong'
            }`}
          >
            {p}×
          </button>
        ))}
      </div>
      <Row label="Fit to">
        <NumberInput
          value={clip.duration}
          onChange={(seconds) => {
            if (locked) return
            const got = fitClipDuration(clip.id, seconds)
            const lasts = footage / got
            setNote(
              Math.abs(lasts - seconds) > 0.01
                ? `Couldn't fit ${seconds.toFixed(2)} s — at ${got.toFixed(2)}× it plays for ${lasts.toFixed(2)} s${
                    got === range.min && range.limitedByNext ? ' (the next clip is in the way)' : ''
                  }.`
                : null,
            )
          }}
          step={0.1}
          min={0.01}
          precision={2}
          suffix="s"
        />
      </Row>
      <p className="tabular text-[11px] leading-relaxed text-faint">
        {footage.toFixed(2)} s of footage plays for <span className="text-fg">{clip.duration.toFixed(2)} s</span> at{' '}
        {Number(clip.speed.toFixed(2))}×.
        {range.limitedByNext && ` Slowest that fits before the next clip: ${range.min.toFixed(2)}×.`}
      </p>
      {note && <p className="rounded bg-warn/10 px-2 py-1 text-[11px] text-warn">{note}</p>}
    </Section>
  )
}

const typeBadge: Record<Clip['type'], string> = {
  video: 'bg-clip-video/25 text-[#91a7ff]',
  image: 'bg-clip-image/25 text-[#66d9e8]',
  text: 'bg-clip-text/25 text-[#e599f7]',
  audio: 'bg-clip-audio/25 text-[#8ce99a]',
}

let fontsPromise: Promise<string[]> | null = null

function TextSection({ clip, set, locked }: { clip: Clip; set: (p: ClipPatch) => void; locked: boolean }) {
  const t = clip.text!
  const [fonts, setFonts] = useState<string[]>([])
  const [draft, setDraft] = useState(t.content)
  const { beginGesture, endGesture } = useEditor.getState()
  // Style values shown at the playhead; animated ones auto-key when edited.
  const playhead = useEditor((st) => st.playhead)
  const ts = textStyleAt(clip, playhead) ?? t
  const setP = (values: Partial<Record<AnimProp, number | string | null>>) => {
    if (!locked) useEditor.getState().setProps(clip.id, values)
  }
  const key = (p: AnimProp, disabled = false) => <KeyButton clip={clip} prop={p} disabled={locked || disabled} />
  const bg = ts.background
  const bgAlpha = bg ? bg.slice(7) || 'ff' : 'ff'
  const alphaOptions = [
    ['ff', '100%'],
    ['cc', '80%'],
    ['aa', '67%'],
    ['80', '50%'],
    ['55', '33%'],
    ['00', '0%'],
  ]

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
      <Row label="Size">
        <div className="flex items-center gap-1">
          <div className="w-24">
            <NumberInput value={ts.size} onChange={(size) => setP({ text_size: Math.round(size) })} min={4} max={1000} step={1} precision={0} suffix="px" onScrubStart={beginGesture} onScrubEnd={endGesture} />
          </div>
          {key('text_size')}
        </div>
      </Row>
      <Row label="Colour">
        <div className="flex items-center gap-1">
          <ColorInput value={ts.color} onChange={(color) => setP({ text_color: color })} />
          {key('text_color')}
        </div>
      </Row>
      <Row label="Outline">
        <div className="flex items-center gap-1">
          <ColorInput value={ts.stroke_color} onChange={(c) => setP({ text_stroke_color: c })} />
          {key('text_stroke_color')}
        </div>
      </Row>
      <Row label="Outline width">
        <div className="flex items-center gap-1">
          <div className="w-24">
            <NumberInput value={ts.stroke_width} onChange={(v) => setP({ text_stroke_width: Math.round(v) })} min={0} max={100} step={1} precision={0} suffix="px" onScrubStart={beginGesture} onScrubEnd={endGesture} />
          </div>
          {key('text_stroke_width')}
        </div>
      </Row>
      <Row label="Box">
        <div className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={bg !== null}
            onChange={(e) => {
              if (e.target.checked) set({ text: { background: '#000000aa' } })
              else {
                // Turning the box off also drops its colour animation.
                const keyframes = { ...clip.keyframes }
                delete keyframes.text_background
                set({ text: { background: null }, keyframes })
              }
            }}
            className="mr-1 accent-accent"
            aria-label="Background box"
          />
          {bg !== null && (
            <>
              <ColorInput value={bg.slice(0, 7)} onChange={(c) => setP({ text_background: c + bgAlpha })} />
              <select
                className="h-7 rounded-md border border-line bg-bg px-1 text-xs"
                value={bgAlpha}
                onChange={(e) => setP({ text_background: bg.slice(0, 7) + e.target.value })}
                aria-label="Box opacity"
              >
                {!alphaOptions.some(([v]) => v === bgAlpha) && (
                  <option value={bgAlpha}>{Math.round((parseInt(bgAlpha, 16) / 255) * 100)}%</option>
                )}
                {alphaOptions.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {key('text_background')}
            </>
          )}
        </div>
      </Row>
      {bg !== null && (
        <Row label="Padding">
          <div className="flex items-center gap-1">
            <div className="w-24">
              <NumberInput value={ts.padding} onChange={(v) => setP({ text_padding: Math.round(v) })} min={0} max={500} step={1} precision={0} suffix="px" onScrubStart={beginGesture} onScrubEnd={endGesture} />
            </div>
            {key('text_padding')}
          </div>
        </Row>
      )}
      <SliderRow
        label="Spacing"
        after={key('text_line_spacing')}
        value={ts.line_spacing}
        min={0.5}
        max={3}
        step={0.05}
        precision={2}
        suffix="×"
        onChange={(line_spacing) => setP({ text_line_spacing: line_spacing })}
      />
      <KeyframeBar clip={clip} disabled={locked} />
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
