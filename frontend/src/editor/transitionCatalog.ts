import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { TransitionCatalog } from '../api/types'

let cache: Promise<TransitionCatalog> | null = null

/** The server's transition catalogue (fetched once per page load). */
export function useTransitionCatalog(): TransitionCatalog | null {
  const [data, setData] = useState<TransitionCatalog | null>(null)
  useEffect(() => {
    cache ??= api.transitions().catch((e) => {
      cache = null
      throw e
    })
    let alive = true
    cache.then((d) => alive && setData(d)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return data
}
