import { useId, useState } from 'react'
import type { ReactNode } from 'react'

interface CollapsibleGroupProps {
  title: string
  count?: number
  children: ReactNode
  defaultOpen?: boolean
}

export function CollapsibleGroup({
  title,
  count,
  children,
  defaultOpen = false,
}: CollapsibleGroupProps) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <div style={{ marginBottom: 8 }}>
      {/* Header is a real button: focusable, Space/Enter toggle, state exposed (E-14). */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((p) => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          padding: '4px 0',
          marginLeft: 12,
          userSelect: 'none',
          background: 'none',
          border: 'none',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span aria-hidden="true" style={{
          fontSize: 'var(--font-size-label)',
          color: 'var(--color-slate)',
          transition: 'transform 0.15s',
          display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          ▶
        </span>
        <span style={{
          fontSize: 'var(--font-size-label)',
          fontWeight: 600,
          color: 'var(--color-slate)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          {title}
          {count !== undefined && (
            <span style={{ marginLeft: 6, fontSize: 'var(--font-size-label)', color: 'var(--color-slate)', fontWeight: 400 }}>
              ({count})
            </span>
          )}
        </span>
      </button>

      {open && (
        <div id={panelId} style={{
          paddingLeft: 24,
          borderLeft: '2px solid var(--color-border-light)',
          marginLeft: 16,
          marginTop: 4,
        }}>
          {children}
        </div>
      )}
    </div>
  )
}
