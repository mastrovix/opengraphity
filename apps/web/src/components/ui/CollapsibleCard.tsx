import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from './CountBadge'

interface CollapsibleCardProps {
  title: string
  count?: number
  defaultOpen?: boolean
  children: ReactNode
}

export function CollapsibleCard({ title, count, defaultOpen = false, children }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)' }}>
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
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)', display: 'flex', alignItems: 'center' }}>
          {title}
          {count !== undefined && <CountBadge count={count} />}
        </span>
        {open
          ? <ChevronDown size={16} color="var(--color-slate-light)" />
          : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {open && <div style={{ padding: '16px 20px' }}>{children}</div>}
    </div>
  )
}
