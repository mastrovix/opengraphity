import { useState, type ReactNode, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from './CountBadge'

interface SectionCardProps {
  title:         string
  collapsible?:  boolean
  defaultOpen?:  boolean
  /** Controlled open state. When provided, the card is controlled and ignores defaultOpen/internal state. */
  open?:         boolean
  /** Callback fired when the user clicks the header while in controlled mode. */
  onToggle?:     () => void
  count?:        number
  headerRight?:  ReactNode
  /** Optional style merged onto the header wrapper. If `color` is set, it also applies to title, chevron and CountBadge. */
  headerStyle?:  CSSProperties
  children:      ReactNode
}

export function SectionCard({
  title,
  collapsible = true,
  defaultOpen = false,
  open: controlledOpen,
  onToggle,
  count,
  headerRight,
  headerStyle,
  children,
}: SectionCardProps) {
  const [internalOpen, setInternalOpen] = useState(collapsible ? defaultOpen : true)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const handleToggle = () => {
    if (!collapsible) return
    if (isControlled) onToggle?.()
    else              setInternalOpen(p => !p)
  }

  const headerColor    = (headerStyle?.color as string | undefined) ?? 'var(--color-slate-dark)'
  const chevronColor   = (headerStyle?.color as string | undefined) ?? 'var(--color-slate-light)'

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div
        onClick={collapsible ? handleToggle : undefined}
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          cursor:         collapsible ? 'pointer' : 'default',
          padding:        '14px 20px',
          borderBottom:   open ? '1px solid #e5e7eb' : 'none',
          transition:     'background-color 150ms, color 150ms',
          ...headerStyle,
        }}
      >
        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: headerColor, display: 'flex', alignItems: 'center' }}>
          {title}
          {count !== undefined && <CountBadge count={count} />}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: headerColor }}>
          {headerRight}
          {collapsible && (
            open
              ? <ChevronDown size={16} color={chevronColor} />
              : <ChevronRight size={16} color={chevronColor} />
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
