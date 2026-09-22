/**
 * How many days the bell notifications are kept: a per-organisation choice.
 *
 * Why these behaviours matter:
 *  - the nightly cleanup DELETES notifications older than this: an invalid or
 *    guessed value means data destroyed on a schedule nobody chose, so the
 *    range is enforced on write AND on read;
 *  - "not configured" must stay `null` (the cleanup skips the tenant and the
 *    diagnostics say so), never a default number;
 *  - the cleanup reads every tenant except the platform's own `system` tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const runQueryOne = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close }),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const {
  assertInAppRetentionDays, tenantInAppRetentionDays, setTenantInAppRetentionDays, inAppRetentionByTenant,
  INAPP_RETENTION_MIN_DAYS, INAPP_RETENTION_MAX_DAYS,
} = await import('../tenantInAppRetention.js')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
const catchErr = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)

beforeEach(() => { runQuery.mockReset(); runQueryOne.mockReset(); close.mockClear() })

describe('assertInAppRetentionDays', () => {
  it('accepts whole days within the range, including numeric strings from a form', () => {
    expect(assertInAppRetentionDays(INAPP_RETENTION_MIN_DAYS)).toBe(1)
    expect(assertInAppRetentionDays(INAPP_RETENTION_MAX_DAYS)).toBe(3650)
    expect(assertInAppRetentionDays('90')).toBe(90)
  })

  it.each([0, 3651, 1.5, 'abc', null, undefined, -5])('rejects %j', (v) => {
    let err: unknown
    try { assertInAppRetentionDays(v) } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.tenant.inAppRetention')
  })
})

describe('tenantInAppRetentionDays', () => {
  it('returns the configured days of this tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ days: 30 })
    expect(await tenantInAppRetentionDays('t1')).toBe(30)
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalled()
  })

  it('not configured → null, not a default', async () => {
    runQueryOne.mockResolvedValueOnce({ days: null })
    expect(await tenantInAppRetentionDays('t1')).toBeNull()
  })

  it('a stored value out of range is an error, never used for deletion', async () => {
    runQueryOne.mockResolvedValueOnce({ days: 0 })
    expect(errKey(await catchErr(tenantInAppRetentionDays('t1')))).toBe('errors.tenant.inAppRetention')
  })

  it('unknown tenant → NotFound', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(tenantInAppRetentionDays('ghost')))).toBe('errors.notFound')
    expect(close).toHaveBeenCalled()
  })
})

describe('setTenantInAppRetentionDays', () => {
  it('validates before writing', async () => {
    expect(errKey(await catchErr(setTenantInAppRetentionDays('t1', 0)))).toBe('errors.tenant.inAppRetention')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('writes the normalised number on this tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    expect(await setTenantInAppRetentionDays('t1', '45')).toBe(45)
    expect(runQueryOne.mock.calls[0]![2]).toMatchObject({ tenantId: 't1', days: 45 })
    expect(close).toHaveBeenCalled()
  })

  it('unknown tenant → NotFound', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    expect(errKey(await catchErr(setTenantInAppRetentionDays('ghost', 10)))).toBe('errors.notFound')
  })
})

describe('inAppRetentionByTenant', () => {
  it('lists every customer tenant with its choice (null = skip), excluding the system tenant', async () => {
    runQuery.mockResolvedValueOnce([
      { tenantId: 'a', days: 30 },
      { tenantId: 'b', days: null },
      { tenantId: 'c', days: '7' },
    ])
    const out = await inAppRetentionByTenant()
    expect(out).toEqual([{ tenantId: 'a', days: 30 }, { tenantId: 'b', days: null }, { tenantId: 'c', days: 7 }])
    expect(String(runQuery.mock.calls[0]![1])).toContain("t.id <> 'system'")
    expect(close).toHaveBeenCalled()
  })
})
