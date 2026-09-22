/**
 * `valueAtPath` must follow the SAME rule as the API's getPath: the mapping
 * editor previews what the ingestion will extract. A path that goes THROUGH a
 * scalar (`alert.level.code` when `level` is a string) must yield nothing,
 * not a character or a string method — otherwise the preview would show a
 * value the server never extracts, and the admin would save a broken mapping
 * believing it works.
 *
 * `parseRateLimit` gates the Save button of a source's rate limit: anything
 * that is not a whole number in range must come back as null, so a typo like
 * `1e3` or `-5` can never be saved as a limit the ingestion then enforces.
 */
import { describe, it, expect } from 'vitest'
import { valueAtPath, parseRateLimit, RATE_LIMIT_MIN, RATE_LIMIT_MAX } from './sourceConfig'

describe('valueAtPath — a path through a scalar', () => {
  const payload = { alert: { level: 'major', count: 3, flag: true } }

  it.each(['alert.level.code', 'alert.level.length', 'alert.count.value', 'alert.flag.x'])('%s → undefined', (path) => {
    expect(valueAtPath(payload, path)).toBeUndefined()
  })

  it('a scalar payload has no fields', () => {
    expect(valueAtPath('plain text', 'length')).toBeUndefined()
    expect(valueAtPath(42, 'x')).toBeUndefined()
  })
})

describe('parseRateLimit', () => {
  it('accepts a whole number in range, spaces around allowed', () => {
    expect(parseRateLimit(' 120 ')).toBe(120)
    expect(parseRateLimit(String(RATE_LIMIT_MIN))).toBe(RATE_LIMIT_MIN)
    expect(parseRateLimit(String(RATE_LIMIT_MAX))).toBe(RATE_LIMIT_MAX)
  })

  it.each(['', 'abc', '1e3', '-5', '12.5', String(RATE_LIMIT_MAX + 1), String(RATE_LIMIT_MIN - 1)])('%j → null', (text) => {
    expect(parseRateLimit(text)).toBeNull()
  })
})
