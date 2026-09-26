import { useEffect, useRef } from 'react'
import { api } from '../api/client'
import { toast } from '../components/toast'
import { textStyleAt } from './keyframes'
import { runEasyEase } from './graph/actions'
import { allMarkers, docDuration, textKey, useEditor } from './store'

const AUTOSAVE_DELAY = 700

/** Debounced autosave of the editable doc; flushes on unmount / tab close. */
export function useAutosave(projectId: string) {
  const version = useEditor((s) => s.version)
  const saving = useRef<Promise<void> | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const flush = useRef(async () => {
    const s = useEditor.getState()
    if (s.version === s.savedVersion || s.projectId !== projectId) return
    const v = s.version
    const { name, settings, tracks, clips } = s.doc
    try {
      if (saving.current) await saving.current
      saving.current = api.saveProject(projectId, { name, settings, tracks, clips }).then(() => {
        useEditor.getState().markSaved(v)
      })
      await saving.current
    } catch (e) {
      toast.error(`Autosave failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      saving.current = null
    }
  })

  useEffect(() => {
    if (version === 0) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush.current(), AUTOSAVE_DELAY)
  }, [version])

  useEffect(() => {
    const f = flush.current
    const beforeUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState()
      if (s.version !== s.savedVersion) {
        f()
        e.preventDefault()
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.clearTimeout(timer.current)
      f()
    }
  }, [])

  return flush.current
}

/** Poll the server while any asset is still being processed. */
export function useAssetPolling(projectId: string) {
  const processing = useEditor((s) => s.assets.some((a) => a.status === 'processing'))
  useEffect(() => {
    if (!processing) return
    const id = window.setInterval(async () => {
      try {
        const p = await api.getProject(projectId)
        const before = new Map(useEditor.getState().assets.map((a) => [a.id, a.status]))
        useEditor.getState().setAssets(p.assets)
        for (const a of p.assets) {
          if (before.get(a.id) === 'processing' && a.status === 'error') toast.error(`${a.original_name}: ${a.error}`)
        }
      } catch {
        /* transient */
      }
    }, 1500)
    return () => window.clearInterval(id)
  }, [processing, projectId])
}

/** Keep the rasterised size of every text clip known (for on-canvas handles). */
export function useTextMeasurements() {
  const clips = useEditor((s) => s.doc.clips)
  const sizes = useEditor((s) => s.textSizes)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const pending = useRef(new Set<string>())
  useEffect(() => {
    if (playing) return // the selection box is hidden while playing
    const styles = clips.flatMap((c) =>
      c.type === 'text' && c.text ? [c.text, textStyleAt(c, playhead)!].filter(Boolean) : [],
    )
    for (const style of styles) {
      const key = textKey(style)
      if (sizes[key] || pending.current.has(key)) continue
      pending.current.add(key)
      api
        .measureText(style)
        .then((size) => useEditor.getState().setTextSize(key, size))
        .catch(() => {})
        .finally(() => pending.current.delete(key))
    }
  }, [clips, sizes, playhead, playing])
}

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'file'])

/** Should this key press go to the focused element instead of the editor? */
function belongsToField(target: EventTarget | null, key: string) {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type
    if (!NON_TEXT_INPUTS.has(type)) return true
    // Sliders keep their arrow keys; everything else goes to the editor.
    return type === 'range' && key.startsWith('Arrow')
  }
  return false
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (belongsToField(e.target, e.key)) return
      // A focused button would also "click" on Space; keep Space for play/pause.
      if (e.key === ' ' && e.target instanceof HTMLElement && e.target.tagName !== 'BODY') e.target.blur()
      const s = useEditor.getState()
      const mod = e.ctrlKey || e.metaKey
      const fps = s.doc.settings.fps
      const key = e.key.toLowerCase()
      let handled = true
      if (e.key === 'F9') {
        if (!runEasyEase(mod && e.shiftKey ? 'out' : e.shiftKey ? 'in' : 'both'))
          toast.info('Put the playhead on a keyframe of the selected clip (or select keys in the graph)')
      } else if (mod && key === 'z' && !e.shiftKey) s.undo()
      else if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) s.redo()
      else if (mod && key === 'd') s.duplicateSelected()
      else if (mod && key === 'a') s.select(s.doc.clips.map((c) => c.id))
      else if (mod && key === 'b') s.splitAtPlayhead()
      else if (mod) handled = false
      else if (e.key === ' ') s.setPlaying(!s.playing)
      else if (key === 's') s.splitAtPlayhead()
      else if (e.key === 'Delete' || e.key === 'Backspace') s.deleteSelected()
      else if (e.key === 'Escape') s.select([])
      else if (e.key === 'ArrowLeft') {
        s.setPlaying(false)
        s.setPlayhead(Math.max(0, (Math.round(s.playhead * fps) - (e.shiftKey ? Math.round(fps) : 1)) / fps))
      } else if (e.key === 'ArrowRight') {
        s.setPlaying(false)
        s.setPlayhead((Math.round(s.playhead * fps) + (e.shiftKey ? Math.round(fps) : 1)) / fps)
      } else if (e.key === 'Home') s.setPlayhead(0)
      else if (e.key === 'End') s.setPlayhead(docDuration(s.doc))
      else if (e.key === '=' || e.key === '+') s.setZoom(s.zoom * 1.25)
      else if (e.key === '-') s.setZoom(s.zoom / 1.25)
      else if (key === 'g') s.setGraphOpen(!s.graphOpen)
      else if (key === 't') s.addTextClip()
      else if (key === 'm') {
        const err = s.addMarker()
        if (err) toast.info(err)
      } else if (e.key === '[' || e.key === ']') {
        // Jump to the previous / next marker on any clip.
        const tol = 0.5 / fps
        const times = allMarkers(s.doc).map((m) => m.time)
        const target =
          e.key === ']' ? times.find((t) => t > s.playhead + tol) : [...times].reverse().find((t) => t < s.playhead - tol)
        if (target !== undefined) {
          s.setPlaying(false)
          s.setPlayhead(target)
        }
      }
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
