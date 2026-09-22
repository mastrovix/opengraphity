/**
 * The OLA/UC sweep, the timezone read and the ticket-type edges.
 *
 * Why these behaviours matter:
 *  - the tenant timezone is read ONLY for business-hours contracts (C-11):
 *    `getTenantTimezone` throws for a tenant without one, and a fresh tenant
 *    with 24x7 contracts used to count every contract as failed and log an
 *    error every minute while no OLA alert ever fired;
 *  - it is read once per tenant per sweep, not once per contract;
 *  - a contract without an entity type is an incident contract (old data);
 *  - the ticket query refuses unknown types and changes (a change is measured
 *    on its tasks), so a typo never becomes a query on a label nobody has;
 *  - the session is closed even when reading the contracts fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const session = { close: vi.fn(async () => {}), executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: vi.fn() })) }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => session), runQuery: (...a: unknown[]) => runQuery(...a), toNumber: (v: unknown) => Number(v) }))
const getTenantTimezone = vi.fn(async (_t: string) => 'Europe/Rome')
vi.mock('@opengraphity/sla', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTenantTimezone: (t: string) => getTenantTimezone(t),
  calendarFor: vi.fn(async () => null),
}))
vi.mock('../publishEvent.js', () => ({ publishEvent: vi.fn(async () => {}) }))
vi.mock('../olaChangeUnits.js', async (importOriginal) => ({ ...(await importOriginal<object>()), loadChangeUnits: vi.fn(async () => []) }))

const { runOLASweep, olaOpenTicketsCypher } = await import('../olaSweep.js')

const CONTRACT = { id: 'c1', tenantId: 't1', name: 'Net 4h', type: 'ola', entityType: 'incident', teamId: 'net', resolveMinutes: 240, businessHours: false, calendarId: null, createdAt: '2026-09-01T00:00:00Z' }

beforeEach(() => { runQuery.mockReset(); getTenantTimezone.mockClear(); session.close.mockClear() })

describe('runOLASweep: timezone', () => {
  it('24x7 contracts never read the timezone, so a tenant without one does not fail', async () => {
    getTenantTimezone.mockRejectedValue(new Error('tenant has no timezone'))
    runQuery.mockResolvedValueOnce([CONTRACT]).mockResolvedValueOnce([])
    const summary = await runOLASweep(new Date('2026-09-15T12:00:00Z'))
    expect(summary).toEqual({ contracts: 1, candidates: 0, alerted: 0, failed: 0 })
    expect(getTenantTimezone).not.toHaveBeenCalled()
    getTenantTimezone.mockReset().mockResolvedValue('Europe/Rome')
  })

  it('business-hours contracts read the timezone once per tenant in a sweep', async () => {
    runQuery
      .mockResolvedValueOnce([
        { ...CONTRACT, businessHours: true },
        { ...CONTRACT, id: 'c2', businessHours: true },
        { ...CONTRACT, id: 'c3', tenantId: 't2', businessHours: true },
      ])
      .mockResolvedValue([])
    const summary = await runOLASweep(new Date('2026-09-15T12:00:00Z'))
    expect(summary.failed).toBe(0)
    expect(getTenantTimezone.mock.calls.map((c) => c[0])).toEqual(['t1', 't2'])
  })

  it('a missing timezone on a business-hours contract counts that contract as failed, not the sweep', async () => {
    getTenantTimezone.mockRejectedValueOnce(new Error('tenant has no timezone'))
    runQuery.mockResolvedValueOnce([{ ...CONTRACT, businessHours: true }, { ...CONTRACT, id: 'c2', tenantId: 't2' }]).mockResolvedValue([])
    const summary = await runOLASweep(new Date('2026-09-15T12:00:00Z'))
    expect(summary).toMatchObject({ contracts: 2, failed: 1 })
  })
})

describe('runOLASweep: contract data', () => {
  it('a contract without an entity type is measured on incidents', async () => {
    runQuery.mockResolvedValueOnce([{ ...CONTRACT, entityType: '' }]).mockResolvedValueOnce([])
    await runOLASweep(new Date('2026-09-15T12:00:00Z'))
    expect(runQuery).toHaveBeenCalledTimes(2)
    expect(runQuery.mock.calls[1]![1]).toContain(olaOpenTicketsCypher('incident'))
    expect(runQuery.mock.calls[1]![2]).toEqual({ tenantId: 't1', teamId: 'net', contractId: 'c1' })
  })

  it('closes the session even when the contracts cannot be read', async () => {
    runQuery.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(runOLASweep()).rejects.toThrow('neo4j down')
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})

describe('olaOpenTicketsCypher', () => {
  it('refuses an unknown ticket type', () => {
    expect(() => olaOpenTicketsCypher('spaceship')).toThrow('olaOpenTicketsCypher: unknown ticket type "spaceship"')
  })

  it('refuses a change: it is measured on its tasks', () => {
    expect(() => olaOpenTicketsCypher('change')).toThrow(/measured on its tasks/)
  })

  it('scopes every match to the tenant', () => {
    const c = olaOpenTicketsCypher('incident')
    expect(c).toContain('{tenant_id: $tenantId}')
    expect(c).toContain('(ct:Team {tenant_id: $tenantId})')
  })
})
