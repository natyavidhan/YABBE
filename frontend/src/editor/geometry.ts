import type { Asset, Clip, ProjectSettings } from '../api/types'
import { textStyleAt, transformAt } from './keyframes'
import { textKey } from './store'

/** Mirrors backend compositor.layer_geometry (project pixels). */
export interface Layer {
  clip: Clip
  /** The clip's transform evaluated at the viewed time (keyframes applied). */
  transform: Clip['transform']
  cx: number
  cy: number
  width: number
  height: number
  rotation: number
  /** Width/height of the layer at scale 1 (after crop & fit). */
  baseWidth: number
  baseHeight: number
}

export function sourceSize(
  clip: Clip,
  assets: Map<string, Asset>,
  textSizes: Record<string, { width: number; height: number }>,
  time?: number,
): { width: number; height: number } | null {
  if (clip.type === 'text') {
    const style = time === undefined ? clip.text : textStyleAt(clip, time)
    if (!style) return null
    // Fall back to the static size while the animated one is being measured.
    return textSizes[textKey(style)] ?? (clip.text ? (textSizes[textKey(clip.text)] ?? null) : null)
  }
  const a = clip.asset_id ? assets.get(clip.asset_id) : undefined
  if (!a || !a.width || !a.height) return null
  return { width: a.width, height: a.height }
}

export function layerOf(
  clip: Clip,
  settings: ProjectSettings,
  assets: Map<string, Asset>,
  textSizes: Record<string, { width: number; height: number }>,
  time?: number,
): Layer | null {
  const size = sourceSize(clip, assets, textSizes, time)
  const tr = time === undefined ? clip.transform : transformAt(clip, time)
  if (!size) return null
  const cw = size.width * Math.max(0.01, 1 - clip.crop.left - clip.crop.right)
  const ch = size.height * Math.max(0.01, 1 - clip.crop.top - clip.crop.bottom)
  const fit = clip.type === 'text' ? 1 : Math.min(settings.width / cw, settings.height / ch)
  const bw = cw * fit
  const bh = ch * fit
  const s = tr.scale
  return {
    clip,
    transform: tr,
    cx: settings.width / 2 + tr.x,
    cy: settings.height / 2 + tr.y,
    width: bw * s,
    height: bh * s,
    rotation: tr.rotation,
    baseWidth: bw,
    baseHeight: bh,
  }
}

/** Is point (px, py) inside the rotated rectangle of the layer? */
export function hitTest(layer: Layer, px: number, py: number): boolean {
  const r = (-layer.rotation * Math.PI) / 180
  const dx = px - layer.cx
  const dy = py - layer.cy
  const lx = dx * Math.cos(r) - dy * Math.sin(r)
  const ly = dx * Math.sin(r) + dy * Math.cos(r)
  return Math.abs(lx) <= layer.width / 2 && Math.abs(ly) <= layer.height / 2
}

/** Scale that makes the layer cover the whole canvas (relative to "fit"). */
export function fillScale(clip: Clip, settings: ProjectSettings, size: { width: number; height: number }) {
  const cw = size.width * Math.max(0.01, 1 - clip.crop.left - clip.crop.right)
  const ch = size.height * Math.max(0.01, 1 - clip.crop.top - clip.crop.bottom)
  const fit = Math.min(settings.width / cw, settings.height / ch)
  const cover = Math.max(settings.width / cw, settings.height / ch)
  return cover / fit
}
