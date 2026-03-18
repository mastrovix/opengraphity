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
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
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
        <span style={{ fontSize: 14, fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center' }}>
          {title}
          {count !== undefined && <CountBadge count={count} />}
        </span>
        {open
          ? <ChevronDown size={16} color="#8892a4" />
          : <ChevronRight size={16} color="#8892a4" />}
      </div>
      {open && <div style={{ padding: '16px 20px' }}>{children}</div>}
    </div>
  )
}
