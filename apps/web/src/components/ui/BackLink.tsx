/**
 * «← BACK TO …» AND THE TITLE OF A DETAIL PAGE (26 Sep 2026, wave 3 of «tutte
 * in fila»).
 *
 * Sixteen pages wrote their own way back — an arrow or a «←», grey or blue,
 * 12 or 13 or 14 px, 4 to 32 px below — and fourteen their own <h1>, weight
 * 600 or 700, tracked or not. A list page has `PageTitle` (with its icon); a
 * detail or create page has these two.
 */
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

const BACK_STYLE: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, padding: 0,
  background: 'none', border: 'none', cursor: 'pointer', font: 'inherit',
  fontSize: 'var(--font-size-body)', color: 'var(--color-link)',
  textDecoration: 'underline', textUnderlineOffset: 2,
}

/**
 * The way back to the list. `to` when it is a plain address; `onClick` when
 * leaving must ask first (unsaved changes, a token not copied) or restore the
 * list's filters.
 */
export function BackLink({ to, state, onClick, children }: {
  to?: string; state?: unknown; onClick?: (e: MouseEvent<HTMLElement>) => void; children: ReactNode
}) {
  const body = <><ArrowLeft size={14} aria-hidden="true" />{children}</>
  if (to !== undefined) {
    return <Link to={to} state={state} onClick={onClick} style={BACK_STYLE}>{body}</Link>
  }
  return <button type="button" onClick={onClick} style={BACK_STYLE}>{body}</button>
}

/** The title of a detail or create page. */
export function DetailTitle({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', letterSpacing: '-0.01em', lineHeight: 1.25, margin: 0, ...style }}>
      {children}
    </h1>
  )
}
