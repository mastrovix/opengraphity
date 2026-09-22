/**
 * lib/tenantTimezone.ts — reading the customer's time zone.
 *
 * SLA business hours, digest times and every date in generated texts depend on
 * this value. An unset or empty value must read as `null` (so callers fall back
 * explicitly and the diagnostic can say so), never as an empty string that
 * `Intl` would reject deep inside an SLA calculation; and an unknown tenant
 * must be a NotFound, not a silent `null`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => {})
const getSession = vi.fn((..._a: unknown[]) => ({ close }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
const invalidateNotificationLocale = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ invalidateNotificationLocale }))

const { tenantTimezone, setTenantTimezone, assertTimeZone, availableTimeZones } = await import('../tenantTimezone.js')
const { NotFoundError, ValidationError } = await import('../errors.js')

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('tenantTimezone', () => {
  it('returns the stored zone, reading only this tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ timezone: 'Europe/Rome' })
    expect(await tenantTimezone('t1')).toBe('Europe/Rome')
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('Tenant {id: $tenantId}')
    expect(params).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reads an empty string, a null or a non-string as "not set"', async () => {
    for (const timezone of ['', null, 42]) {
      runQueryOne.mockResolvedValueOnce({ timezone })
      expect(await tenantTimezone('t1')).toBeNull()
    }
  })

  it('an unknown tenant is NotFound, and the session is still closed', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(tenantTimezone('ghost')).rejects.toBeInstanceOf(NotFoundError)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('setTenantTimezone', () => {
  it('an unknown tenant is NotFound and the notification cache is not touched', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(setTenantTimezone('ghost', 'Europe/Rome')).rejects.toBeInstanceOf(NotFoundError)
    expect(close).toHaveBeenCalledTimes(1)
    expect(invalidateNotificationLocale).not.toHaveBeenCalled()
  })

  it('writes through a WRITE session', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    await setTenantTimezone('t1', 'Europe/Rome')
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(invalidateNotificationLocale).toHaveBeenCalledWith('t1')
  })
})

describe('assertTimeZone / availableTimeZones', () => {
  it('a blank string is rejected with the value in the i18n params', () => {
    const err = (() => { try { assertTimeZone('  '); return null } catch (e) { return e as ValidationError } })()
    expect(err).toBeInstanceOf(ValidationError)
    expect(err!.extensions['i18n']).toEqual({ key: 'errors.tenant.unknownTimezone', params: { timezone: '  ' } })
  })

  it('adds UTC in front when the runtime list does not include it', () => {
    // Some runtimes list only canonical zones (Etc/UTC): the page must still offer UTC.
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Europe/Rome', 'Asia/Tokyo'])
    expect(availableTimeZones()).toEqual(['UTC', 'Europe/Rome', 'Asia/Tokyo'])
  })

  it('does not duplicate UTC when the runtime already lists it', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['UTC', 'Europe/Rome'])
    expect(availableTimeZones()).toEqual(['UTC', 'Europe/Rome'])
  })
})
