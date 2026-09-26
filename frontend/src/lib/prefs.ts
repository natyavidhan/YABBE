import { create } from 'zustand'

/** Per-browser UI preferences (never part of the project). */
interface Prefs {
  /** Master preview volume, 0..1 — only affects playback in this browser. */
  volume: number
  muted: boolean
  /** Draw the selected clip's motion path on the preview. */
  motionPath: boolean
  setVolume: (v: number) => void
  setMuted: (m: boolean) => void
  setMotionPath: (on: boolean) => void
}

const KEY = 'yabbe.prefs'

function load(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

const saved = load()

export const usePrefs = create<Prefs>((set) => ({
  volume: typeof saved.volume === 'number' ? Math.min(1, Math.max(0, saved.volume)) : 1,
  muted: saved.muted === true,
  motionPath: saved.motionPath !== false,
  setMotionPath: (motionPath) => set({ motionPath }),
  setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)), muted: false }),
  setMuted: (muted) => set({ muted }),
}))

usePrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume: s.volume, muted: s.muted, motionPath: s.motionPath }))
  } catch {
    /* private mode etc. */
  }
})
