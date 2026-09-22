/**
 * Time-only formatting and the locale fallback of `lib/datetime`.
 *
 * Why these behaviours matter: `toLocaleTimeString()` without a locale takes
 * the BROWSER's, so the same column would read differently depending on whose
 * computer is looking. The time helpers must follow the product language, must
 * show "—" for a missing value (not "Invalid Date"), and must leave an
 * unparsable value visible as it is. `formatHourMinute` exists because a
 * release window never has seconds: showing ":00" steals space in a calendar
 * cell. The locale mapping must pass any other language through unchanged and
 * fall back to English when i18n has none yet (first paint).
 */
import { describe, it, expect, afterEach } from 'vitest'
import i18n from '@/i18n/i18n'
import { currentLocale, formatHourMinute, formatTime } from './datetime'

// TZ = Europe/Rome (vitest.config.ts): 04:57Z in September (CEST) → 06:57 local.
const ISO = '2026-09-17T04:57:00Z'

/** Overrides what i18n reports as the active language, for the mapping branches only. */
function reportLanguage(resolved: string | undefined, language: string) {
  Object.defineProperty(i18n, 'resolvedLanguage', { configurable: true, get: () => resolved })
  Object.defineProperty(i18n, 'language', { configurable: true, get: () => language, set: () => {} })
}

afterEach(async () => {
  // Drop the overrides: the own properties shadow i18next's real ones.
  delete (i18n as unknown as Record<string, unknown>)['resolvedLanguage']
  delete (i18n as unknown as Record<string, unknown>)['language']
  await i18n.changeLanguage('en')
})

describe('formatTime', () => {
  it('follows the product locale, not the browser', async () => {
    expect(formatTime(ISO)).toBe(new Date(ISO).toLocaleTimeString('en-GB'))
    expect(formatTime(ISO)).toBe('06:57:00')
    await i18n.changeLanguage('it')
    expect(formatTime(ISO)).toBe(new Date(ISO).toLocaleTimeString('it-IT'))
  })

  it.each([null, undefined, ''])('%s → "—"', (v) => {
    expect(formatTime(v)).toBe('—')
  })

  it('an unparsable value is returned as it is', () => {
    expect(formatTime('later')).toBe('later')
  })
})

describe('formatHourMinute', () => {
  it('hours and minutes only, with no seconds, in every language', async () => {
    expect(formatHourMinute(ISO)).toBe('06:57')
    await i18n.changeLanguage('it')
    // Italian time would carry seconds by default: this helper must not.
    expect(formatHourMinute(ISO)).toBe('06:57')
  })

  it('missing → "—", unparsable → unchanged', () => {
    expect(formatHourMinute(null)).toBe('—')
    expect(formatHourMinute(undefined)).toBe('—')
    expect(formatHourMinute('soon')).toBe('soon')
  })
})

describe('currentLocale fallbacks', () => {
  it('passes any other language through as a BCP-47 tag', () => {
    reportLanguage('de', 'de')
    expect(currentLocale()).toBe('de')
  })

  it('uses i18n.language when nothing is resolved yet', () => {
    reportLanguage(undefined, 'it')
    expect(currentLocale()).toBe('it-IT')
  })

  it('falls back to English when i18n has no language at all', () => {
    reportLanguage(undefined, '')
    expect(currentLocale()).toBe('en')
  })
})
