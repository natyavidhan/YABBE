// Server images are fetched with fetch() and shown from blob: URLs instead of
// plain <img src="/api/...">. Some browsers (e.g. Firefox/Zen with HTTPS
// upgrades on) rewrite plain image requests on an http:// LAN address to
// https://, which fails; fetch() isn't rewritten. Blobs are cached per URL.
import { useEffect, useState, type ImgHTMLAttributes } from 'react'

const cache = new Map<string, Promise<string>>()

export function loadApiImage(url: string): Promise<string> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
      .then((b) => URL.createObjectURL(b))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

/** Drop cached copies whose URL starts with ``prefix`` (e.g. after regeneration). */
export function forgetApiImages(prefix: string) {
  for (const [url, p] of cache) {
    if (url.startsWith(prefix)) {
      cache.delete(url)
      p.then((u) => URL.revokeObjectURL(u)).catch(() => {})
    }
  }
}

/** { src, failed } for a server image URL (src is a blob: URL once loaded). */
export function useApiImage(url: string | null | undefined, retries = 2): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; src: string | null; failed: boolean }>({
    url: null,
    src: null,
    failed: false,
  })
  useEffect(() => {
    if (!url) return
    let alive = true
    let attempt = 0
    let timer: number | undefined
    const tryLoad = () => {
      loadApiImage(url)
        .then((src) => alive && setState({ url, src, failed: false }))
        .catch(() => {
          if (!alive) return
          if (attempt++ < retries) timer = window.setTimeout(tryLoad, 800 * attempt)
          else setState({ url, src: null, failed: true })
        })
    }
    tryLoad()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [url, retries])
  return state.url === url ? { src: state.src, failed: state.failed } : { src: null, failed: false }
}

/** <img> for a server image, loaded via fetch (see module note). */
export function ApiImg({
  url,
  fallback = null,
  onFailed,
  ...rest
}: { url: string; fallback?: React.ReactNode; onFailed?: () => void } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const { src, failed } = useApiImage(url)
  useEffect(() => {
    if (failed) onFailed?.()
  }, [failed, onFailed])
  if (failed) return <>{fallback}</>
  if (!src) return null
  return <img src={src} {...rest} />
}
