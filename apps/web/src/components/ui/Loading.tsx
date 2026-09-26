/**
 * «LOADING…» (26 Sep 2026, wave 5 of «tutte in fila»).
 *
 * Fifty-five places wrote it themselves: grey or slate, 12 or 13 px, with a
 * padding of 0, 20, 24, 32 or 40, and most of them without `role="status"`, so
 * a screen reader never heard that something was on its way. One component:
 * the same words, the same grey, always a status. `padded` for the one that
 * stands in for a whole page or panel; `inline` inside a line of text.
 */
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

export function Loading({ padded = false, inline = false, style }: { padded?: boolean; inline?: boolean; style?: CSSProperties }) {
  const { t } = useTranslation()
  const look: CSSProperties = {
    margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)',
    ...(padded ? { padding: 32, textAlign: 'center' } : {}),
    ...style,
  }
  return inline
    ? <span role="status" style={look}>{t('common.loading')}</span>
    : <p role="status" style={look}>{t('common.loading')}</p>
}
