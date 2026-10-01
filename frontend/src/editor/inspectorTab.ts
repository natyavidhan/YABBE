import { create } from 'zustand'

/** Right panel: the selected clip's Properties, or the Effects browser. */
export type InspectorTab = 'properties' | 'effects'
const KEY = 'yabbe.inspectorTab'

function load(): InspectorTab {
  try {
    return localStorage.getItem(KEY) === 'effects' ? 'effects' : 'properties'
  } catch {
    return 'properties'
  }
}

export const useInspectorTab = create<{ tab: InspectorTab; setTab: (t: InspectorTab) => void }>((set) => ({
  tab: load(),
  setTab: (tab) => {
    set({ tab })
    try {
      localStorage.setItem(KEY, tab)
    } catch {
      /* ignore */
    }
  },
}))
