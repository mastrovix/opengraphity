/**
 * Organization settings exposed to the UI: named service calendars and the
 * retention of the bell notifications.
 *
 * Why these behaviours matter:
 *  - Every write requires `config.organization`. A service calendar drives SLA
 *    clocks; an agent who could edit it could stop their own breaches.
 *  - A refused write must not reach the library nor the Audit Log.
 *  - Every accepted write lands in the Audit Log with the tenant of the
 *    caller: calendar changes are the first thing asked about in a dispute.
 *  - Reads are scoped to the caller's tenant and need no special permission,
 *    because the pickers across the app list calendars.
 *  - An update passes only the fields the caller sent: a null name must not
 *    blank the stored one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lib = vi.hoisted(() => ({
  serviceCalendars:      vi.fn(),
  createServiceCalendar: vi.fn(),
  updateServiceCalendar: vi.fn(),
  deleteServiceCalendar: vi.fn(),
}))
vi.mock('../../../lib/serviceCalendars.js', () => lib)
const retention = vi.hoisted(() => ({ tenantInAppRetentionDays: vi.fn(), setTenantInAppRetentionDays: vi.fn() }))
vi.mock('../../../lib/tenantInAppRetention.js', () => retention)
const audit = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/audit.js', () => ({ audit }))

const { organizationSettingsResolvers: R } = await import('../organizationSettings.js')

const ctx = (...perms: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'agent', permissions: new Set(perms),
}) as never
const ADMIN = ctx('config.organization')

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO_REFUSAL' } catch (e) {
    return String((e as { extensions?: { code?: string } }).extensions?.code ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  lib.serviceCalendars.mockResolvedValue([{ id: 'c1', name: 'Office hours' }])
  lib.createServiceCalendar.mockResolvedValue({ id: 'c2', name: 'Weekend' })
  lib.updateServiceCalendar.mockResolvedValue({ id: 'c1', name: 'Renamed' })
  lib.deleteServiceCalendar.mockResolvedValue(undefined)
  retention.tenantInAppRetentionDays.mockResolvedValue(30)
  retention.setTenantInAppRetentionDays.mockResolvedValue(60)
})

describe('every write requires config.organization', () => {
  const writes: Array<[string, () => Promise<unknown>]> = [
    ['createServiceCalendar', () => R.Mutation.createServiceCalendar(null, { name: 'X', calendar: {} }, ctx('incident.write'))],
    ['updateServiceCalendar', () => R.Mutation.updateServiceCalendar(null, { id: 'c1', name: 'X' }, ctx('incident.write'))],
    ['deleteServiceCalendar', () => R.Mutation.deleteServiceCalendar(null, { id: 'c1' }, ctx('incident.write'))],
    ['setTenantInAppRetentionDays', () => R.Mutation.setTenantInAppRetentionDays(null, { days: 7 }, ctx('incident.write'))],
  ]
  it.each(writes)('%s is FORBIDDEN and touches nothing', async (_n, call) => {
    expect(await codeOf(call)).toBe('FORBIDDEN')
    expect(lib.createServiceCalendar).not.toHaveBeenCalled()
    expect(lib.updateServiceCalendar).not.toHaveBeenCalled()
    expect(lib.deleteServiceCalendar).not.toHaveBeenCalled()
    expect(retention.setTenantInAppRetentionDays).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('reads', () => {
  it('are scoped to the caller tenant and need no special permission', async () => {
    expect(await R.Query.serviceCalendars(null, null, ctx())).toEqual([{ id: 'c1', name: 'Office hours' }])
    expect(lib.serviceCalendars).toHaveBeenCalledWith('t1')
    expect(await R.Query.tenantInAppRetentionDays(null, null, ctx())).toBe(30)
    expect(retention.tenantInAppRetentionDays).toHaveBeenCalledWith('t1')
  })
})

describe('writes with the permission', () => {
  it('create: returns the calendar and audits it under its id and name', async () => {
    const cal = await R.Mutation.createServiceCalendar(null, { name: 'Weekend', calendar: { days: [6] } }, ADMIN)
    expect(cal).toEqual({ id: 'c2', name: 'Weekend' })
    expect(lib.createServiceCalendar).toHaveBeenCalledWith('t1', { name: 'Weekend', calendar: { days: [6] } })
    expect(audit).toHaveBeenCalledWith(ADMIN, 'service_calendar.created', 'ServiceCalendar', 'c2', { name: 'Weekend' })
  })

  it('update: forwards only the fields that were sent', async () => {
    await R.Mutation.updateServiceCalendar(null, { id: 'c1', name: 'Renamed', calendar: null }, ADMIN)
    // A null calendar means "not touched", not "erase the schedule".
    expect(lib.updateServiceCalendar).toHaveBeenLastCalledWith('t1', 'c1', { name: 'Renamed' })

    await R.Mutation.updateServiceCalendar(null, { id: 'c1', name: null, calendar: { days: [1] } }, ADMIN)
    expect(lib.updateServiceCalendar).toHaveBeenLastCalledWith('t1', 'c1', { calendar: { days: [1] } })

    await R.Mutation.updateServiceCalendar(null, { id: 'c1' }, ADMIN)
    expect(lib.updateServiceCalendar).toHaveBeenLastCalledWith('t1', 'c1', {})
    expect(audit).toHaveBeenCalledWith(ADMIN, 'service_calendar.updated', 'ServiceCalendar', 'c1', { name: 'Renamed' })
  })

  it('delete: returns true and audits the deleted id', async () => {
    expect(await R.Mutation.deleteServiceCalendar(null, { id: 'c9' }, ADMIN)).toBe(true)
    expect(lib.deleteServiceCalendar).toHaveBeenCalledWith('t1', 'c9')
    expect(audit).toHaveBeenCalledWith(ADMIN, 'service_calendar.deleted', 'ServiceCalendar', 'c9')
  })

  it('a failing delete is not audited as done', async () => {
    lib.deleteServiceCalendar.mockRejectedValue(new Error('in use'))
    await expect(R.Mutation.deleteServiceCalendar(null, { id: 'c9' }, ADMIN)).rejects.toThrow('in use')
    expect(audit).not.toHaveBeenCalled()
  })

  it('retention: audits the value the library accepted, not the one requested', async () => {
    // The library may clamp the value; the Audit Log must tell what is in force.
    expect(await R.Mutation.setTenantInAppRetentionDays(null, { days: 999 }, ADMIN)).toBe(60)
    expect(retention.setTenantInAppRetentionDays).toHaveBeenCalledWith('t1', 999)
    expect(audit).toHaveBeenCalledWith(ADMIN, 'tenant.inapp_retention.updated', 'Tenant', 't1', { days: 60 })
  })
})
