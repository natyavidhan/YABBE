import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ClipboardPaste,
  Clock,
  Mic,
  Minus,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Type as TypeIcon,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import type { Asset, Clip, LyricLine, LyricsCandidate, LyricsLineFx, LyricsStyle, LyricsWordFx } from '../api/types'
import { Section } from '../components/Section'
import { toast } from '../components/toast'
import { Button, IconButton, inputClass, NumberInput, ProgressBar, Spinner } from '../components/ui'
import { formatDuration } from '../lib/format'
import {
  cancelLyrics,
  canHaveLyrics,
  computeLyrics,
  DEFAULT_LYRICS_STYLE,
  LYRICS_PRESETS,
  lyricsClipsOf,
  presetStyle,
  setLyricsOn,
  songTime,
  timelineTime,
  useLyricsJobs,
  visibleLines,
} from './lyrics'
import { useEditor } from './store'

let infoPromise: Promise<boolean> | null = null
const lyricsAvailable = () => (infoPromise ??= api.lyricsInfo().then((r) => r.available).catch(() => false))
let fontsPromise: Promise<string[]> | null = null

// -- the switch on song clips ------------------------------------------------------------------

/** "Lyrics" on / off for a clip with sound (in its Audio section). */
export function LyricsToggle({ clip, asset, locked }: { clip: Clip; asset: Asset | undefined; locked: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const on = useEditor((s) => lyricsClipsOf(s.doc, clip).length > 0)
  const lyricsClip = useEditor((s) => lyricsClipsOf(s.doc, clip)[0])
  useEffect(() => {
    lyricsAvailable().then(setAvailable)
  }, [])
  if (!canHaveLyrics(clip, asset?.has_audio ?? false) || available === false) return null
  return (
    <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
      <Mic size={13} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs">Lyrics</span>
        <span className="block text-[10px] leading-snug text-faint">
          {on ? 'Shown on their own clip, word by word' : 'Finds the words and times each one (takes a minute or two)'}
        </span>
      </span>
      {on && lyricsClip && (
        <button
          type="button"
          className="text-[11px] text-accent-2 hover:underline"
          onClick={() => useEditor.getState().select([lyricsClip.id])}
        >
          Edit
        </button>
      )}
      <Switch
        label="Lyrics"
        on={on}
        disabled={locked || available === null}
        onChange={(v) => {
          const err = setLyricsOn(clip.id, v)
          if (err) toast.info(err)
        }}
      />
    </div>
  )
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-accent' : 'bg-line-strong'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}

// -- small inputs -------------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={`${inputClass} h-7 w-full text-xs`} aria-label={label}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, ReactNode, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-1">
      {options.map(([v, icon, title]) => (
        <button
          key={v}
          type="button"
          title={title}
          aria-label={title}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`flex h-7 flex-1 items-center justify-center rounded-md border text-xs ${
            value === v ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
          }`}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  suffix = '',
  label,
  scale = 1,
  precision = 0,
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  suffix?: string
  label: string
  scale?: number
  precision?: number
}) {
  const { beginGesture, endGesture } = useEditor.getState()
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value * scale}
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onKeyUp={endGesture}
        onChange={(e) => onChange(Number(e.target.value) / scale)}
        className="min-w-0 flex-1"
        aria-label={label}
      />
      <span className="tabular w-12 shrink-0 text-right text-[11px] text-muted">
        {(value * scale).toFixed(precision)}
        {suffix}
      </span>
    </div>
  )
}

