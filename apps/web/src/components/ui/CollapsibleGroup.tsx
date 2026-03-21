import { useState } from 'react'
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

  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
          padding: '4px 0',
          marginLeft: 12,
          userSelect: 'none',
        }}
      >
        <span style={{
          fontSize: 10,
          color: '#94a3b8',
          transition: 'transform 0.15s',
          display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          ▶
        </span>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: '#64748b',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}>
          {title}
          {count !== undefined && (
            <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>
              ({count})
            </span>
          )}
        </span>
      </div>

      {open && (
        <div style={{
          paddingLeft: 24,
          borderLeft: '2px solid #f3f4f6',
          marginLeft: 16,
          marginTop: 4,
        }}>
          {children}
        </div>
      )}
    </div>
  )
}
