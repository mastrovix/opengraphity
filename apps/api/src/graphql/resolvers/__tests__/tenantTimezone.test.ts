/**
 * The tenant time zone resolvers (Organization page).
 *
 * The time zone drives SLA/OLA business-hours deadlines, the digest hour and
 * every date in generated texts. Two contracts matter to a customer:
 *  - only a role with `config.organization` may change it — anyone else would
 *    silently move every deadline of the tenant;
 *  - reads and writes are scoped to the CALLER's tenant (ctx.tenantId), never
 *    to an id from the arguments, and a change leaves an Audit Log entry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tenantTimezone = vi.fn()
const setTenantTimezone = vi.fn()
const availableTimeZones = vi.fn(() => ['UTC', 'Europe/Rome'])
vi.mock('../../../lib/tenantTimezone.js', () => ({
  tenantTimezone: (...a: unknown[]) => tenantTimezone(...a),
  setTenantTimezone: (...a: unknown[]) => setTenantTimezone(...a),
  availableTimeZones: () => availableTimeZones(),
}))
const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { tenantTimezoneResolvers } = await import('../tenantTimezone.js')

const ctx = (permissions: string[]) =>
  ({ tenantId: 'acme', userId: 'u1', role: 'custom', permissions: new Set(permissions) }) as never

beforeEach(() => {
  vi.clearAllMocks()
  tenantTimezone.mockResolvedValue('Europe/Rome')
})

describe('tenantTimezoneSettings', () => {
  it('returns the tenant zone and the list the page offers, for the caller\'s tenant', async () => {
    const out = await tenantTimezoneResolvers.Query.tenantTimezoneSettings(null, {}, ctx([]))
    expect(out).toEqual({ timezone: 'Europe/Rome', available: ['UTC', 'Europe/Rome'] })
    expect(tenantTimezone).toHaveBeenCalledWith('acme')
  })

  it('a tenant without a zone reads as null, not as an invented default', async () => {
    tenantTimezone.mockResolvedValue(null)
    const out = await tenantTimezoneResolvers.Query.tenantTimezoneSettings(null, {}, ctx([]))
    expect(out.timezone).toBeNull()
  })
})

describe('setTenantTimezone', () => {
  it('without config.organization the change is refused before anything is written', async () => {
    await expect(tenantTimezoneResolvers.Mutation.setTenantTimezone(null, { timezone: 'UTC' }, ctx(['workspace.use'])))
      .rejects.toThrow(/requires one of: config\.organization/)
    expect(setTenantTimezone).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('writes the zone on the caller\'s tenant, audits the stored value and returns the fresh settings', async () => {
    setTenantTimezone.mockResolvedValue('America/New_York')
    tenantTimezone.mockResolvedValue('America/New_York')
    const c = ctx(['config.organization'])
    const out = await tenantTimezoneResolvers.Mutation.setTenantTimezone(null, { timezone: 'America/New_York' }, c)
    expect(setTenantTimezone).toHaveBeenCalledWith('acme', 'America/New_York')
    // The audit records what was STORED (the lib may normalise it), on the Tenant node.
    expect(audit).toHaveBeenCalledWith(c, 'tenant.timezone.updated', 'Tenant', 'acme', { timezone: 'America/New_York' })
    expect(out).toEqual({ timezone: 'America/New_York', available: ['UTC', 'Europe/Rome'] })
  })

  it('an invalid zone rejected by the lib is not audited', async () => {
    setTenantTimezone.mockRejectedValue(new Error('Time zone "Mars/Olympus" is not a valid IANA time zone'))
    await expect(tenantTimezoneResolvers.Mutation.setTenantTimezone(null, { timezone: 'Mars/Olympus' }, ctx(['config.organization'])))
      .rejects.toThrow(/not a valid IANA/)
    expect(audit).not.toHaveBeenCalled()
  })
})
