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

/**
 * CAMPO IN SOLA LETTURA: il valore si legge, lo sfondo dice che è bloccato.
 *
 * Sta qui e non nella pagina perché il difetto che chiude è di quelli che si
 * ripetono: il Dizionario dipingeva i campi di un vocabolario spedito col
 * colore dei PLACEHOLDER (`slateLight`, che tokens.ts dichiara «tertiary
 * text, placeholders»), e «status_change / Change Status / ITIL» si leggevano
 * come suggerimenti in tre caselle vuote — dal vivo si è concluso che il
 * vocabolario fosse vuoto (17 set 2026).
 *
 * Scolorire il contenuto non comunica «in sola lettura»: comunica «assente».
 * Lo dicono lo sfondo e il cursore che non lampeggia.
 */
export const readOnlyInputS: CSSProperties = {
  backgroundColor: colors.slateBg, color: colors.slateDark, cursor: 'default',
}

export const selectS: CSSProperties = {
  ...inputS,
  appearance: 'none',
  backgroundImage: 'var(--select-arrow)',
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}

export const textareaS: CSSProperties = {
  ...inputS, fontFamily: 'var(--font-family)', fontSize: 'var(--font-size-body)', resize: 'vertical', minHeight: 80,
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
