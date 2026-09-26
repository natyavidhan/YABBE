import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** Right-click menu at (x, y); closes on outside click, Escape, scroll or resize. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: (MenuItem | 'divider')[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      className="toast-in fixed z-[60] min-w-48 overflow-hidden rounded-lg border border-line bg-raised py-1 text-xs shadow-2xl shadow-black/60 select-none"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it === 'divider' ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            role="menuitem"
            type="button"
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-white/5 disabled:opacity-40 disabled:hover:bg-transparent ${
              it.danger ? 'text-danger' : ''
            }`}
          >
            <span className={`w-4 ${it.danger ? '' : 'text-muted'}`}>{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-faint">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  )
}
