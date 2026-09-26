// The selected clip's position animation drawn on the preview (After Effects style):
// a path of per-frame dots (spacing shows speed), draggable dots at position keys,
// double-click the path to add a position key.
import { useMemo, useRef } from 'react'
import type { Clip, Keyframe } from '../api/types'
import { usePrefs } from '../lib/prefs'
import { useMediaQuery } from '../lib/useMedia'
import { curveValueAt } from './curves'
import { framesOf, keyIndexAt, propAt } from './keyframes'
import { useEditor } from './store'

const MAX_POINTS = 1500

export function MotionPath({ width }: { width: number }) {
  const enabled = usePrefs((p) => p.motionPath)
  const clip = useEditor((s) =>
    s.selection.length === 1 ? s.doc.clips.find((c) => c.id === s.selection[0]) : undefined,
  )
  if (!enabled || !clip || clip.type === 'audio' || !(framesOf(clip, 'x') || framesOf(clip, 'y'))) return null
  return <PathFor clip={clip} width={width} />
}

function PathFor({ clip, width }: { clip: Clip; width: number }) {
  const settings = useEditor((s) => s.doc.settings)
  const playhead = useEditor((s) => s.playhead)
  const locked = useEditor((s) => s.doc.tracks.find((t) => t.id === clip.track_id)?.locked ?? false)
  const coarse = useMediaQuery('(pointer: coarse)')
  const svgRef = useRef<SVGSVGElement>(null)
  const k = width / settings.width
  const fps = settings.fps
  const W2 = settings.width / 2
  const H2 = settings.height / 2

  // Sample the centre once per frame across the clip.
  const samples = useMemo(() => {
    const n = Math.min(MAX_POINTS, Math.max(2, Math.round(clip.duration * fps) + 1))
    const out: { t: number; x: number; y: number }[] = []
    for (let i = 0; i < n; i++) {
      const t = (clip.duration * i) / (n - 1)
      out.push({ t, x: (W2 + propAt(clip, 'x', clip.start + t)) * k, y: (H2 + propAt(clip, 'y', clip.start + t)) * k })
    }
    return out
  }, [clip, fps, k, W2, H2])

  // Position keys: every time either X or Y has a key (inside the clip).
  const keyTimes = useMemo(() => {
    const ts: number[] = []
    for (const p of ['x', 'y'] as const)
      for (const f of framesOf(clip, p) ?? [])
        if (f.t >= -1e-6 && f.t <= clip.duration + 1e-6 && !ts.some((t) => Math.abs(t - f.t) < 0.5 / fps)) ts.push(f.t)
    return ts.sort((a, b) => a - b)
  }, [clip, fps])

  const at = (t: number) => ({
    x: (W2 + propAt(clip, 'x', clip.start + t)) * k,
    y: (H2 + propAt(clip, 'y', clip.start + t)) * k,
  })
  const now = playhead >= clip.start && playhead <= clip.start + clip.duration ? at(playhead - clip.start) : null
  const d = samples.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  /** Set (or insert) keys at clip time t so the centre sits at (x, y) project px. */
  const setPos = (t: number, orig: Record<'x' | 'y', Keyframe[] | undefined>, dx: number, dy: number, axis: 'x' | 'y' | null) => {
    const s = useEditor.getState()
    for (const p of ['x', 'y'] as const) {
      const f = orig[p]
      const delta = p === 'x' ? dx : dy
      if (!f || (axis && axis !== p)) continue // static axes stay put
      const i = keyIndexAt(f, t, fps)
      const base = i >= 0 ? f[i].v : curveValueAt(f, t)
      let next: Keyframe[]
      if (i >= 0) next = f.map((key, j) => (j === i ? { ...key, v: Math.round(base + delta) } : key))
      else {
        const prev = [...f].reverse().find((key) => key.t < t)
        next = [...f, { t, v: Math.round(base + delta), ease: prev?.ease ?? 'linear', hm: prev?.hm ?? null }]
      }
      s.setKeyframes(clip.id, p, next)
    }
  }

  const onKeyDown = (e: React.PointerEvent, t: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const s = useEditor.getState()
    s.setPlaying(false)
    s.setPlayhead(clip.start + t)
    if (locked) return
    const orig = { x: framesOf(clip, 'x'), y: framesOf(clip, 'y') }
    const x0 = e.clientX
    const y0 = e.clientY
    let moved = false
    const move = (ev: PointerEvent) => {
      let dx = (ev.clientX - x0) / k
      let dy = (ev.clientY - y0) / k
      if (!moved) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return
        moved = true
        useEditor.getState().beginGesture()
      }
      let axis: 'x' | 'y' | null = null
      if (ev.shiftKey) {
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
        if (axis === 'x') dy = 0
        else dx = 0
      }
      setPos(t, orig, dx, dy, axis)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) useEditor.getState().endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Clip time of the path point nearest to a pointer position. */
  const nearestTime = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    let best = samples[0]
    for (const p of samples) if (Math.hypot(p.x - px, p.y - py) < Math.hypot(best.x - px, best.y - py)) best = p
    return Math.round(best.t * fps) / fps
  }

  // A click on the path jumps to that moment (and must not deselect the clip).
  const onPathDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const s = useEditor.getState()
    s.setPlaying(false)
    s.setPlayhead(clip.start + nearestTime(e))
  }

  const onPathDoubleClick = (e: React.MouseEvent) => {
    if (locked) return
    e.stopPropagation()
    const t = nearestTime(e)
    const s = useEditor.getState()
    s.beginGesture()
    // Key both axes here (a static axis becomes animated, holding its value).
    for (const p of ['x', 'y'] as const) {
      const f = framesOf(clip, p)
      const v = propAt(clip, p, clip.start + t)
      if (f) {
        if (keyIndexAt(f, t, fps) >= 0) continue
        const prev = [...f].reverse().find((key) => key.t < t)
        s.setKeyframes(clip.id, p, [...f, { t, v, ease: prev?.ease ?? 'linear', hm: prev?.hm ?? null }])
      } else s.setKeyframes(clip.id, p, [{ t, v, ease: 'linear' }])
    }
    s.endGesture()
    s.setPlayhead(clip.start + t)
  }

  const r = coarse ? 9 : 5
  const tick = coarse ? 1.8 : 1.4
  // Thin out frame ticks when they would be denser than ~3px apart on average.
  let len = 0
  for (let i = 1; i < samples.length; i++) len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
  const every = Math.max(1, Math.ceil((samples.length * 3) / Math.max(1, len)))

  return (
    <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-label="Motion path">
      <path d={d} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={3.5} />
      <path d={d} fill="none" stroke="#9d85ff" strokeWidth={1.5} />
      {/* wide invisible stroke to catch double-clicks on the path */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={coarse ? 22 : 12}
        style={{ pointerEvents: 'stroke', cursor: 'copy' }}
        onPointerDown={onPathDown}
        onDoubleClick={onPathDoubleClick}
      >
        <title>Click to jump here · double-click to add a position key</title>
      </path>
      {samples.map((p, i) =>
        i % every === 0 ? <circle key={i} cx={p.x} cy={p.y} r={tick} fill="#c4b5ff" opacity={0.8} /> : null,
      )}
      {now && <circle cx={now.x} cy={now.y} r={r + 3} fill="none" stroke="#ef5f6b" strokeWidth={2} />}
      {keyTimes.map((t) => {
        const p = at(t)
        const here = Math.abs(clip.start + t - playhead) <= 0.5 / fps
        return (
          <rect
            key={t}
            x={p.x - r}
            y={p.y - r}
            width={r * 2}
            height={r * 2}
            transform={`rotate(45 ${p.x} ${p.y})`}
            fill={here ? '#f2b84b' : '#ffffff'}
            stroke="#1c1f27"
            strokeWidth={1.5}
            style={{ pointerEvents: 'all', cursor: locked ? 'pointer' : 'move', touchAction: 'none' }}
            onPointerDown={(e) => onKeyDown(e, t)}
          >
            <title>{`Position key at ${(clip.start + t).toFixed(2)}s — drag to move (Shift locks direction)`}</title>
          </rect>
        )
      })}
    </svg>
  )
}
