import type { ReactNode, CSSProperties } from 'react'

interface PageTitleProps {
  /** Icon element (e.g. <AlertCircle size={22} color="var(--color-brand)" />) */
  icon: ReactNode
  children: ReactNode
  style?: CSSProperties
}

/**
 * Consistent page-level h1 with an icon perfectly centred on the text baseline.
 *
 * The icon is wrapped in a zero-line-height span so it participates only in
 * flex alignment and never inherits the h1 line-height that would push it up.
 */
export function PageTitle({ icon, children, style }: PageTitleProps) {
  return (
    <h1
      style={{
        display:       'flex',
        alignItems:    'center',
        gap:           '0.5rem',
        fontSize:      24,
        fontWeight:    600,
        color:         'var(--color-slate-dark)',
        letterSpacing: '-0.01em',
        margin:        0,
        lineHeight:    1.25,
        ...style,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0 }}>
        {icon}
      </span>
      {children}
    </h1>
  )
}
