import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from './CountBadge'

interface CollapsibleCardProps {
  title: string
  count?: number
  defaultOpen?: boolean
  headerRight?: ReactNode
  children: ReactNode
}

export function CollapsibleCard({ title, count, defaultOpen = false, headerRight, children }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="card-border" style={{ marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(p => !p)}
        style={{
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'space-between',
          cursor:       'pointer',
          padding:      '14px 20px',
          borderBottom: open ? '1px solid #e5e7eb' : 'none',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', display: 'flex', alignItems: 'center' }}>
          {title}
          {count !== undefined && <CountBadge count={count} />}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {headerRight}
          {open
            ? <ChevronDown size={16} color="var(--color-slate-light)" />
            : <ChevronRight size={16} color="var(--color-slate-light)" />}
        </div>
      </div>
      {open && <div style={{ padding: '16px 20px' }}>{children}</div>}
    </div>
  )
}
