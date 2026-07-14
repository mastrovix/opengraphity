import type { CSSProperties, ReactNode } from 'react'

/**
 * Generic status/label pill for the one-off colored spans that the
 * dedicated badges (StatusBadge, SeverityBadge, EnvBadge...) don't cover.
 * Defaults mirror the dominant inline pattern; `radius` and `style`
 * absorb the local variants (4/6/12/100).
 */
export function Pill({ bg, color, radius = 6, style, children }: {
  bg:       string
  color:    string
  radius?:  number
  style?:   CSSProperties
  children: ReactNode
}) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: radius, fontSize: 'var(--font-size-table)', fontWeight: 600, background: bg, color, whiteSpace: 'nowrap', ...style }}>
      {children}
    </span>
  )
}
