/**
 * A CHIP: A PILL THAT IS ON OR OFF (26 Sep 2026, wave 4 of «tutte in fila»).
 *
 * Filters, allowed extensions, the values a rule matches, a window of days, a
 * ticket type, AND/OR: some twenty pills were drawn page by page — radius 5 to
 * 999, borders of 1, 1.5 and 2 px, the «on» state in four different ways.
 * A chip says it is on with `aria-pressed`, and it is on in its accent colour
 * (the brand by default; a severity, a status or a widget colour where the
 * colour is the meaning).
 */
import type { MouseEvent, ReactNode } from 'react'

export function Chip({ pressed, onClick, children, accent = 'var(--color-brand)', tint = 'var(--color-brand-light)', disabled, title, ariaLabel, dashed, 'data-testid': testId }: {
  pressed: boolean
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
  /** The colour of the «on» state: border and text. */
  accent?: string
  /** The background of the «on» state. */
  tint?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** A value that no longer exists (an orphan): a dashed border says it. */
  dashed?: boolean
  'data-testid'?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      data-testid={testId}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, font: 'inherit',
        padding: '4px 10px', borderRadius: 999, fontSize: 'var(--font-size-body)',
        border: `1px ${dashed ? 'dashed' : 'solid'} ${pressed ? accent : 'var(--color-border)'}`,
        background: pressed ? tint : 'var(--color-white)',
        color: pressed ? accent : 'var(--color-slate)',
        fontWeight: pressed ? 600 : 400,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}
