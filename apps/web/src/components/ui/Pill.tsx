import type { CSSProperties, ReactNode } from 'react'

/**
 * Generic status/label pill for the one-off colored spans that the
 * dedicated badges (StatusBadge, SeverityBadge, EnvBadge...) don't cover.
 * Defaults mirror the dominant inline pattern; `radius` and `style`
 * absorb the local variants (4/6/12/100).
 */
export function Pill({ bg, color, radius = 6, style, title, children }: {
  bg:       string
  color:    string
  radius?:  number
  style?:   CSSProperties
  /** Spiegazione al passaggio del mouse (il testo della pill resta il nome visibile). */
  title?:   string
  children: ReactNode
}) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1, padding: '3px 8px', borderRadius: radius, fontSize: 'var(--font-size-table)', fontWeight: 600, background: bg, color, whiteSpace: 'nowrap', ...style }}>
      {children}
    </span>
  )
}
