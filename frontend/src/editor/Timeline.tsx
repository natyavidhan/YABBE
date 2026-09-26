import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Copy,
  ChartSpline,
  ArrowRightLeft,
  Eye,
  FlagTriangleRight,
  Link2,
  Unlink2,
  EyeOff,
  Flag,
  Lock,
  Magnet,
  Plus,
  Scissors,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Asset, Clip, Track } from '../api/types'
import { toast } from '../components/toast'
import { ApiImg, useApiImage } from '../lib/apiImage'
import { Button, IconButton, Modal, inputClass } from '../components/ui'
import { clamp } from '../lib/format'
import { isTouchEvent, useIsMobile } from '../lib/useMedia'
import { allKeyTimes, shiftKeyframes, shiftMarkers, visibleMarkers } from './keyframes'
import { ASSET_MIME } from './MediaBin'
import { allMarkers, clipEnd, cuts, docDuration, maxClipDuration, MIN_CLIP, overlaps, transitionLength, useEditor, withLinked } from './store'
import { ContextMenu } from '../components/ContextMenu'
import { useTransitionCatalog } from './transitionCatalog'

const HEADER_W = 176
const HEADER_W_COMPACT = 104
const LONG_PRESS_MS = 450
const RULER_H = 28
const TRACK_H = { video: 64, audio: 52 } as const
const COLLAPSED_H = 24

/** Row height of a track (collapsed tracks are a thin strip). */
const rowHeight = (t: Track, collapsed: Record<string, boolean>) => (collapsed[t.id] ? COLLAPSED_H : TRACK_H[t.kind])
const SNAP_PX = 8

type DragState =
  | {
      kind: 'move'
      primary: string
      startX: number
      startY: number
      originals: Map<string, { start: number; track_id: string }>
      active: boolean
      /** Alt held: act on the clicked clip alone, ignoring links. */
      single?: boolean
    }
  | { kind: 'trim-start' | 'trim-end'; id: string; startX: number; original: Clip; active: boolean }

