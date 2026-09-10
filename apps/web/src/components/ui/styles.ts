/**
 * Shared inline-style constants for forms (E-09).
 *
 * Prefer the components: `Input` / `Select` / `Textarea` / `FieldLabel` from
 * `ui/FormControls` and `Button` from `components/Button`. These constants
 * exist for the remaining places that spread a style onto a raw element or
 * need a pinpoint override on top of a FormControl.
 *
 * `btnPrimary` / `btnSecondary` / `btnDanger` are kept ONLY for consumers that
 * cannot yet render `<Button>` (they mirror its variants exactly). New code
 * must use `<Button variant="…">`.
 */
import type { CSSProperties } from 'react'
import { colors, palette } from '@/lib/tokens'

export const inputS: CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid var(--border)',
  borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: colors.white, boxSizing: 'border-box',
}

export const selectS: CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

export const textareaS: CSSProperties = {
  ...inputS, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontSize: 'var(--font-size-body)', resize: 'vertical', minHeight: 80,
}

export const labelS: CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4,
}

/** @deprecated use `<Button variant="primary">` */
export const btnPrimary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: 'var(--color-brand)',
  color: colors.white, fontSize: 'var(--font-size-card-title)', fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}

/** @deprecated use `<Button variant="secondary">` */
export const btnSecondary: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid var(--border)', borderRadius: 6, background: colors.white,
  color: 'var(--color-slate)', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}

/** @deprecated use `<Button variant="danger">` */
export const btnDanger: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', border: `1px solid ${palette.danger.border}`, borderRadius: 6, background: colors.white,
  color: 'var(--color-danger)', fontSize: 'var(--font-size-body)', cursor: 'pointer',
}

/** Chip preview for enum values */
export function enumChipStyle(): CSSProperties {
  return { padding: '2px 8px', background: palette.info.bg, borderRadius: 12, fontSize: 'var(--font-size-table)', color: 'var(--color-brand)' }
}

/** Active card style (selected state in designer type lists) */
export const activeCardStyle: CSSProperties = {
  border: '1px solid var(--color-brand)',
  background: palette.info.light,
  color: 'var(--color-brand)',
}

/** Inactive card style */
export const inactiveCardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  background: colors.white,
  color: 'var(--color-slate-dark)',
}