/** Colour with opacity (#rrggbbaa). */
function ColorField({
  value,
  onChange,
  label,
  fallback,
}: {
  value: string | null
  onChange: (v: string | null) => void
  label: string
  /** When set, the colour can be turned off (null = use ``fallback``). */
  fallback?: string
}) {
  const { beginGesture, endGesture } = useEditor.getState()
  const shown = value ?? fallback ?? '#ffffff'
  const rgb = shown.slice(0, 7)
  const alpha = shown.length >= 9 ? parseInt(shown.slice(7, 9), 16) / 255 : 1
  const hex = (a: number) =>
    Math.round(Math.max(0, Math.min(1, a)) * 255)
      .toString(16)
      .padStart(2, '0')
  const off = fallback !== undefined && value === null
  return (
    <div className="flex items-center gap-1.5">
      {fallback !== undefined && (
        <input
          type="checkbox"
          checked={!off}
          onChange={(e) => onChange(e.target.checked ? fallback : null)}
          className="accent-accent"
          aria-label={`${label} on`}
        />
      )}
      <label className={`flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 ${off ? 'opacity-40' : ''}`}>
        <input
          type="color"
          value={rgb}
          disabled={off}
          onPointerDown={beginGesture}
          onBlur={endGesture}
          onChange={(e) => onChange(e.target.value + (alpha < 1 ? hex(alpha) : ''))}
          className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
          aria-label={label}
        />
        <span className="font-mono text-[10px] text-muted uppercase">{off ? 'auto' : rgb}</span>
      </label>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(alpha * 100)}
        disabled={off}
        onPointerDown={beginGesture}
        onPointerUp={endGesture}
        onChange={(e) => {
          const a = Number(e.target.value) / 100
          onChange(rgb + (a < 1 ? hex(a) : ''))
        }}
        className={`min-w-0 flex-1 ${off ? 'opacity-40' : ''}`}
        aria-label={`${label} opacity`}
        title="Opacity"
      />
      <span className="tabular w-8 shrink-0 text-right text-[10px] text-faint">{Math.round(alpha * 100)}%</span>
    </div>
  )
}

// -- the lyrics clip ------------------------------------------------------------------------------

const LAYOUTS: [LyricsStyle['layout'], string][] = [
  ['line', 'One line at a time'],
  ['stack', 'Line + the next ones'],
  ['scroll', 'Scrolling list'],
  ['words', 'A few words at a time'],
  ['page', 'Whole verse'],
]
const WORD_FX: [LyricsWordFx, string][] = [
  ['fill', 'Fill (karaoke wipe)'],
  ['highlight', 'Highlight (colour switch)'],
  ['reveal', 'Appear when sung'],
  ['fade', 'Fade to the sung colour'],
  ['pop', 'Pop'],
  ['bounce', 'Bounce'],
  ['glow', 'Glow'],
  ['none', 'Nothing (static)'],
]
const LINE_FX: [LyricsLineFx, string][] = [
  ['none', 'Cut'],
  ['fade', 'Fade'],
  ['slide_up', 'Slide up'],
  ['slide_down', 'Slide down'],
  ['slide_left', 'Slide sideways'],
  ['drop', 'Drop'],
  ['zoom', 'Zoom'],
  ['blur', 'Blur'],
]

