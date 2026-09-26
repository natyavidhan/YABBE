export function formatTimecode(seconds: number, fps: number): string {
  const s = Math.max(0, seconds)
  const totalFrames = Math.floor(s * fps + 1e-6)
  const f = totalFrames % Math.round(fps)
  const whole = Math.floor(totalFrames / fps)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${hh > 0 ? pad(hh) + ':' : ''}${pad(mm)}:${pad(ss)}:${pad(f)}`
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '0:00'
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatRelative(epochSeconds: number): string {
  const diff = Date.now() / 1000 - epochSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits

/** Random id. Uses getRandomValues because randomUUID only exists in secure
 * contexts (HTTPS / localhost), and YABBE is often opened over plain-HTTP LAN. */
export function uid(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
