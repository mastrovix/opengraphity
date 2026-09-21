/**
 * Locale-aware formatting for the portal. The locale follows the active
 * i18next language (see i18n/i18n.ts)
 * instead of a hardcoded 'it-IT', so an English UI gets English dates too.
 */
import i18n from '@/i18n/i18n'

/**
 * BCP-47 locale for Intl, the same mapping as the web app: plain `en` is the
 * US convention (09/14/2026), which nobody using this product reads as a date
 * (browser tour of 14 Sep 2026). English is `en-GB`, Italian `it-IT`.
 */
function locale(): string {
  const lng = i18n.resolvedLanguage ?? i18n.language
  if (!lng) throw new Error('portal format: i18n has no active language')
  return lng === 'it' ? 'it-IT' : lng === 'en' ? 'en-GB' : lng
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat(locale(), opts).format(new Date(iso))
  } catch { return iso }
}

export function fmtDateLong(iso: string | null | undefined): string {
  return fmtDate(iso, { day: '2-digit', month: 'long', year: 'numeric' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  return fmtDate(iso, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTimeLong(iso: string | null | undefined): string {
  return fmtDate(iso, { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "3 hours ago" / "in 2 days" relative to now, in the requested unit. */
export function fmtRelative(iso: string, unit: 'hour' | 'day' = 'hour'): string {
  try {
    const perUnit = unit === 'hour' ? 3_600_000 : 86_400_000
    const diff = Math.round((new Date(iso).getTime() - Date.now()) / perUnit)
    return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(diff, unit)
  } catch { return iso }
}
