import { Link } from 'react-router-dom'

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2 select-none" title="YABBE — Yet Another Browser Based Editor">
      <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#7c5cff" />
        <path d="M9 10h14M9 16h9M9 22h12" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">YABBE</span>
      {!compact && <span className="hidden text-xs text-faint sm:inline">Yet Another Browser Based Editor</span>}
    </Link>
  )
}
