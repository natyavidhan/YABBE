import { ChevronDown, RotateCcw } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import { IconButton } from './ui'

const KEY = 'yabbe.sections'

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

/** Which inspector sections are folded (by title), remembered in this browser. */
export const useSections = create<{
  folded: Record<string, boolean>
  /** Sections currently on screen (title -> mount count), for "collapse all". */
  mounted: Record<string, number>
  register: (title: string) => void
  unregister: (title: string) => void
  toggle: (title: string) => void
  setAll: (titles: string[], folded: boolean) => void
}>((set, get) => ({
  folded: load(),
  mounted: {},
  register: (title) => set({ mounted: { ...get().mounted, [title]: (get().mounted[title] ?? 0) + 1 } }),
  unregister: (title) => {
    const mounted = { ...get().mounted }
    if ((mounted[title] ?? 0) <= 1) delete mounted[title]
    else mounted[title] -= 1
    set({ mounted })
  },
  toggle: (title) => {
    const folded = { ...get().folded, [title]: !get().folded[title] }
    set({ folded })
    try {
      localStorage.setItem(KEY, JSON.stringify(folded))
    } catch {
      /* ignore */
    }
  },
  setAll: (titles, on) => {
    const folded = { ...get().folded }
    for (const t of titles) folded[t] = on
    set({ folded })
    try {
      localStorage.setItem(KEY, JSON.stringify(folded))
    } catch {
      /* ignore */
    }
  },
}))

/** Collapsible inspector section. Click the header to fold/unfold it. */
export function Section({
  icon,
  title,
  children,
  onReset,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
  onReset?: () => void
}) {
  const folded = useSections((s) => !!s.folded[title])
  const toggle = useSections((s) => s.toggle)
  useEffect(() => {
    const { register, unregister } = useSections.getState()
    register(title)
    return () => unregister(title)
  }, [title])
  const id = `section-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <section className={`border-b border-line px-3 ${folded ? 'py-1.5' : 'py-3'}`}>
      <div className={`flex items-center gap-2 ${folded ? '' : 'mb-2.5'}`}>
        <button
          type="button"
          onClick={() => toggle(title)}
          aria-expanded={!folded}
          aria-controls={id}
          title={folded ? `Show ${title}` : `Hide ${title}`}
          className="-mx-1 flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/[0.03]"
        >
          <ChevronDown
            size={13}
            className={`shrink-0 text-faint transition-transform duration-150 ${folded ? '-rotate-90' : ''}`}
          />
          <span className="text-faint">{icon}</span>
          <h3 className="flex-1 truncate text-xs font-semibold">{title}</h3>
        </button>
        {onReset && !folded && (
          <IconButton label={`Reset ${title.toLowerCase()}`} onClick={onReset} className="h-6! w-6!">
            <RotateCcw size={12} />
          </IconButton>
        )}
      </div>
      {!folded && (
        <div id={id} className="flex flex-col gap-2">
          {children}
        </div>
      )}
    </section>
  )
}

/** Header button folding / unfolding every section on screen. */
export function FoldAllButton() {
  const folded = useSections((s) => s.folded)
  const setAll = useSections((s) => s.setAll)
  const titles = Object.keys(useSections((s) => s.mounted))
  const anyOpen = titles.some((t) => !folded[t])
  return (
    <IconButton
      label={anyOpen ? 'Collapse all sections' : 'Expand all sections'}
      onClick={() => setAll(titles, anyOpen)}
      className="h-6! w-6!"
    >
      <ChevronDown size={14} className={anyOpen ? '' : '-rotate-90'} />
    </IconButton>
  )
}
