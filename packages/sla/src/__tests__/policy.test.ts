import { describe, it, expect } from 'vitest'
import { calculateDeadline, zonedTimeToUtc } from '../policy.js'

// Business hours: Mon–Fri 08:00–18:00 local time in the policy timezone.
// DST 2026 (Europe/Rome): spring forward Sun 29 Mar 02:00→03:00 (CET→CEST),
// fall back Sun 25 Oct 03:00→02:00 (CEST→CET).

describe('calculateDeadline — 24x7 (non business hours)', () => {
  it('adds absolute minutes regardless of timezone', () => {
    const start = new Date('2026-03-28T23:30:00Z')
    expect(calculateDeadline(start, 120, false, 'Europe/Rome').toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })
})

describe('calculateDeadline — business hours across DST (D-09)', () => {
  const cases: Array<{ name: string; start: string; minutes: number; tz: string; expected: string }> = [
    {
      // 60 min left on Friday (17→18 CET), 60 min carried to Monday 08:00 CEST → 09:00 CEST = 07:00Z.
      // Before the fix this returned 08:00Z (10:00 CEST): wall-clock minutes summed as UTC ms across the shift.
      name:     'spring forward: Fri 27/3/2026 17:00 CET +120 → Mon 30/3 09:00 CEST',
      start:    '2026-03-27T16:00:00Z',
      minutes:  120,
      tz:       'Europe/Rome',
      expected: '2026-03-30T07:00:00.000Z',
    },
    {
      name:     'spring forward from Saturday: Sat 28/3/2026 10:00 CET +60 → Mon 30/3 09:00 CEST',
      start:    '2026-03-28T09:00:00Z',
      minutes:  60,
      tz:       'Europe/Rome',
      expected: '2026-03-30T07:00:00.000Z',
    },
    {
      name:     'spring forward from Sunday night: Sun 29/3/2026 23:00 CEST +30 → Mon 30/3 08:30 CEST',
      start:    '2026-03-29T21:00:00Z',
      minutes:  30,
      tz:       'Europe/Rome',
      expected: '2026-03-30T06:30:00.000Z',
    },
    {
      name:     'fall back: Fri 23/10/2026 17:00 CEST +120 → Mon 26/10 09:00 CET',
      start:    '2026-10-23T15:00:00Z',
      minutes:  120,
      tz:       'Europe/Rome',
      expected: '2026-10-26T08:00:00.000Z',
    },
    {
      name:     'fall back from Saturday: Sat 24/10/2026 12:00 CEST +90 → Mon 26/10 09:30 CET',
      start:    '2026-10-24T10:00:00Z',
      minutes:  90,
      tz:       'Europe/Rome',
      expected: '2026-10-26T08:30:00.000Z',
    },
    {
      name:     'no DST (Asia/Tokyo): Fri 27/3/2026 17:00 JST +120 → Mon 30/3 09:00 JST',
      start:    '2026-03-27T08:00:00Z',
      minutes:  120,
      tz:       'Asia/Tokyo',
      expected: '2026-03-30T00:00:00.000Z',
    },
    {
      name:     'within the same business day (no DST involved): Tue 10/3/2026 09:15 CET +90 → 10:45 CET',
      start:    '2026-03-10T08:15:00Z',
      minutes:  90,
      tz:       'Europe/Rome',
      expected: '2026-03-10T09:45:00.000Z',
    },
    {
      name:     'before opening on a weekday: Tue 10/3/2026 06:00 CET +30 → 08:30 CET',
      start:    '2026-03-10T05:00:00Z',
      minutes:  30,
      tz:       'Europe/Rome',
      expected: '2026-03-10T07:30:00.000Z',
    },
    {
      name:     'before opening on a Saturday-adjacent day is re-checked: Fri 13/3/2026 06:00 CET +600 (a full day) → Fri 18:00 CET',
      start:    '2026-03-13T05:00:00Z',
      minutes:  600,
      tz:       'Europe/Rome',
      expected: '2026-03-13T17:00:00.000Z',
    },
    {
      name:     'multi-day carry over a weekend: Thu 12/3/2026 16:00 CET +1440 (24h business = 2.4 days) → Tue 17/3 12:00 CET',
      start:    '2026-03-12T15:00:00Z',
      minutes:  1440,
      tz:       'Europe/Rome',
      // Thu 16→18 = 120, Fri 600 (720), Mon 600 (1320), Tue 08:00 + 120 = 10:00 CET
      expected: '2026-03-17T09:00:00.000Z',
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const out = calculateDeadline(new Date(c.start), c.minutes, true, c.tz)
      expect(out.toISOString()).toBe(c.expected)
    })
  }

  it('zero minutes returns the (advanced) business start unchanged', () => {
    // Sat 28/3/2026 10:00 CET → Mon 30/3 08:00 CEST (06:00Z)
    const out = calculateDeadline(new Date('2026-03-28T09:00:00Z'), 0, true, 'Europe/Rome')
    expect(out.toISOString()).toBe('2026-03-30T06:00:00.000Z')
  })
})

describe('zonedTimeToUtc', () => {
  it('converts a local wall-clock time in a DST zone', () => {
    expect(zonedTimeToUtc(2026, 3, 30, 9, 0, 'Europe/Rome').toISOString()).toBe('2026-03-30T07:00:00.000Z')
    expect(zonedTimeToUtc(2026, 3, 27, 17, 0, 'Europe/Rome').toISOString()).toBe('2026-03-27T16:00:00.000Z')
  })
  it('handles a zone without DST and a negative-offset zone', () => {
    expect(zonedTimeToUtc(2026, 3, 30, 9, 0, 'Asia/Tokyo').toISOString()).toBe('2026-03-30T00:00:00.000Z')
    expect(zonedTimeToUtc(2026, 7, 1, 9, 0, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z')
  })
  it('rejects an unknown timezone loudly', () => {
    expect(() => zonedTimeToUtc(2026, 1, 1, 9, 0, 'Not/AZone')).toThrow()
  })
})
