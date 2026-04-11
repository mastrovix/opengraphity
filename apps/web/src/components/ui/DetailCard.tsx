import type { ReactNode } from 'react'

interface DetailCardProps {
  title: string
  children: ReactNode
}

export function DetailCard({ title, children }: DetailCardProps) {
  return (
    <div style={{
      background:   '#fff',
      border:       '1px solid #e5e7eb',
      borderRadius: 10,
      padding:      16,
    }}>
      <h3 style={{
        fontSize:       'var(--font-size-card-title)',
        fontWeight:     600,
        color:          'var(--color-slate-light)',
        textTransform:  'uppercase',
        letterSpacing:  '0.04em',
        margin:         '0 0 12px',
      }}>
        {title}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {children}
      </div>
    </div>
  )
}
