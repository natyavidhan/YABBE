import { Pipette, X } from 'lucide-react'
import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChromaKey, Clip, Timeline } from '../api/types'
import { useEditor } from './store'

export const DEFAULT_KEY: ChromaKey = {
  enabled: true,
  color: '#00b140',
  clip_black: 0.15,
  clip_white: 0.9,
  spill: 0.6,
  choke: 0,
  feather: 0,
}

/** Preview-only state: picking the key colour, or showing a clip's matte. Never saved. */
export const useKeyView = create<{ pick: string | null; matte: string | null }>(() => ({ pick: null, matte: null }))

/** The render request as the preview should show it: while picking, the clip's key
 * is off (so you click the real screen colour); in matte view it shows black/white. */
export function keyPreview(timeline: Timeline, pick: string | null, matte: string | null): Timeline {
  if (!pick && !matte) return timeline
  const patch = (c: Clip): Clip => {
    if (!c.chroma_key) return c
    if (c.id === pick) return { ...c, chroma_key: { ...c.chroma_key, enabled: false } }
    if (c.id === matte) return { ...c, chroma_key: { ...c.chroma_key, matte: true } }
    return c
  }
  return {
    ...timeline,
    sequences: timeline.sequences?.map((s) => (s.id === timeline.sequence_id ? { ...s, clips: s.clips.map(patch) } : s)),
  }
}

const hex = (n: number) => n.toString(16).padStart(2, '0')

/** Crosshair layer over the preview while picking: click to sample the frame's colour. */
export function KeyPicker() {
  const pick = useKeyView((s) => s.pick)
  useEffect(() => {
    if (!pick) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && useKeyView.setState({ pick: null })
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [pick])
  if (!pick) return null

  const sample = (e: React.MouseEvent<HTMLDivElement>) => {
    const img = e.currentTarget.parentElement?.querySelector<HTMLImageElement>('img[alt="Preview"]')
    if (!img || !img.naturalWidth) return
    const r = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * img.naturalWidth)
    const y = Math.floor(((e.clientY - r.top) / r.height) * img.naturalHeight)
    // Average a small patch: a single JPEG pixel is noisy.
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(img, 0, 0)
    const R = 2
    const x0 = Math.max(0, x - R)
    const y0 = Math.max(0, y - R)
    const d = ctx.getImageData(x0, y0, Math.min(c.width - x0, R * 2 + 1), Math.min(c.height - y0, R * 2 + 1)).data
    let rs = 0
    let gs = 0
    let bs = 0
    const n = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      rs += d[i]
      gs += d[i + 1]
      bs += d[i + 2]
    }
    const color = `#${hex(Math.round(rs / n))}${hex(Math.round(gs / n))}${hex(Math.round(bs / n))}`
    const s = useEditor.getState()
    const clip = s.doc.clips.find((cl) => cl.id === pick)
    if (clip) s.updateClip(clip.id, { chroma_key: { ...DEFAULT_KEY, ...clip.chroma_key, color } })
    useKeyView.setState({ pick: null })
  }

  return (
    <div className="absolute inset-0 z-20 cursor-crosshair" onClick={sample} role="button" aria-label="Pick the screen colour">
      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <span className="flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-xs text-white">
          <Pipette size={12} /> Click the green / blue screen
          <button
            type="button"
            className="pointer-events-auto ml-1 rounded-full p-0.5 hover:bg-white/20"
            aria-label="Cancel picking"
            onClick={(e) => {
              e.stopPropagation()
              useKeyView.setState({ pick: null })
            }}
          >
            <X size={12} />
          </button>
        </span>
      </div>
    </div>
  )
}
