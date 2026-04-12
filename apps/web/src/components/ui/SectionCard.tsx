import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from './CountBadge'

interface SectionCardProps {
  title:         string
  collapsible?:  boolean
  defaultOpen?:  boolean
  count?:        number
  headerRight?:  ReactNode
  children:      ReactNode
}

export function SectionCard({
  title,
  collapsible = true,
  defaultOpen = false,
  count,
  headerRight,
  children,
}: SectionCardProps) {
  const [open, setOpen] = useState(collapsible ? defaultOpen : true)

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={collapsible ? () => setOpen(p => !p) : undefined}
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          cursor:         collapsible ? 'pointer' : 'default',
          padding:        '14px 20px',
          borderBottom:   open ? '1px solid #e5e7eb' : 'none',
        }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', display: 'flex', alignItems: 'center' }}>
          {title}
          {count !== undefined && <CountBadge count={count} />}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {headerRight}
          {collapsible && (
            open
              ? <ChevronDown size={16} color="var(--color-slate-light)" />
              : <ChevronRight size={16} color="var(--color-slate-light)" />
          )}
        </div>
      </div>
      {open && (
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}
