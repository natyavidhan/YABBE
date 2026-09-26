import { useSyncExternalStore } from 'react'

function subscribe(query: string) {
  return (cb: () => void) => {
    const mql = window.matchMedia(query)
    mql.addEventListener('change', cb)
    return () => mql.removeEventListener('change', cb)
  }
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(subscribe(query), () => window.matchMedia(query).matches, () => false)
}

/** Phone-sized layout: narrow screens, or short landscape phones. */
export const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)'

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY)

export const isTouchEvent = (e: { pointerType?: string }) => e.pointerType === 'touch' || e.pointerType === 'pen'
