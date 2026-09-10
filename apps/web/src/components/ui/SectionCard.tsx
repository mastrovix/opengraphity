import { useId, useState, type ReactNode, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountBadge } from './CountBadge'
import { colors } from '@/lib/tokens'

interface SectionCardProps {
  title:         ReactNode
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
  /** Colore dell'intestazione quando la scheda è aperta (attiva). Default: turchese logo. */
  activeColor?:     string
  activeTextColor?: string
  children:      ReactNode
}

export function SectionCard({
  title,
  collapsible = true,
  defaultOpen = false,
  activeColor = colors.brand,
  activeTextColor = colors.white,
  open: controlledOpen,
  onToggle,
  count,
  headerRight,
  headerStyle,
  children,
}: SectionCardProps) {
  const [internalOpen, setInternalOpen] = useState(collapsible ? defaultOpen : true)
  const panelId = useId()
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const handleToggle = () => {
    if (!collapsible) return
    if (isControlled) onToggle?.()
    else              setInternalOpen(p => !p)
  }

  const headerColor    = (headerStyle?.color as string | undefined) ?? (open ? activeTextColor : 'var(--color-slate-dark)')
  const chevronColor   = (headerStyle?.color as string | undefined) ?? (open ? activeTextColor : 'var(--color-slate-light)')

  const titleContent = (
    <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: headerColor, display: 'flex', alignItems: 'center' }}>
      {title}
      {count !== undefined && <CountBadge count={count} />}
    </span>
  )

  return (
    <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, marginBottom: 16, overflow: 'hidden' }}>
      <div
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '14px 20px',
          borderBottom:   open ? '1px solid var(--border)' : 'none',
          transition:     'background-color 150ms, color 150ms',
          // Scheda aperta (attiva): intestazione colorata (default turchese logo).
          background:     open ? activeColor : undefined,
          ...headerStyle,
        }}
      >
        {/* The toggle is a real <button> (E-14): focusable, Space/Enter, aria-expanded.
            `headerRight` stays OUTSIDE it so its own controls are not nested in a button. */}
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={handleToggle}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
              font: 'inherit', color: 'inherit', textAlign: 'left',
            }}
          >
            {titleContent}
            <span style={{ display: 'flex', alignItems: 'center', color: headerColor }}>
              {open
                ? <ChevronDown size={16} color={chevronColor} aria-hidden="true" />
                : <ChevronRight size={16} color={chevronColor} aria-hidden="true" />}
            </span>
          </button>
        ) : (
          <div style={{ flex: 1 }}>{titleContent}</div>
        )}
        {headerRight && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8, color: headerColor }}>
            {headerRight}
          </div>
        )}
      </div>
      {open && (
        <div id={panelId} style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {children}
          </div>
        </div>
      )}
    </div>
  )
}
