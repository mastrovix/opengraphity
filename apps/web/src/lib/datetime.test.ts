import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import i18n from '@/i18n/i18n'
import { currentLocale, formatDate, formatDateTime, formatDateShort, timeAgo, formatDuration, fmtDate, fmtShort } from './datetime'

// TZ = Europe/Rome (vitest.config.ts): 12:05Z in settembre (CEST) → 14:05 locali.
// Lingua: il setup forza `en`; i blocchi "it" la cambiano e la ripristinano.
const ISO = '2026-09-08T12:05:00Z'

function withLanguage(lng: string) {
  beforeAll(async () => { await i18n.changeLanguage(lng) })
  afterAll(async () => { await i18n.changeLanguage('en') })
}

describe('currentLocale', () => {
  it('mappa la lingua i18n su un locale BCP-47 (it → it-IT, en → en-GB, altro → invariato)', async () => {
    expect(currentLocale()).toBe('en-GB')
    await i18n.changeLanguage('it')
    expect(currentLocale()).toBe('it-IT')
    await i18n.changeLanguage('en')
  })
})

describe('formatDateTime', () => {
  it('en: giorno, mese breve, anno e ora nel locale en-GB', () => {
    expect(formatDateTime(ISO)).toBe(new Date(ISO).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    expect(formatDateTime(ISO)).toMatch(/^08 Sept? 2026, 14:05$/)
  })

  it.each([null, undefined, ''])('%s → "—"', (v) => {
    expect(formatDateTime(v)).toBe('—')
  })

  it('una stringa non parsabile è restituita tale e quale (visibile, non nascosta)', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
  })

  describe('in italiano', () => {
    withLanguage('it')
    it('"08 set 2026, 14:05"', () => {
      expect(formatDateTime(ISO)).toBe('08 set 2026, 14:05')
    })
  })
})

describe('formatDate', () => {
  it('en: solo data in en-GB (gg/mm/aaaa)', () => {
    expect(formatDate(ISO)).toBe('08/09/2026')
  })
  it('assente → "—", non parsabile → invariata; fmtDate è un alias', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate('xyz')).toBe('xyz')
    expect(fmtDate).toBe(formatDate)
  })
  describe('in italiano', () => {
    withLanguage('it')
    it('segue il locale it-IT', () => {
      expect(formatDate(ISO)).toBe(new Date(ISO).toLocaleDateString('it-IT'))
    })
  })
})

describe('formatDateShort', () => {
  it('"gg/mm/aaaa hh:mm" a larghezza fissa con zero padding, indipendente dalla lingua', () => {
    expect(formatDateShort(ISO)).toBe('08/09/2026 14:05')
    expect(formatDateShort('2026-01-02T03:04:00Z')).toBe('02/01/2026 04:04')  // CET +1
  })
  it('assente → "—", non parsabile → invariata; fmtShort è un alias', () => {
    expect(formatDateShort(undefined)).toBe('—')
    expect(formatDateShort('nope')).toBe('nope')
    expect(fmtShort).toBe(formatDateShort)
  })
})

describe('timeAgo (orologio finto)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-08T12:00:00Z') }) })
  afterEach(() => { vi.useRealTimers() })

  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

  it.each([
    [0,               'just now'],
    [59,              'just now'],
    [60,              '1 min ago'],
    [5 * 60,          '5 min ago'],
    [59 * 60,         '59 min ago'],
    [60 * 60,         '1 hour ago'],
    [3 * 3600,        '3 hours ago'],
    [23 * 3600,       '23 hours ago'],
    [24 * 3600,       '1 day ago'],
    [2 * 86400,       '2 days ago'],
    [6 * 86400,       '6 days ago'],
  ])('en: %d secondi fa → "%s"', (sec, expected) => {
    expect(timeAgo(at(sec))).toBe(expected)
  })

  it('oltre 7 giorni mostra la data completa', () => {
    const iso = at(8 * 86400)
    expect(timeAgo(iso)).toBe(formatDateTime(iso))
  })

  describe('in italiano (plurali)', () => {
    withLanguage('it')
    it.each([
      [30,        'adesso'],
      [5 * 60,    '5 min fa'],
      [3600,      '1 ora fa'],
      [3 * 3600,  '3 ore fa'],
      [86400,     '1 giorno fa'],
      [2 * 86400, '2 giorni fa'],
    ])('%d secondi fa → "%s"', (sec, expected) => {
      expect(timeAgo(at(sec))).toBe(expected)
    })
  })
})

describe('formatDuration', () => {
  it.each([
    [0,                '< 1 min'],
    [59_999,           '< 1 min'],
    [60_000,           '1 min'],
    [12 * 60_000,      '12 min'],
    [3_600_000,        '1 hour'],
    [3 * 3_600_000,    '3 hours'],
    [86_400_000,       '1 day'],
    [2.5 * 86_400_000, '2 days'],
  ])('en: %d ms → "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  describe('in italiano (plurali)', () => {
    withLanguage('it')
    it.each([
      [3_600_000,     '1 ora'],
      [3 * 3_600_000, '3 ore'],
      [86_400_000,    '1 giorno'],
      [2 * 86_400_000, '2 giorni'],
    ])('%d ms → "%s"', (ms, expected) => {
      expect(formatDuration(ms)).toBe(expected)
    })
  })
})