export function LyricsSection({ clip, asset, locked }: { clip: Clip; asset: Asset | undefined; locked: boolean }) {
  const lyrics = clip.lyrics
  const style: LyricsStyle = { ...DEFAULT_LYRICS_STYLE, ...lyrics?.style }
  const job = useLyricsJobs((s) => s.jobs[clip.id])
  const [fonts, setFonts] = useState<string[]>([])
  const [panel, setPanel] = useState<'search' | 'paste' | null>(null)
  const set = (patch: Partial<LyricsStyle>) => {
    if (locked || !lyrics) return
    useEditor.getState().updateClip(clip.id, { lyrics: { ...lyrics, style: { ...style, ...patch } } })
  }

  useEffect(() => {
    fontsPromise ??= api.fonts().catch(() => [])
    fontsPromise.then(setFonts)
  }, [])
  // Turned on but never computed (e.g. the page was reloaded meanwhile): carry on.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || locked || !lyrics || lyrics.lines.length || lyrics.source || job) return
    started.current = true
    void computeLyrics(clip.id)
  }, [clip.id, lyrics, job, locked])

  if (!lyrics) return null
  const words = lyrics.lines.reduce((n, l) => n + l.words.length, 0)
  const guessed = lyrics.lines.filter((l) => l.words.length && l.words.every((w) => !w.conf)).length

  return (
    <>
      <Section icon={<Mic size={14} />} title="Lyrics">
        {job && !job.error ? (
          <div className="space-y-1.5 rounded-md bg-accent/10 p-2">
            <div className="flex items-center gap-2 text-xs">
              <Spinner size={12} />
              <span className="flex-1">{job.message || 'Working'}…</span>
              <span className="tabular text-muted">{Math.round(job.progress * 100)}%</span>
              <button type="button" className="text-faint hover:text-fg" aria-label="Stop" onClick={() => cancelLyrics(clip.id)}>
                <X size={12} />
              </button>
            </div>
            <ProgressBar value={job.progress} />
            <p className="text-[10px] text-faint">The first time takes longest: the song is listened to once, then edits are quick.</p>
          </div>
        ) : job?.error ? (
          <div className="space-y-2 rounded-md bg-danger/10 p-2 text-xs">
            <p className="text-danger">{job.error}</p>
            <div className="flex flex-wrap gap-1">
              <Button size="sm" onClick={() => computeLyrics(clip.id)} disabled={locked}>
                <RefreshCw size={12} /> Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('search')}>
                <Search size={12} /> Search
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel('paste')}>
                <ClipboardPaste size={12} /> Paste
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-muted">
            {lyrics.source ? <p className="truncate" title={lyrics.source}>From {lyrics.source}</p> : null}
            {lyrics.lines.length > 0 && (
              <p className="text-faint">
                {lyrics.lines.length} lines · {words} words
                {guessed > 0 && ` · ${guessed} line${guessed === 1 ? '' : 's'} timed by the line only`}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'search' ? null : 'search')} disabled={locked}>
            <Search size={12} /> Other lyrics
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'paste' ? null : 'paste')} disabled={locked}>
            <ClipboardPaste size={12} /> Paste your own
          </Button>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={!!lyrics.isolate}
            disabled={locked || (!!job && !job.error)}
            onChange={(e) => {
              useEditor.getState().updateClip(clip.id, { lyrics: { ...lyrics, isolate: e.target.checked } })
              void computeLyrics(clip.id, { isolate: e.target.checked })
            }}
            className="mt-0.5 accent-accent"
          />
          <span>
            Isolate the vocals first
            <span className="block text-[10px] text-faint">More accurate on loud, busy songs; several times slower.</span>
          </span>
        </label>
        {panel === 'search' && asset && <SearchPanel clip={clip} asset={asset} onDone={() => setPanel(null)} />}
        {panel === 'paste' && <PastePanel clip={clip} onDone={() => setPanel(null)} />}
      </Section>

      <Section icon={<Sparkles size={14} />} title="Lyrics style">
        <div className="grid grid-cols-3 gap-1">
          {LYRICS_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              disabled={locked}
              aria-pressed={style.preset === p.id}
              onClick={() => lyrics && useEditor.getState().updateClip(clip.id, { lyrics: { ...lyrics, style: presetStyle(p.id, style) } })}
              className={`h-8 truncate rounded-md border px-1 text-[11px] ${
                style.preset === p.id ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
              }`}
            >
              {p.name}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-faint">A starting point: everything below can be changed.</p>
        <Row label="Shows">
          <Choice label="Layout" value={style.layout} options={LAYOUTS} onChange={(layout) => set({ layout })} />
        </Row>
        {(style.layout === 'stack' || style.layout === 'scroll' || style.layout === 'page') && (
          <Row label={style.layout === 'page' ? 'Lines per verse' : 'Lines shown'}>
            <Slider label="Lines shown" value={style.lines_shown} min={1} max={8} step={1} onChange={(lines_shown) => set({ lines_shown })} />
          </Row>
        )}
        {style.layout === 'words' && (
          <Row label="Words at once">
            <Slider label="Words at once" value={style.words_shown} min={1} max={12} step={1} onChange={(words_shown) => set({ words_shown })} />
          </Row>
        )}
        <Row label="Sung word">
          <Choice label="Word effect" value={style.word_fx} options={WORD_FX} onChange={(word_fx) => set({ word_fx })} />
        </Row>
        <Row label="Sung size">
          <Slider label="Sung word size" value={style.active_scale} min={50} max={300} step={5} scale={100} suffix="%" onChange={(active_scale) => set({ active_scale })} />
        </Row>
        <Row label="Lines come in">
          <Choice label="Line in" value={style.line_in} options={LINE_FX} onChange={(line_in) => set({ line_in })} />
        </Row>
        <Row label="Lines go">
          <Choice label="Line out" value={style.line_out} options={LINE_FX} onChange={(line_out) => set({ line_out })} />
        </Row>
        <Row label="Speed">
          <Slider label="Transition length" value={style.transition_ms} min={0} max={1500} step={10} suffix="ms" onChange={(transition_ms) => set({ transition_ms })} />
        </Row>
      </Section>

      <Section icon={<TypeIcon size={14} />} title="Lyrics text">
        <Row label="Font">
          <select value={style.font} onChange={(e) => set({ font: e.target.value })} className={`${inputClass} h-7 w-full text-xs`} aria-label="Font">
            {(fonts.includes(style.font) ? fonts : [style.font, ...fonts]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Size">
          <NumberInput value={style.size} min={8} max={600} step={1} precision={0} suffix="px" onChange={(size) => set({ size: Math.round(size) })} />
        </Row>
        <Row label="Style">
          <div className="flex gap-1">
            <IconButton label="Bold" active={style.bold} onClick={() => set({ bold: !style.bold })}>
              <span className="text-xs font-bold">B</span>
            </IconButton>
            <IconButton label="Italic" active={style.italic} onClick={() => set({ italic: !style.italic })}>
              <span className="text-xs italic">I</span>
            </IconButton>
            <div className="min-w-0 flex-1">
              <Choice
                label="Letter case"
                value={style.case}
                options={[
                  ['as_is', 'As written'],
                  ['upper', 'UPPER CASE'],
                  ['lower', 'lower case'],
                  ['title', 'First Letter'],
                ]}
                onChange={(c) => set({ case: c })}
              />
            </div>
          </div>
        </Row>
        <Row label="Letter spacing">
          <Slider label="Letter spacing" value={style.letter_spacing} min={-10} max={60} step={0.5} precision={1} suffix="px" onChange={(letter_spacing) => set({ letter_spacing })} />
        </Row>
        <Row label="Line spacing">
          <Slider label="Line spacing" value={style.line_spacing} min={0.6} max={3} step={0.05} precision={2} suffix="×" onChange={(line_spacing) => set({ line_spacing })} />
        </Row>
        <Row label="Align">
          <Segmented
            value={style.align}
            onChange={(align) => set({ align })}
            options={[
              ['left', <AlignLeft size={13} key="l" />, 'Align left'],
              ['center', <AlignCenter size={13} key="c" />, 'Centre'],
              ['right', <AlignRight size={13} key="r" />, 'Align right'],
            ]}
          />
        </Row>
        <Row label="Place">
          <Segmented
            value={style.anchor}
            onChange={(anchor) => set({ anchor })}
            options={[
              ['top', 'Top', 'Near the top'],
              ['middle', 'Middle', 'In the middle'],
              ['bottom', 'Bottom', 'Near the bottom'],
            ]}
          />
        </Row>
        {style.anchor !== 'middle' && (
          <Row label="Edge gap">
            <Slider label="Gap from the edge" value={style.margin} min={0} max={50} step={1} scale={100} suffix="%" onChange={(margin) => set({ margin })} />
          </Row>
        )}
        <Row label="Text width">
          <Slider label="Text width" value={style.width} min={10} max={100} step={1} scale={100} suffix="%" onChange={(width) => set({ width })} />
        </Row>
        <p className="text-[10px] text-faint">Move, scale, rotate or fade all the lyrics with Transform below.</p>
      </Section>

      <Section icon={<Palette size={14} />} title="Lyrics colours">
        <Row label="Sung">
          <ColorField label="Sung colour" value={style.color} onChange={(c) => set({ color: c ?? style.color })} />
        </Row>
        <Row label="Not sung yet">
          <ColorField label="Upcoming colour" value={style.upcoming_color} onChange={(c) => set({ upcoming_color: c ?? style.upcoming_color })} />
        </Row>
        <Row label="Already sung">
          <ColorField label="Past colour" value={style.past_color} onChange={(c) => set({ past_color: c ?? style.past_color })} />
        </Row>
        <Row label={style.word_fx === 'glow' ? 'Glow' : 'Current word'}>
          <ColorField label="Current word colour" value={style.active_color} fallback={style.word_fx === 'glow' ? '#7c5cff' : style.color} onChange={(c) => set({ active_color: c })} />
        </Row>
        {style.layout !== 'line' && style.layout !== 'words' && (
          <Row label="Other lines">
            <Slider label="Other lines opacity" value={style.other_lines_opacity} min={0} max={100} step={1} scale={100} suffix="%" onChange={(other_lines_opacity) => set({ other_lines_opacity })} />
          </Row>
        )}
        <Row label="Outline">
          <ColorField label="Outline colour" value={style.outline_color} onChange={(c) => set({ outline_color: c ?? style.outline_color })} />
        </Row>
        <Row label="Outline width">
          <Slider label="Outline width" value={style.outline} min={0} max={20} step={0.5} precision={1} suffix="px" onChange={(outline) => set({ outline })} />
        </Row>
        <Row label="Shadow">
          <ColorField label="Shadow colour" value={style.shadow_color} onChange={(c) => set({ shadow_color: c ?? style.shadow_color })} />
        </Row>
        <Row label="Shadow distance">
          <Slider label="Shadow distance" value={style.shadow} min={0} max={20} step={0.5} precision={1} suffix="px" onChange={(shadow) => set({ shadow })} />
        </Row>
        <Row label="Softness">
          <Slider label="Softness" value={style.blur} min={0} max={10} step={0.5} precision={1} onChange={(blur) => set({ blur })} />
        </Row>
      </Section>

      <Section icon={<Square size={14} />} title="Lyrics box">
        <Row label="Box behind">
          <Choice
            label="Box"
            value={style.box}
            onChange={(box) => set({ box })}
            options={[
              ['none', 'No box'],
              ['line', 'Each line'],
              ['words', 'Each word'],
              ['active', 'The sung word only'],
            ]}
          />
        </Row>
        {style.box !== 'none' && (
          <>
            <Row label={style.box === 'active' ? 'Box' : 'Colour'}>
              <ColorField label="Box colour" value={style.box === 'active' ? (style.active_box_color ?? style.box_color) : style.box_color}
                onChange={(c) => set(style.box === 'active' ? { active_box_color: c } : { box_color: c ?? style.box_color })} />
            </Row>
            <Row label="Padding">
              <Slider label="Box padding" value={style.box_padding} min={0} max={60} step={1} suffix="px" onChange={(box_padding) => set({ box_padding })} />
            </Row>
          </>
        )}
      </Section>

      <Section icon={<Clock size={14} />} title="Lyrics timing">
        <Row label="Shift all">
          <div className="flex items-center gap-1">
            <IconButton label="Earlier by 0.1 s" onClick={() => set({ offset_ms: style.offset_ms - 100 })}>
              <Minus size={12} />
            </IconButton>
            <div className="min-w-0 flex-1">
              <NumberInput value={style.offset_ms / 1000} min={-10} max={10} step={0.05} precision={2} suffix="s" onChange={(v) => set({ offset_ms: Math.round(v * 1000) })} />
            </div>
            <IconButton label="Later by 0.1 s" onClick={() => set({ offset_ms: style.offset_ms + 100 })}>
              <Plus size={12} />
            </IconButton>
          </div>
        </Row>
        <Row label="Show early">
          <Slider label="Show a line early" value={style.lead_ms} min={0} max={2000} step={50} suffix="ms" onChange={(lead_ms) => set({ lead_ms })} />
        </Row>
        <Row label="Keep after">
          <Slider label="Keep a line after it ends" value={style.hold_ms} min={0} max={5000} step={50} suffix="ms" onChange={(hold_ms) => set({ hold_ms })} />
        </Row>
      </Section>

      {lyrics.lines.length > 0 && <LinesEditor clip={clip} locked={locked} />}
    </>
  )
}

// -- picking / pasting lyrics -------------------------------------------------------------------------

function SearchPanel({ clip, asset, onDone }: { clip: Clip; asset: Asset; onDone: () => void }) {
  const projectId = useEditor((s) => s.projectId)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<LyricsCandidate[] | null>(null)
  const [busy, setBusy] = useState(false)
  const search = async (query: string) => {
    if (!query.trim()) return
    setBusy(true)
    try {
      setResults(await api.lyricsSearch(query.trim(), asset.duration))
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!projectId) return
    api.lyricsGuess(projectId, asset.id).then((g) => {
      setQ(g.query)
      void search(g.query)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, asset.id])
  return (
    <div className="space-y-1.5 rounded-md border border-line p-2">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void search(q)
        }}
        className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-bg px-2 focus-within:border-accent"
      >
        <Search size={12} className="text-faint" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artist and song" aria-label="Search lyrics"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
        {busy && <Spinner size={11} />}
      </form>
      {results && results.length === 0 && <p className="text-[11px] text-faint">Nothing found. Try other words, or paste the lyrics.</p>}
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {results?.map((r) => {
          const off = asset.duration && r.duration ? Math.abs(r.duration - asset.duration) : 0
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => {
                  void computeLyrics(clip.id, { lrclib_id: r.id })
                  onDone()
                }}
                className="w-full rounded-md border border-line px-2 py-1.5 text-left hover:border-accent"
              >
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-medium">{r.track}</span>
                  {r.instrumental ? (
                    <span className="rounded bg-white/5 px-1 text-[9px] text-muted">INSTRUMENTAL</span>
                  ) : r.synced ? (
                    <span className="rounded bg-accent/20 px-1 text-[9px] text-accent-2">TIMED</span>
                  ) : (
                    <span className="rounded bg-white/5 px-1 text-[9px] text-muted">TEXT ONLY</span>
                  )}
                </span>
                <span className="block truncate text-[10px] text-faint">
                  {r.artist}
                  {r.album ? ` · ${r.album}` : ''} · {formatDuration(r.duration)}
                  {off > 6 ? ` (${Math.round(off)} s off)` : ''}
                </span>
                {r.preview && <span className="block truncate text-[10px] text-muted italic">{r.preview}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="text-[10px] text-faint">Lyrics from LRCLIB, a free community database.</p>
    </div>
  )
}

function PastePanel({ clip, onDone }: { clip: Clip; onDone: () => void }) {
  const [text, setText] = useState('')
  return (
    <div className="space-y-1.5 rounded-md border border-line p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={7}
        placeholder={'One line per line of the song.\nTimed LRC lines like [00:12.50] work too.'}
        className={`${inputClass} w-full resize-y py-1.5 text-xs`}
        aria-label="Lyrics"
      />
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() => {
            void computeLyrics(clip.id, { text })
            onDone()
          }}
        >
          Time these lyrics
        </Button>
      </div>
    </div>
  )
}

// -- editing the words ----------------------------------------------------------------------------------

function LinesEditor({ clip, locked }: { clip: Clip; locked: boolean }) {
  const playhead = useEditor((s) => s.playhead)
  const projectId = useEditor((s) => s.projectId)
  const lyrics = clip.lyrics!
  const offset = (lyrics.style?.offset_ms ?? 0) / 1000
  const shown = useMemo(() => visibleLines(clip), [clip])
  const now = songTime(clip, playhead) - offset
  const current = shown.findIndex((l, i) => l.start <= now && (i + 1 >= shown.length || shown[i + 1].start > now))

  const replace = (old: LyricLine, next: LyricLine | null) => {
    const lines = lyrics.lines.flatMap((l) => (l === old ? (next ? [next] : []) : [l]))
    useEditor.getState().updateClip(clip.id, { lyrics: { ...lyrics, lines } })
  }
  const shift = (line: LyricLine, d: number) =>
    replace(line, {
      ...line,
      start: line.start + d,
      end: line.end + d,
      words: line.words.map((w) => ({ ...w, start: w.start + d, end: w.end + d })),
    })
  const retext = async (line: LyricLine, text: string) => {
    if (!projectId || !clip.asset_id || text === line.text) return
    const i = lyrics.lines.indexOf(line)
    const prev = lyrics.lines[i - 1]
    const next = lyrics.lines[i + 1]
    const a = Math.max(prev ? prev.end - 0.1 : 0, line.start - 0.6)
    const b = next ? Math.min(next.start + 0.1, line.end + 1.5) : line.end + 1.5
    try {
      const timed = await api.retimeLyricLine(projectId, clip.asset_id, { text, start: Math.max(0, a), end: b })
      const fresh = useEditor.getState().doc.clips.find((c) => c.id === clip.id)?.lyrics
      if (!fresh) return
      const lines = fresh.lines.map((l, k) => (k === i ? (text.trim() ? timed : null) : l)).filter((l): l is LyricLine => !!l)
      useEditor.getState().updateClip(clip.id, { lyrics: { ...fresh, lines } })
    } catch (e) {
      toast.error(e)
    }
  }
  const addLine = () => {
    const t = now
    const line: LyricLine = { text: 'New line', start: t, end: t + 2, words: [{ text: 'New', start: t, end: t + 0.8, conf: 0 }, { text: 'line', start: t + 1, end: t + 1.8, conf: 0 }] }
    const lines = [...lyrics.lines, line].sort((x, y) => x.start - y.start)
    useEditor.getState().updateClip(clip.id, { lyrics: { ...lyrics, lines } })
  }

  return (
    <Section icon={<TypeIcon size={14} />} title="Lyrics words">
      <p className="text-[10px] text-faint">
        Click a time to jump there. Edit a line and its words are timed again. <span className="italic">Slanted</span> words were
        timed from the line only.
      </p>
      <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {shown.map((line, i) => (
          <li
            key={`${line.start}-${i}`}
            className={`rounded-md border px-1.5 py-1 ${i === current ? 'border-accent bg-accent/10' : 'border-line'}`}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="tabular shrink-0 text-[10px] text-accent-2 hover:underline"
                onClick={() => useEditor.getState().setPlayhead(Math.max(0, timelineTime(clip, line.start + offset)))}
                title="Jump here"
              >
                {formatDuration(line.start)}
              </button>
              <div className="flex-1" />
              <IconButton label="Earlier" className="h-5! w-5!" disabled={locked} onClick={() => shift(line, -0.1)}>
                <Minus size={10} />
              </IconButton>
              <IconButton label="Later" className="h-5! w-5!" disabled={locked} onClick={() => shift(line, 0.1)}>
                <Plus size={10} />
              </IconButton>
              <IconButton label="Delete line" className="h-5! w-5!" disabled={locked} onClick={() => replace(line, null)}>
                <X size={10} />
              </IconButton>
            </div>
            <LineText line={line} disabled={locked} onCommit={(text) => retext(line, text)} />
          </li>
        ))}
      </ul>
      <Button size="sm" variant="ghost" onClick={addLine} disabled={locked}>
        <Plus size={12} /> Add a line at the playhead
      </Button>
    </Section>
  )
}

function LineText({ line, disabled, onCommit }: { line: LyricLine; disabled: boolean; onCommit: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(line.text)
  useEffect(() => setDraft(line.text), [line.text])
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false)
          onCommit(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(line.text)
            setEditing(false)
          }
        }}
        className={`${inputClass} mt-0.5 h-7 w-full text-xs`}
        aria-label="Line text"
      />
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      className="mt-0.5 block w-full text-left text-xs leading-snug"
      title="Edit this line"
    >
      {line.words.length
        ? line.words.map((w, k) => (
            <span key={k} className={w.conf === 0 ? 'text-muted italic' : ''}>
              {w.text}{' '}
            </span>
          ))
        : line.text}
    </button>
  )
}