export function Timeline({ projectId }: { projectId: string }) {
  const tracks = useEditor((s) => s.doc.tracks)
  const clips = useEditor((s) => s.doc.clips)
  const zoom = useEditor((s) => s.zoom)
  const assets = useEditor((s) => s.assets)
  const selection = useEditor((s) => s.selection)
  const transSel = useEditor((s) => s.transSel)
  const collapsed = useEditor((s) => s.collapsed)
  const duration = useEditor((s) => docDuration(s.doc))
  const doc = useEditor((s) => s.doc)
  const cutList = useMemo(() => cuts(doc), [doc])
  const catalog = useTransitionCatalog()
  const transName = (kind: string) => catalog?.transitions.find((t) => t.id === kind)?.name ?? kind
  const scrollRef = useRef<HTMLDivElement>(null)
  const lanesRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ left: 0, width: 1000 })
  const drag = useRef<DragState | null>(null)
  const [snapLine, setSnapLine] = useState<number | null>(null)
  const compact = useIsMobile()
  const headerW = compact ? HEADER_W_COMPACT : HEADER_W
  const headerRef = useRef(headerW)
  headerRef.current = headerW

  const assetMap = useMemo(() => new Map<string, Asset>(assets.map((a) => [a.id, a])), [assets])
  const contentSeconds = Math.max(duration + 30, (view.width - headerW) / zoom)
  const contentWidth = contentSeconds * zoom

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => setView({ left: el.scrollLeft, width: el.clientWidth })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const s = useEditor.getState()
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left - headerRef.current + el.scrollLeft
      const t = x / s.zoom
      const next = clamp(s.zoom * Math.pow(1.0015, -e.deltaY), 4, 800)
      s.setZoom(next)
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - (e.clientX - rect.left - headerRef.current)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Two-finger pinch zooms the timeline around the fingers' midpoint.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let pinch: { dist: number; zoom: number } | null = null
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e.touches), zoom: useEditor.getState().zoom }
    }
    const move = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left - headerRef.current
      const s = useEditor.getState()
      const t = (midX + el.scrollLeft) / s.zoom
      const next = clamp((pinch.zoom * dist(e.touches)) / pinch.dist, 4, 800)
      s.setZoom(next)
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - midX
      })
    }
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [])

  // Follow the playhead while playing.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const el = scrollRef.current
        if (!el || !s.playing || s.playhead === prev.playhead) return
        const x = s.playhead * s.zoom
        const visibleW = el.clientWidth - headerRef.current
        if (x > el.scrollLeft + visibleW - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80)
      }),
    [],
  )

  const timeAt = useCallback((clientX: number) => {
    const el = scrollRef.current!
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - headerRef.current + el.scrollLeft) / useEditor.getState().zoom)
  }, [])

  const trackAt = useCallback(
    (clientY: number): Track | null => {
      const lanes = lanesRef.current
      if (!lanes) return null
      let y = clientY - lanes.getBoundingClientRect().top
      for (const t of useEditor.getState().doc.tracks) {
        const h = rowHeight(t, useEditor.getState().collapsed)
        if (y >= 0 && y < h) return t
        y -= h
      }
      return null
    },
    [],
  )

  // ---- snapping ---------------------------------------------------------------------
  /** Snap points: timeline start/end, clip edges, markers (if enabled) and,
   * unless we're moving the playhead itself, the playhead. */
  const snapTargets = useCallback((exclude: Set<string>, withPlayhead = true) => {
    const s = useEditor.getState()
    const pts = [0, docDuration(s.doc)]
    if (withPlayhead) pts.push(s.playhead)
    for (const c of s.doc.clips) {
      if (exclude.has(c.id)) continue
      pts.push(c.start, clipEnd(c))
      if (s.snapMarkers) for (const m of visibleMarkers(c)) pts.push(c.start + m.t)
    }
    return pts
  }, [])

  const snap = useCallback((times: number[], targets: number[]): { delta: number; at: number | null } => {
    const s = useEditor.getState()
    if (!s.snapping) return { delta: 0, at: null }
    const tol = SNAP_PX / s.zoom
    let best = { delta: 0, at: null as number | null, dist: tol }
    for (const t of times)
      for (const p of targets) {
        const d = Math.abs(p - t)
        if (d < best.dist) best = { delta: p - t, at: p, dist: d }
      }
    return { delta: best.delta, at: best.at }
  }, [])

  // ---- drag handling ------------------------------------------------------------------
  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const s = useEditor.getState()
      if (!d.active) {
        if (Math.abs(e.clientX - d.startX) < 3 && (d.kind !== 'move' || Math.abs(e.clientY - d.startY) < 3)) return
        d.active = true
        s.beginGesture()
      }
      const dt = (e.clientX - d.startX) / s.zoom
      const clipsNow = s.doc.clips

      if (d.kind === 'move') {
        const moving = new Set(d.originals.keys())
        const prim = d.originals.get(d.primary)!
        const primClip = clipsNow.find((c) => c.id === d.primary)!
        // Only a single clip may change track.
        let targetTrack = prim.track_id
        if (moving.size === 1) {
          const t = trackAt(e.clientY)
          const kind = s.doc.tracks.find((x) => x.id === prim.track_id)?.kind
          if (t && t.kind === kind && !t.locked) targetTrack = t.id
        }
        let delta = dt
        const minStart = Math.min(...[...d.originals.values()].map((o) => o.start))
        delta = Math.max(delta, -minStart)
        const sn = snap([prim.start + delta, prim.start + delta + primClip.duration], snapTargets(moving))
        if (sn.at !== null && prim.start + delta + sn.delta >= 0 && minStart + delta + sn.delta >= 0) delta += sn.delta
        setSnapLine(sn.at)

        const next = clipsNow.map((c) => {
          const o = d.originals.get(c.id)
          if (!o) return c
          return { ...c, start: o.start + delta, track_id: c.id === d.primary ? targetTrack : o.track_id }
        })
        const valid = next
          .filter((c) => moving.has(c.id))
          .every((c) => !overlaps(next, c.track_id, c.start, c.duration, moving))
        if (valid) s.change((doc) => ({ ...doc, clips: next }))
      } else {
        const o = d.original
        const asset = o.asset_id ? assetMap.get(o.asset_id) : undefined
        const others = clipsNow.filter((c) => c.track_id === o.track_id && c.id !== o.id)
        const hasSource = o.type === 'video' || o.type === 'audio'
        if (d.kind === 'trim-start') {
          const prevEnd = Math.max(0, ...others.filter((c) => clipEnd(c) <= o.start + 1e-6).map(clipEnd))
          const lower = Math.max(prevEnd, hasSource ? o.start - o.in_point / o.speed : 0)
          let start = o.start + dt
          const sn = snap([start], snapTargets(new Set([o.id])))
          start += sn.delta
          setSnapLine(sn.at)
          start = clamp(start, lower, clipEnd(o) - MIN_CLIP)
          s.updateClip(o.id, {
            start,
            duration: clipEnd(o) - start,
            in_point: hasSource ? Math.max(0, o.in_point + (start - o.start) * o.speed) : o.in_point,
            // Keyframes are clip-relative: keep them pinned to the same moments.
            keyframes: shiftKeyframes(o.keyframes, o.start - start) ?? {},
            markers: shiftMarkers(o.markers, o.start - start),
          })
        } else {
          const nextStart = Math.min(Infinity, ...others.filter((c) => c.start >= clipEnd(o) - 1e-6).map((c) => c.start))
          const upper = Math.min(nextStart, o.start + maxClipDuration(o, asset))
          let end = clipEnd(o) + dt
          const sn = snap([end], snapTargets(new Set([o.id])))
          end += sn.delta
          setSnapLine(sn.at)
          end = clamp(end, o.start + MIN_CLIP, upper)
          s.updateClip(o.id, { duration: end - o.start })
        }
      }
    },
    [assetMap, snap, snapTargets, trackAt],
  )

  const onUp = useCallback(() => {
    const d = drag.current
    if (d?.active) useEditor.getState().endGesture()
    else if (d?.kind === 'move' && d.originals.size > 1) {
      // A click (no drag) on a clip in a multi-selection narrows to that clip's link group.
      const st = useEditor.getState()
      const group = d.single ? [d.primary] : withLinked([d.primary], st.doc.clips)
      if (group.length < d.originals.size) st.select(group)
    }
    drag.current = null
    setSnapLine(null)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }, [onMove])

  useEffect(() => () => onUp(), [onUp])

  const beginDrag = (d: DragState) => {
    drag.current = d
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onClipDown = (e: React.PointerEvent, clip: Clip, part: 'body' | 'start' | 'end') => {
    if (e.button !== 0) return
    e.stopPropagation()
    const s = useEditor.getState()
    const track = s.doc.tracks.find((t) => t.id === clip.track_id)
    const group = e.altKey ? [clip.id] : withLinked([clip.id], s.doc.clips)
    if (e.shiftKey) {
      // Toggle the clip (and its linked clips) in the selection.
      const on = s.selection.includes(clip.id)
      s.select(on ? s.selection.filter((id) => !group.includes(id)) : [...new Set([...s.selection, ...group])])
      return
    }
    if (isTouchEvent(e) && part === 'body') {
      // Touch: tap selects, long-press toggles multi-selection, and only an
      // already-selected clip can be dragged (so swiping over clips scrolls).
      const wasSelected = s.selection.includes(clip.id)
      const startX = e.clientX
      const startY = e.clientY
      let moved = false
      let longPressed = false
      const timer = window.setTimeout(() => {
        if (moved) return
        longPressed = true
        if (drag.current) {
          drag.current = null
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        useEditor.getState().toggleSelect(clip.id)
        navigator.vibrate?.(15)
      }, LONG_PRESS_MS)
      const watch = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 8) moved = true
      }
      const finish = (ev: PointerEvent) => {
        if (ev.type === 'pointercancel') moved = true // the browser took over (scroll)
        window.clearTimeout(timer)
        window.removeEventListener('pointermove', watch)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        const st = useEditor.getState()
        if (!moved && !longPressed && (!wasSelected || st.selection.length > group.length) && !drag.current?.active)
          st.select(group)
      }
      window.addEventListener('pointermove', watch)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
      if (!wasSelected || track?.locked) return
      const lockedTracks = new Set(s.doc.tracks.filter((t) => t.locked).map((t) => t.id))
      const originals = new Map(
        s.doc.clips
          .filter((c) => s.selection.includes(c.id) && !lockedTracks.has(c.track_id))
          .map((c) => [c.id, { start: c.start, track_id: c.track_id }]),
      )
      beginDrag({ kind: 'move', primary: clip.id, startX: e.clientX, startY: e.clientY, originals, active: false })
      return
    }
    let sel = s.selection
    if (!sel.includes(clip.id) || e.altKey) {
      sel = group
      s.select(sel)
    } else if (group.some((id) => !sel.includes(id))) {
      // Clicking a linked clip always brings its whole group into the selection.
      sel = [...new Set([...sel, ...group])]
      s.select(sel)
    }
    if (track?.locked) return
    if (part === 'body') {
      const lockedTracks = new Set(s.doc.tracks.filter((t) => t.locked).map((t) => t.id))
      const originals = new Map(
        s.doc.clips
          .filter((c) => sel.includes(c.id) && !lockedTracks.has(c.track_id))
          .map((c) => [c.id, { start: c.start, track_id: c.track_id }]),
      )
      beginDrag({ kind: 'move', primary: clip.id, startX: e.clientX, startY: e.clientY, originals, active: false, single: e.altKey })
    } else {
      s.select([clip.id])
      beginDrag({ kind: part === 'start' ? 'trim-start' : 'trim-end', id: clip.id, startX: e.clientX, original: clip, active: false })
    }
  }

  /** Move the playhead to a pointer position: snapped to clip edges / markers
   * (unless Alt or snapping is off), otherwise to the nearest frame. */
  const seekTo = useCallback(
    (clientX: number, noSnap: boolean) => {
      const s = useEditor.getState()
      const fps = s.doc.settings.fps
      let t = timeAt(clientX)
      const sn = noSnap ? { delta: 0, at: null } : snap([t], snapTargets(new Set(), false))
      if (sn.at !== null) t = sn.at
      else t = Math.round(t * fps) / fps
      setSnapLine(sn.at)
      s.setPlayhead(Math.max(0, t))
    },
    [timeAt, snap, snapTargets],
  )

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    seekTo(e.clientX, e.altKey)
    const move = (ev: PointerEvent) => seekTo(ev.clientX, ev.altKey)
    const up = () => {
      setSnapLine(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const lastLanePointer = useRef('mouse')
  const contentRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const onLaneDown = (e: React.PointerEvent) => {
    lastLanePointer.current = e.pointerType
    if (e.button !== 0 || isTouchEvent(e)) return // touch: handled as a tap in onLaneClick
    e.preventDefault() // no text selection while dragging
    const content = contentRef.current!
    const rel = (ev: { clientX: number; clientY: number }) => {
      const r = content.getBoundingClientRect()
      return { x: ev.clientX - r.left, y: ev.clientY - r.top }
    }
    const start = rel(e)
    const base = e.shiftKey ? useEditor.getState().selection : []
    let active = false
    const move = (ev: PointerEvent) => {
      const p = rel(ev)
      if (!active && Math.hypot(p.x - start.x, p.y - start.y) < 4) return
      active = true
      const box = { x0: Math.min(start.x, p.x), x1: Math.max(start.x, p.x), y0: Math.min(start.y, p.y), y1: Math.max(start.y, p.y) }
      setMarquee(box)
      const st = useEditor.getState()
      const t0 = (box.x0 - headerRef.current) / st.zoom
      const t1 = (box.x1 - headerRef.current) / st.zoom
      // Tracks whose rows the box touches (lanes start below the ruler).
      const hit = new Set<string>()
      let y = RULER_H
      for (const t of st.doc.tracks) {
        const h = rowHeight(t, st.collapsed)
        if (box.y1 >= y && box.y0 <= y + h) hit.add(t.id)
        y += h
      }
      const ids = st.doc.clips
        .filter((c) => hit.has(c.track_id) && c.start < t1 && clipEnd(c) > t0)
        .map((c) => c.id)
      st.select(withLinked([...new Set([...base, ...ids])], st.doc.clips))
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!active) {
        const st = useEditor.getState()
        if (!ev.shiftKey) st.select([])
        seekTo(ev.clientX, ev.altKey)
        setSnapLine(null)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onLaneClick = (e: React.MouseEvent) => {
    if (lastLanePointer.current === 'mouse' || e.target !== e.currentTarget) return
    useEditor.getState().select([])
    seekTo(e.clientX, false)
    setSnapLine(null)
  }

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const onClipContextMenu = (e: React.MouseEvent, clip: Clip) => {
    e.preventDefault()
    const s = useEditor.getState()
    if (!s.selection.includes(clip.id)) s.select(withLinked([clip.id], s.doc.clips))
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const onDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(ASSET_MIME)
    if (!id) return
    e.preventDefault()
    const asset = assetMap.get(id)
    if (!asset) return
    useEditor.getState().addAssetClip(asset, { trackId: track.id, start: timeAt(e.clientX) })
  }

  const clipsByTrack = useMemo(() => {
    const m = new Map<string, Clip[]>()
    for (const c of clips) m.set(c.track_id, [...(m.get(c.track_id) ?? []), c])
    return m
  }, [clips])

  const visible = { from: view.left / zoom - 1, to: (view.left + view.width) / zoom + 1 }

  return (
    <div className="flex h-full flex-col bg-panel select-none" onContextMenu={(e) => e.preventDefault()}>
      <Toolbar compact={compact} />
      {menu && <ClipMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      <div ref={scrollRef} className="relative min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto overscroll-contain">
        <div ref={contentRef} className="relative" style={{ width: headerW + contentWidth, minHeight: '100%' }}>
          {marquee && (
            <div
              className="pointer-events-none absolute z-30 rounded-sm border border-accent-2 bg-accent/15"
              style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }}
            />
          )}
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-30 shrink-0 border-r border-b border-line bg-panel" style={{ width: headerW }} />
            <div className="relative flex-1 cursor-pointer touch-none border-b border-line bg-panel-2" onPointerDown={scrub}>
              <Ruler zoom={zoom} from={visible.from} to={visible.to} />
              <RulerMarkers zoom={zoom} />
              <PlayheadHead />
            </div>
          </div>

          {/* Tracks */}
          <div ref={lanesRef}>
            {tracks.map((track, i) => (
              <div key={track.id} className="flex" style={{ height: rowHeight(track, collapsed) }}>
                <TrackHeader
                  track={track}
                  index={i}
                  count={tracks.length}
                  width={headerW}
                  compact={compact}
                  collapsed={!!collapsed[track.id]}
                />
                <div
                  className={`group/lane relative flex-1 border-b border-line ${track.kind === 'audio' ? 'bg-[#13161b]' : 'bg-bg'} ${
                    track.hidden || track.muted ? 'opacity-50' : ''
                  }`}
                  onPointerDown={onLaneDown}
                  onClick={onLaneClick}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(ASSET_MIME)) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'copy'
                    }
                  }}
                  onDrop={(e) => onDrop(e, track)}
                >
                  {(clipsByTrack.get(track.id) ?? [])
                    .filter((c) => clipEnd(c) >= visible.from && c.start <= visible.to)
                    .map((c) => (
                      <TimelineClip
                        key={c.id}
                        projectId={projectId}
                        clip={c}
                        asset={c.asset_id ? assetMap.get(c.asset_id) : undefined}
                        zoom={zoom}
                        height={rowHeight(track, collapsed)}
                        selected={selection.includes(c.id)}
                        locked={track.locked}
                        onDown={onClipDown}
                        onContextMenu={onClipContextMenu}
                        linked={!!c.link && clips.some((o) => o.id !== c.id && o.link === c.link)}
                        compact={compact}
                      />
                    ))}
                  {cutList
                    .filter((c) => c.a.track_id === track.id && c.time >= visible.from && c.time <= visible.to)
                    .map((c) => (
                      <CutMarker
                        key={`${c.a.id}-${c.b.id}`}
                        cut={c}
                        zoom={zoom}
                        height={rowHeight(track, collapsed)}
                        selected={transSel === c.a.id}
                        near={selection.includes(c.a.id) || selection.includes(c.b.id)}
                        locked={track.locked}
                        compact={compact}
                        name={c.a.transition ? transName(c.a.transition.kind) : ''}
                      />
                    ))}
                </div>
              </div>
            ))}
            {tracks.length === 0 && (
              <div className="p-6 text-center text-muted">No tracks — add one from the toolbar.</div>
            )}
          </div>

          {snapLine !== null && (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-warn"
              style={{ left: headerW + snapLine * zoom }}
            />
          )}
          <PlayheadLine headerW={headerW} scrollLeft={view.left} />
        </div>
      </div>
    </div>
  )
}

