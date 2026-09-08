/**
 * Locale-aware formatting for the portal. The locale follows the active
 * i18next language (detected from localStorage/navigator, see i18n/i18n.ts)
 * instead of a hardcoded 'it-IT', so an English UI gets English dates too.
 */
import i18n from '@/i18n/i18n'

function locale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? 'it'
}

export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat(locale(), opts).format(new Date(iso))
  } catch { return iso }
}

export function fmtDateLong(iso: string | null | undefined): string {
  return fmtDate(iso, { day: '2-digit', month: 'long', year: 'numeric' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  return fmtDate(iso, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
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
