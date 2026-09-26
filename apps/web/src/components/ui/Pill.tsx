import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

/**
 * Generic status/label pill for the one-off colored spans that the
 * dedicated badges (StatusBadge, SeverityBadge, EnvBadge...) don't cover.
 * Defaults mirror the dominant inline pattern; `radius` and `style`
 * absorb the local variants (4/6/12/100).
 */
export function Pill({ bg, color, radius = 6, style, title, children, ...rest }: {
  bg:       string
  color:    string
  radius?:  number
  style?:   CSSProperties
  /** Spiegazione al passaggio del mouse (il testo della pill resta il nome visibile). */
  title?:   string
  children: ReactNode
  // The span's own attributes pass through (26 Sep 2026): the hand-made badges
  // that became Pills carried an aria-label, a role, an id to describe by.
} & Omit<HTMLAttributes<HTMLSpanElement>, 'style' | 'title' | 'children' | 'color'>) {
  return (
    <span {...rest} title={title} style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 1, padding: '3px 8px', borderRadius: radius, fontSize: 'var(--font-size-table)', fontWeight: 600, background: bg, color, whiteSpace: 'nowrap', ...style }}>
      {children}
    </span>
  )
}