/**
 * Playhead line across the tracks: 2px, snapped to whole pixels (a 1px line
 * offset by half a pixel blurs into near-invisibility) with a dark outline so
 * it stays visible over bright filmstrips. Layered above clips (z-5) but below
 * the sticky track headers (z-18) and ruler (z-20).
 */
function PlayheadLine({ headerW, scrollLeft }: { headerW: number; scrollLeft: number }) {
  const playhead = useEditor((s) => s.playhead)
  const zoom = useEditor((s) => s.zoom)
  // Scrolled out of view to the left: don't let it peek out beside the headers.
  if (playhead * zoom < scrollLeft - 1) return null
  return (
    <div
      className="pointer-events-none absolute top-0 bottom-0 z-[15] w-[2px] bg-danger shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
      style={{ left: Math.round(headerW + playhead * zoom) - 1 }}
    />
  )
}

/** Draggable playhead handle in the ruler (drags scrub via the ruler's handler). */
function PlayheadHead() {
  const playhead = useEditor((s) => s.playhead)
  const zoom = useEditor((s) => s.zoom)
  const x = Math.round(playhead * zoom)
  return (
    <div className="absolute top-0 bottom-0 z-10 cursor-ew-resize" style={{ left: x - 7, width: 14 }} title="Drag to scrub">
      <div className="absolute top-0 bottom-0 left-[6px] w-[2px] bg-danger" />
      <div
        className="absolute bottom-0 left-0 h-[14px] w-[14px] bg-danger drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
        style={{ clipPath: 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)' }}
      />
    </div>
  )
}

const TICKS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

function Ruler({ zoom, from, to }: { zoom: number; from: number; to: number }) {
  const fps = useEditor((s) => s.doc.settings.fps)
  const major = TICKS.find((t) => t * zoom >= 90) ?? 3600
  const minor = major / (major * zoom >= 200 ? 10 : 5)
  const ticks: { t: number; major: boolean }[] = []
  const start = Math.max(0, Math.floor(from / minor) * minor)
  for (let t = start; t <= to && ticks.length < 2000; t += minor) {
    const rounded = Math.round(t * 1000) / 1000
    ticks.push({ t: rounded, major: Math.abs(rounded / major - Math.round(rounded / major)) < 1e-6 })
  }
  const label = (t: number) => {
    const m = Math.floor(t / 60)
    const s = t % 60
    if (major < 1) {
      const frame = Math.round((s % 1) * fps)
      return `${m}:${String(Math.floor(s)).padStart(2, '0')}${frame ? `:${String(frame).padStart(2, '0')}` : ''}`
    }
    return `${m}:${String(Math.round(s)).padStart(2, '0')}`
  }
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      {ticks.map(({ t, major: isMajor }) => (
        <div key={t} className="absolute bottom-0" style={{ left: t * zoom }}>
          <div className={`w-px ${isMajor ? 'h-3 bg-muted/70' : 'h-1.5 bg-faint/60'}`} />
          {isMajor && (
            <span className="tabular absolute bottom-3 left-1 font-mono text-[10px] whitespace-nowrap text-muted">{label(t)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

function TrackHeader({
  track,
  index,
  count,
  width,
  compact,
  collapsed,
}: {
  track: Track
  index: number
  count: number
  width: number
  compact: boolean
  collapsed: boolean
}) {
  const { updateTrack, removeTrack, moveTrack, toggleCollapsed } = useEditor.getState()
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const hasClips = useEditor((s) => s.doc.clips.some((c) => c.track_id === track.id))
  const neighbours = useEditor((s) => s.doc.tracks)
  const canUp = index > 0 && neighbours[index - 1]?.kind === track.kind
  const canDown = index < count - 1 && neighbours[index + 1]?.kind === track.kind
  return (
    <div
      className={`group sticky left-0 z-[18] flex shrink-0 border-r border-b border-line bg-panel ${
        collapsed ? 'flex-row items-center gap-1' : 'flex-col justify-center gap-1'
      } ${compact ? 'px-1' : 'pr-2.5 pl-1'}`}
      style={{ width }}
    >
      <div className={`flex min-w-0 items-center gap-1 ${collapsed ? 'flex-1' : ''}`}>
        <button
          type="button"
          onClick={() => toggleCollapsed(track.id)}
          className="flex h-5 w-4 shrink-0 items-center justify-center rounded text-faint hover:text-fg"
          aria-label={collapsed ? `Expand ${track.name}` : `Collapse ${track.name}`}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand track' : 'Collapse track'}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${track.kind === 'audio' ? 'bg-clip-audio' : 'bg-clip-video'}`} />
        {editing ? (
          <input
            autoFocus
            defaultValue={track.name}
            className="h-5 w-full min-w-0 rounded border border-accent bg-bg px-1 text-xs outline-none"
            onBlur={(e) => {
              if (e.target.value.trim()) updateTrack(track.id, { name: e.target.value.trim() })
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <span
            className="truncate text-xs font-medium"
            onDoubleClick={() => setEditing(true)}
            onClick={() => compact && setMenu(true)}
            title={compact ? 'Tap for track options' : 'Double-click to rename'}
          >
            {track.name}
          </span>
        )}
      </div>
      <div className={`items-center gap-0.5 ${collapsed ? (compact ? 'hidden' : 'flex shrink-0') : 'flex pl-5'} ${collapsed ? '[&_button]:h-5! [&_button]:w-5!' : ''}`}>
        {track.kind === 'video' ? (
          <IconButton label={track.hidden ? 'Show track' : 'Hide track'} active={track.hidden} onClick={() => updateTrack(track.id, { hidden: !track.hidden })} className="h-6! w-6!">
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        ) : null}
        <IconButton label={track.muted ? 'Unmute track' : 'Mute track'} active={track.muted} onClick={() => updateTrack(track.id, { muted: !track.muted })} className="h-6! w-6!">
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </IconButton>
        <IconButton label={track.locked ? 'Unlock track' : 'Lock track'} active={track.locked} onClick={() => updateTrack(track.id, { locked: !track.locked })} className="h-6! w-6!">
          {track.locked ? <Lock size={13} /> : <Unlock size={13} />}
        </IconButton>
        {!collapsed && <div className="flex-1" />}
        <div className={`${compact || collapsed ? 'hidden' : 'flex'} opacity-0 transition-opacity group-hover:opacity-100`}>
          <IconButton label="Move track up" disabled={!canUp} onClick={() => moveTrack(track.id, -1)} className="h-6! w-5!">
            <ChevronUp size={13} />
          </IconButton>
          <IconButton label="Move track down" disabled={!canDown} onClick={() => moveTrack(track.id, 1)} className="h-6! w-5!">
            <ChevronDown size={13} />
          </IconButton>
          <IconButton
            label={hasClips ? 'Delete track and its clips' : 'Delete track'}
            onClick={() => {
              if (!hasClips || window.confirm(`Delete “${track.name}” and all clips on it?`)) removeTrack(track.id)
            }}
            className="h-6! w-6! hover:text-danger!"
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>
      {menu && (
        <Modal title="Track" onClose={() => setMenu(false)}>
          <div className="flex flex-col gap-3">
            <input
              className={inputClass}
              defaultValue={track.name}
              aria-label="Track name"
              onBlur={(e) => e.target.value.trim() && updateTrack(track.id, { name: e.target.value.trim() })}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button disabled={!canUp} onClick={() => moveTrack(track.id, -1)}>
                <ChevronUp size={15} /> Move up
              </Button>
              <Button disabled={!canDown} onClick={() => moveTrack(track.id, 1)}>
                <ChevronDown size={15} /> Move down
              </Button>
            </div>
            <Button
              variant="danger"
              onClick={() => {
                if (!hasClips || window.confirm(`Delete “${track.name}” and all clips on it?`)) {
                  removeTrack(track.id)
                  setMenu(false)
                }
              }}
            >
              <Trash2 size={15} /> Delete track{hasClips ? ' and its clips' : ''}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Toolbar({ compact }: { compact: boolean }) {
  const zoom = useEditor((s) => s.zoom)
  const snapping = useEditor((s) => s.snapping)
  const snapMarkers = useEditor((s) => s.snapMarkers)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const canLink = useEditor((s) => s.selection.length > 1)
  const canUnlink = useEditor((s) => s.doc.clips.some((c) => c.link && s.selection.includes(c.id)))
  const graphOpen = useEditor((s) => s.graphOpen)
  const anyExpanded = useEditor((s) => s.doc.tracks.some((t) => !s.collapsed[t.id]))
  const s = useEditor.getState()
  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2">
      <IconButton label="Split at playhead (S)" onClick={s.splitAtPlayhead}>
        <Scissors size={15} />
      </IconButton>
      <IconButton label="Duplicate (Ctrl+D)" onClick={s.duplicateSelected} disabled={!hasSelection}>
        <Copy size={15} />
      </IconButton>
      <IconButton label="Delete (Del)" onClick={s.deleteSelected} disabled={!hasSelection}>
        <Trash2 size={15} />
      </IconButton>
      <IconButton label="Link selected clips (Ctrl+L)" onClick={() => s.linkSelected()} disabled={!canLink}>
        <Link2 size={15} />
      </IconButton>
      <IconButton label="Unlink (Ctrl+Shift+L)" onClick={() => s.unlinkSelected()} disabled={!canUnlink}>
        <Unlink2 size={15} />
      </IconButton>
      <IconButton
        label="Add marker to the selected clip (M)"
        onClick={() => {
          const err = s.addMarker()
          if (err) toast.info(err)
        }}
      >
        <Flag size={15} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-line" />
      {!compact && (
        <IconButton label="Add text (T)" onClick={() => s.addTextClip()}>
          <Type size={15} />
        </IconButton>
      )}
      <button
        onClick={() => s.addTrack('video')}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap text-muted hover:bg-raised hover:text-fg"
        title="Add video track"
      >
        <Plus size={13} /> {compact ? 'Video' : 'Video track'}
      </button>
      <button
        onClick={() => s.addTrack('audio')}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap text-muted hover:bg-raised hover:text-fg"
        title="Add audio track"
      >
        <Plus size={13} /> {compact ? 'Audio' : 'Audio track'}
      </button>
      <div className="flex-1" />
      <IconButton
        label={anyExpanded ? 'Collapse all tracks' : 'Expand all tracks'}
        onClick={() => s.setAllCollapsed(anyExpanded)}
      >
        {anyExpanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
      </IconButton>
      <IconButton label="Graph editor (G)" active={graphOpen} onClick={() => s.setGraphOpen(!graphOpen)}>
        <ChartSpline size={15} />
      </IconButton>
      <IconButton
        label={snapping ? 'Snapping on (hold Alt to skip)' : 'Snapping off'}
        active={snapping}
        onClick={() => s.setSnapping(!snapping)}
      >
        <Magnet size={15} />
      </IconButton>
      <IconButton
        label={snapMarkers ? 'Snap to markers: on' : 'Snap to markers: off'}
        active={snapMarkers && snapping}
        disabled={!snapping}
        onClick={() => s.setSnapMarkers(!snapMarkers)}
      >
        <FlagTriangleRight size={15} />
      </IconButton>
      <div className="mx-1 h-5 w-px bg-line" />
      <IconButton label="Zoom out (−)" onClick={() => s.setZoom(zoom / 1.25)}>
        <ZoomOut size={15} />
      </IconButton>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={Math.log(zoom / 4) / Math.log(200)}
        onChange={(e) => s.setZoom(4 * Math.pow(200, Number(e.target.value)))}
        className={compact ? 'hidden' : 'w-28'}
        aria-label="Timeline zoom"
      />
      <IconButton label="Zoom in (+)" onClick={() => s.setZoom(zoom * 1.25)}>
        <ZoomIn size={15} />
      </IconButton>
    </div>
  )
}

// ---- clips -------------------------------------------------------------------------------

const CLIP_COLORS: Record<Clip['type'], string> = {
  video: 'bg-clip-video/80 border-clip-video',
  image: 'bg-clip-image/80 border-clip-image',
  text: 'bg-clip-text/80 border-clip-text',
  audio: 'bg-clip-audio/80 border-clip-audio',
}

const TimelineClip = memo(function TimelineClip({
  projectId,
  clip,
  asset,
  zoom,
  height,
  selected,
  locked,
  onDown,
  onContextMenu,
  linked,
  compact,
}: {
  projectId: string
  clip: Clip
  asset: Asset | undefined
  zoom: number
  height: number
  selected: boolean
  locked: boolean
  onDown: (e: React.PointerEvent, clip: Clip, part: 'body' | 'start' | 'end') => void
  onContextMenu: (e: React.MouseEvent, clip: Clip) => void
  linked: boolean
  compact: boolean
}) {
  const left = clip.start * zoom
  const width = Math.max(2, clip.duration * zoom)
  const label =
    clip.type === 'text' ? (clip.text?.content.split('\n')[0] ?? 'Text') : (asset?.original_name ?? 'Missing media')
  const ready = asset?.status === 'ready'
  const bodyH = height - 4 - 16
  const roomy = bodyH >= 10 // collapsed tracks show a slim labelled bar only
  const showFilm = roomy && ready && (clip.type === 'video' || clip.type === 'image') && asset!.thumb_count > 0
  const showWave = roomy && ready && asset!.has_audio && (clip.type === 'audio' || clip.type === 'video')

  return (
    <div
      className={`absolute top-0.5 overflow-hidden rounded-md border ${CLIP_COLORS[clip.type]} ${
        selected ? 'z-[5] ring-2 ring-white/90' : ''
      } ${locked ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'} ${!asset && clip.type !== 'text' ? 'opacity-50' : ''}`}
      // Selected clips capture touch (drag to move); others let the timeline scroll.
      style={{ left, width, height: height - 4, touchAction: selected ? 'none' : 'pan-x pan-y' }}
      onPointerDown={(e) => onDown(e, clip, 'body')}
      onContextMenu={(e) => onContextMenu(e, clip)}
      title={linked ? `${label} (linked — Alt+click selects just this clip)` : label}
    >
      <div className="flex h-4 items-center gap-1 overflow-hidden px-1.5 text-[10px] leading-4 font-medium whitespace-nowrap text-white/95">
        {linked && <Link2 size={10} className="shrink-0" aria-label="Linked" />}
        {clip.muted && <VolumeX size={10} />}
        <span className="truncate">{label}</span>
        {clip.speed !== 1 && <span className="rounded bg-black/30 px-0.5">{clip.speed}×</span>}
      </div>
      <div className="relative overflow-hidden" style={{ height: bodyH }}>
        {showFilm && (
          <Filmstrip projectId={projectId} clip={clip} asset={asset!} zoom={zoom} width={width} height={showWave && clip.type === 'video' ? bodyH - 12 : bodyH} />
        )}
        {clip.type === 'text' && (
          <div className="truncate px-1.5 text-[11px] text-white/70 italic">{clip.text?.font}</div>
        )}
        {showWave && (
          <div className="absolute inset-x-0 bottom-0" style={{ height: clip.type === 'video' ? 12 : bodyH }}>
            <Waveform projectId={projectId} clip={clip} asset={asset!} zoom={zoom} width={width} height={clip.type === 'video' ? 12 : bodyH} />
          </div>
        )}
      </div>
      {/* Fades */}
      {clip.fade_in > 0 && (
        <div
          className="pointer-events-none absolute top-0 left-0 h-full bg-gradient-to-r from-black/50 to-transparent"
          style={{ width: clip.fade_in * zoom }}
        />
      )}
      {clip.fade_out > 0 && (
        <div
          className="pointer-events-none absolute top-0 right-0 h-full bg-gradient-to-l from-black/50 to-transparent"
          style={{ width: clip.fade_out * zoom }}
        />
      )}
      <ClipMarkers clip={clip} zoom={zoom} locked={locked} compact={compact} />
      {selected && <KeyMarkers clip={clip} zoom={zoom} compact={compact} />}
      {!locked && !compact && (
        <>
          <div
            className="absolute top-0 left-0 z-[2] h-full w-2 cursor-ew-resize hover:bg-white/40"
            onPointerDown={(e) => onDown(e, clip, 'start')}
          />
          <div
            className="absolute top-0 right-0 z-[2] h-full w-2 cursor-ew-resize hover:bg-white/40"
            onPointerDown={(e) => onDown(e, clip, 'end')}
          />
        </>
      )}
      {!locked && compact && selected && (
        <>
          {/* Finger-sized trim grips, only on the selected clip. */}
          <div
            className="absolute top-0 left-0 z-[2] flex h-full w-5 touch-none items-center justify-center bg-white/25"
            onPointerDown={(e) => onDown(e, clip, 'start')}
          >
            <div className="h-1/2 w-1 rounded-full bg-white" />
          </div>
          <div
            className="absolute top-0 right-0 z-[2] flex h-full w-5 touch-none items-center justify-center bg-white/25"
            onPointerDown={(e) => onDown(e, clip, 'end')}
          >
            <div className="h-1/2 w-1 rounded-full bg-white" />
          </div>
        </>
      )}
    </div>
  )
})

/** Right-click menu for the selected clips. */
function ClipMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const s = useEditor.getState()
  const sel = useEditor((st) => st.selection)
  const clips = useEditor((st) => st.doc.clips)
  const selected = clips.filter((c) => sel.includes(c.id))
  const linkedSel = selected.filter((c) => c.link)
  const allOneGroup = selected.length > 1 && linkedSel.length === selected.length && new Set(linkedSel.map((c) => c.link)).size === 1
  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        {
          label: `Link ${selected.length} clips`,
          icon: <Link2 size={13} />,
          shortcut: 'Ctrl+L',
          disabled: selected.length < 2 || allOneGroup,
          onSelect: () => s.linkSelected(),
        },
        {
          label: 'Unlink',
          icon: <Unlink2 size={13} />,
          shortcut: 'Ctrl+Shift+L',
          disabled: !linkedSel.length,
          onSelect: () => s.unlinkSelected(),
        },
        'divider',
        { label: 'Split at playhead', icon: <Scissors size={13} />, shortcut: 'S', onSelect: () => s.splitAtPlayhead() },
        { label: 'Duplicate', icon: <Copy size={13} />, shortcut: 'Ctrl+D', onSelect: () => s.duplicateSelected() },
        'divider',
        {
          label: selected.length > 1 ? `Delete ${selected.length} clips` : 'Delete',
          icon: <Trash2 size={13} />,
          shortcut: 'Del',
          danger: true,
          onSelect: () => s.deleteSelected(),
        },
      ]}
    />
  )
}

/** A cut between two touching clips: add a transition (+) or show the existing one. */
function CutMarker({
  cut,
  zoom,
  height,
  selected,
  near,
  locked,
  compact,
  name,
}: {
  cut: { a: Clip; b: Clip; time: number }
  zoom: number
  height: number
  selected: boolean
  near: boolean
  locked: boolean
  compact: boolean
  name: string
}) {
  const s = useEditor.getState()
  const t = cut.a.transition
  const [hover, setHover] = useState<DOMRect | null>(null)
  if (t) {
    const d = transitionLength(cut.a, cut.b)
    const w = Math.max(compact ? 24 : 18, d * zoom)
    return (
      <>
      <button
        onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(e.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
        type="button"
        title={`${name} · ${d.toFixed(2)} s — click to edit`}
        aria-label={`Transition ${name}`}
        onPointerDown={(e) => {
          e.stopPropagation()
          s.selectTransition(cut.a.id)
        }}
        className={`absolute top-1/2 z-[6] flex -translate-y-1/2 items-center justify-center overflow-hidden rounded-md border text-white shadow-md shadow-black/40 ${
          selected ? 'border-white ring-2 ring-white/80' : 'border-black/40'
        }`}
        style={{
          left: cut.time * zoom - w / 2,
          width: w,
          height: Math.min(height - 12, compact ? 34 : 28),
          background: 'repeating-linear-gradient(135deg, #7c5cff 0 6px, #6246e0 6px 12px)',
          touchAction: 'none',
        }}
      >
        <ArrowRightLeft size={12} />
      </button>
      {hover && <TransitionHoverCard kind={t.kind} name={name} duration={d} anchor={hover} />}
      </>
    )
  }
  if (locked) return null
  const size = compact ? 26 : 18
  return (
    <button
      type="button"
      title="Add a transition"
      aria-label="Add a transition"
      onPointerDown={(e) => {
        e.stopPropagation()
        const st = useEditor.getState()
        st.setTransition(cut.a.id, { kind: 'mix', duration: Math.min(0.5, cut.a.duration, cut.b.duration) })
        st.selectTransition(cut.a.id)
      }}
      className={`absolute top-1/2 z-[6] flex -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-accent text-white shadow-md shadow-black/50 transition-opacity ${
        near ? 'opacity-100' : 'opacity-0 group-hover/lane:opacity-100'
      }`}
      style={{ left: cut.time * zoom - size / 2, width: size, height: size, touchAction: 'none' }}
    >
      <Plus size={compact ? 14 : 11} />
    </button>
  )
}

/** Floating animated preview above a transition badge (rendered in a portal-free fixed layer). */
function TransitionHoverCard({ kind, name, duration, anchor }: { kind: string; name: string; duration: number; anchor: DOMRect }) {
  const W = 240
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, anchor.left + anchor.width / 2 - W / 2))
  return (
    <div
      className="toast-in pointer-events-none fixed z-50 overflow-hidden rounded-lg border border-line-strong bg-raised shadow-2xl shadow-black/60"
      style={{ left, bottom: window.innerHeight - anchor.top + 8, width: W }}
    >
      <div className="aspect-video w-full bg-bg">
        <ApiImg url={api.transitionPreviewUrl(kind)} alt="" className="h-full w-full object-cover" />
      </div>
      <div className="flex items-center justify-between px-2 py-1 text-[11px]">
        <span className="font-medium">{name}</span>
        <span className="text-muted">{duration.toFixed(2)} s</span>
      </div>
    </div>
  )
}

/** Marker lines on a clip; drag a flag to move it, click to jump there. */
function ClipMarkers({ clip, zoom, locked, compact }: { clip: Clip; zoom: number; locked: boolean; compact: boolean }) {
  const markers = visibleMarkers(clip)
  if (!markers.length) return null
  const flag = compact ? 16 : 11
  const onDown = (e: React.PointerEvent, markerId: string, t0: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const s = useEditor.getState()
    s.select([clip.id])
    s.setPlaying(false)
    s.setPlayhead(clip.start + t0)
    if (locked) return
    const x0 = e.clientX
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 3) return
      const st = useEditor.getState()
      if (!moved) {
        moved = true
        st.beginGesture()
      }
      const fps = st.doc.settings.fps
      const cur = st.doc.clips.find((c) => c.id === clip.id)
      if (!cur) return
      let t = Math.round((t0 + dx / st.zoom) * fps) / fps
      if (st.snapping && !ev.altKey) {
        // Snap to clip edges and (if enabled) other markers on the timeline.
        const pts: number[] = []
        for (const c of st.doc.clips) {
          pts.push(c.start - cur.start, clipEnd(c) - cur.start)
          if (st.snapMarkers) for (const m of visibleMarkers(c)) if (m.id !== markerId) pts.push(c.start + m.t - cur.start)
        }
        const tol = SNAP_PX / st.zoom
        const hit = pts.reduce<number | null>((best, p) => (Math.abs(p - t) < tol && (best === null || Math.abs(p - t) < Math.abs(best - t)) ? p : best), null)
        if (hit !== null) t = hit
      }
      t = clamp(t, 0, cur.duration)
      st.updateMarker(clip.id, markerId, { t })
      st.setPlayhead(cur.start + t)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) useEditor.getState().endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <>
      {markers.map((m) => (
        <div key={m.id} className="pointer-events-none absolute top-0 bottom-0 z-[4]" style={{ left: m.t * zoom - 1 }}>
          <div className="absolute top-0 bottom-0 w-[2px] opacity-90" style={{ background: m.color }} />
          <button
            title={`${m.label || 'Marker'} — drag to move, click to jump`}
            aria-label={`Marker ${m.label}`}
            onPointerDown={(e) => onDown(e, m.id, m.t)}
            className={`pointer-events-auto absolute top-0 left-0 ${locked ? 'cursor-pointer' : 'cursor-ew-resize'}`}
            style={{
              width: flag,
              height: flag,
              background: m.color,
              clipPath: 'polygon(0 0, 100% 0, 100% 60%, 0 100%)',
              touchAction: 'none',
            }}
          />
        </div>
      ))}
    </>
  )
}

/** Marker flags in the ruler for every clip (click to jump + select the clip). */
function RulerMarkers({ zoom }: { zoom: number }) {
  const doc = useEditor((s) => s.doc)
  const markers = allMarkers(doc)
  return (
    <>
      {markers.map(({ clip, marker, time }) => (
        <button
          key={`${clip.id}/${marker.id}`}
          title={marker.label || 'Marker'}
          aria-label={`Jump to marker ${marker.label}`}
          onPointerDown={(e) => {
            e.stopPropagation()
            const s = useEditor.getState()
            s.setPlaying(false)
            s.select([clip.id])
            s.setPlayhead(time)
          }}
          className="absolute top-0 z-[5] h-[9px] w-[9px] -translate-x-1/2 rounded-b-sm border border-black/50"
          style={{ left: time * zoom, background: marker.color }}
        />
      ))}
    </>
  )
}

/** Keyframe diamonds along the bottom of the selected clip; click to jump there. */
function KeyMarkers({ clip, zoom, compact }: { clip: Clip; zoom: number; compact: boolean }) {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.doc.settings.fps)
  const times = allKeyTimes(clip).filter((t) => t >= -1e-6 && t <= clip.duration + 1e-6)
  if (!times.length) return null
  const size = compact ? 14 : 10
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0.5 z-[3]" style={{ height: size }}>
      {times.map((t) => {
        const current = Math.abs(clip.start + t - playhead) <= 0.5 / fps
        return (
          <button
            key={t}
            title={`Keyframe at ${t.toFixed(2)}s — click to jump`}
            aria-label={`Jump to keyframe at ${t.toFixed(2)} seconds`}
            onPointerDown={(e) => {
              e.stopPropagation()
              const s = useEditor.getState()
              s.setPlaying(false)
              s.setPlayhead(clip.start + t)
            }}
            className={`pointer-events-auto absolute top-0 rotate-45 rounded-[2px] border border-black/70 ${
              current ? 'bg-warn' : 'bg-white/90 hover:bg-warn'
            }`}
            style={{ left: t * zoom - size / 2, width: size * 0.72, height: size * 0.72, touchAction: 'none' }}
          />
        )
      })}
    </div>
  )
}

function Filmstrip({
  projectId,
  clip,
  asset,
  zoom,
  width,
  height,
}: {
  projectId: string
  clip: Clip
  asset: Asset
  zoom: number
  width: number
  height: number
}) {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const tileW = Math.max(8, height * aspect)
  const count = Math.min(300, Math.ceil(width / tileW))
  // Loaded via fetch -> blob URL (see lib/apiImage for why).
  const url = useApiImage(api.filmstripUrl(projectId, asset.id)).src
  const tiles = []
  for (let i = 0; i < count; i++) {
    let idx = 0
    if (clip.type === 'video' && asset.thumb_interval > 0) {
      const srcT = clip.in_point + ((i * tileW) / zoom) * clip.speed
      idx = clamp(Math.floor(srcT / asset.thumb_interval), 0, asset.thumb_count - 1)
    }
    tiles.push(
      <div
        key={i}
        className="h-full shrink-0"
        style={{
          width: tileW,
          backgroundImage: url ? `url(${url})` : undefined,
          backgroundSize: `${tileW * asset.thumb_count}px ${height}px`,
          backgroundPosition: `${-idx * tileW}px 0`,
        }}
      />,
    )
  }
  return (
    <div className="pointer-events-none flex opacity-80" style={{ height }}>
      {tiles}
    </div>
  )
}

const waveCache = new Map<string, Promise<Uint8Array>>()

function loadWave(projectId: string, assetId: string) {
  const key = `${projectId}/${assetId}`
  let p = waveCache.get(key)
  if (!p) {
    p = fetch(api.waveformUrl(projectId, assetId))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no waveform'))))
      .then((b) => new Uint8Array(b))
    p.catch(() => waveCache.delete(key))
    waveCache.set(key, p)
  }
  return p
}

const PEAKS_PER_SECOND = 100

function Waveform({
  projectId,
  clip,
  asset,
  zoom,
  width,
  height,
}: {
  projectId: string
  clip: Clip
  asset: Asset
  zoom: number
  width: number
  height: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Uint8Array | null>(null)
  useEffect(() => {
    let alive = true
    loadWave(projectId, asset.id)
      .then((p) => alive && setPeaks(p))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, asset.id])

  const cw = Math.min(Math.ceil(width), 8000)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !peaks) return
    const ctx = canvas.getContext('2d')!
    canvas.width = cw
    canvas.height = height
    ctx.clearRect(0, 0, cw, height)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const secondsPerPx = width / cw / zoom
    const mid = clip.type === 'audio' ? height / 2 : height
    for (let x = 0; x < cw; x++) {
      const t0 = clip.in_point + x * secondsPerPx * clip.speed
      const t1 = t0 + secondsPerPx * clip.speed
      const a = Math.floor(t0 * PEAKS_PER_SECOND)
      const b = Math.max(a + 1, Math.floor(t1 * PEAKS_PER_SECOND))
      let m = 0
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i]
      const amp = (m / 255) * Math.min(1, clip.volume) * (clip.type === 'audio' ? height / 2 : height)
      if (clip.type === 'audio') ctx.fillRect(x, mid - amp, 1, Math.max(1, amp * 2))
      else ctx.fillRect(x, height - amp, 1, Math.max(1, amp))
    }
  }, [peaks, cw, width, height, zoom, clip.in_point, clip.speed, clip.volume, clip.type])

  return <canvas ref={ref} className="pointer-events-none h-full" style={{ width }} />
}
