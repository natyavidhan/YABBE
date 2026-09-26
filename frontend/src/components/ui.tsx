import { X } from 'lucide-react'
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-2 disabled:bg-accent/50',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-[#2b3040]',
  ghost: 'text-muted hover:text-fg hover:bg-raised',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const sizing = size === 'sm' ? 'h-7 px-2.5 text-xs gap-1.5' : 'h-9 px-3.5 gap-2'
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${sizing} ${variants[variant]} ${className}`}
    />
  )
}

export function IconButton({
  label,
  active = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...props}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        active ? 'bg-accent/20 text-accent-2' : 'text-muted hover:bg-raised hover:text-fg'
      } ${className}`}
    />
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-md',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`toast-in w-full ${width} rounded-xl border border-line bg-panel shadow-2xl shadow-black/60`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'h-8 w-full rounded-md border border-line bg-bg px-2.5 text-fg outline-none transition-colors placeholder:text-faint focus:border-accent'

/**
 * Numeric input that only commits on blur/Enter, supports drag-to-scrub on its
 * label, and shows a unit suffix.
 */
export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  precision = 2,
  suffix,
  label,
  scrubScale = 1,
  onScrubStart,
  onScrubEnd,
}: {
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  precision?: number
  suffix?: string
  label?: string
  scrubScale?: number
  onScrubStart?: () => void
  onScrubEnd?: () => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const clampV = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const shown = draft ?? String(Number(value.toFixed(precision)))

  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft)
    if (!Number.isNaN(v)) onChange(clampV(v))
    setDraft(null)
  }

  const startScrub = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startV = value
    onScrubStart?.()
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      onChange(clampV(Number((startV + dx * step * scrubScale * mult).toFixed(precision))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onScrubEnd?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="flex h-7 min-w-0 items-center rounded-md border border-line bg-bg focus-within:border-accent">
      {label && (
        <span
          onPointerDown={startScrub}
          className="flex h-full cursor-ew-resize items-center pr-1 pl-2 text-[11px] font-medium text-faint select-none hover:text-muted"
          title="Drag to adjust (Shift ×10, Alt ×0.1)"
        >
          {label}
        </span>
      )}
      <input
        ref={inputRef}
        className="tabular h-full w-full min-w-0 bg-transparent px-1.5 text-xs text-fg outline-none"
        value={shown}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            setDraft(null)
            inputRef.current?.blur()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const dir = e.key === 'ArrowUp' ? 1 : -1
            const mult = e.shiftKey ? 10 : 1
            onChange(clampV(Number((value + dir * step * mult).toFixed(precision))))
            setDraft(null)
          }
        }}
      />
      {suffix && <span className="pr-2 text-[11px] text-faint select-none">{suffix}</span>}
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  )
}

export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div className={`h-1 overflow-hidden rounded-full bg-line ${className}`}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </div>
  )
}
