import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { create } from 'zustand'

type Kind = 'info' | 'success' | 'error'

interface Toast {
  id: number
  kind: Kind
  message: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: Kind, message: string) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-3), { id, kind, message }] })
    setTimeout(() => get().dismiss(id), kind === 'error' ? 7000 : 3500)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))

export const toast = {
  info: (m: string) => useToasts.getState().push('info', m),
  success: (m: string) => useToasts.getState().push('success', m),
  error: (m: unknown) =>
    useToasts.getState().push('error', m instanceof Error ? m.message : typeof m === 'string' ? m : 'Something went wrong'),
}

const icons = {
  info: <Info size={16} className="text-accent-2" />,
  success: <CheckCircle2 size={16} className="text-ok" />,
  error: <XCircle size={16} className="text-danger" />,
}

export function Toaster() {
  const { toasts, dismiss } = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="toast-in pointer-events-auto flex items-start gap-2 rounded-lg border border-line bg-raised px-3 py-2.5 shadow-xl shadow-black/40"
        >
          <span className="mt-px">{icons[t.kind]}</span>
          <span className="flex-1 leading-snug break-words">{t.message}</span>
          <button className="text-muted hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
