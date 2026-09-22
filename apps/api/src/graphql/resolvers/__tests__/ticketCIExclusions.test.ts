/**
 * The CI types excluded per ticket type, read and saved from the UI (CM-8).
 *
 * Why these behaviours matter:
 *  - Without a `ticketType` the query must list EVERY ticket type that links
 *    CIs: the settings page renders one row per type, and a missing one would
 *    be a type the admin cannot configure.
 *  - An unknown ticket type is refused with a clear error, not answered with
 *    an empty list (which would read as "nothing excluded").
 *  - The save is audited with the list before and after, read for the
 *    caller's tenant: the audit log is how an admin finds out why a CI can no
 *    longer be linked. A bogus ticket type must not crash the "before" read —
 *    the store rejects it with its own validation message.
 * (The permission for the mutation is enforced by lib/operationPermissions.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TICKET_CI_TYPES } from '@opengraphity/types'

const excludedCITypes = vi.fn()
const saveExclusions = vi.fn()
vi.mock('../../../lib/ticketCIExclusions.js', async () => {
  const { TICKET_CI_TYPES: types, isTicketCIType } = await import('@opengraphity/types')
  return {
    TICKET_CI_TYPES: types,
    // Same contract as the real one: returns the type or throws.
    assertTicketCIType: (v: unknown) => { if (isTicketCIType(v)) return v; throw new Error(`Ticket type "${String(v)}" does not link CIs`) },
    excludedCITypes: (...a: unknown[]) => excludedCITypes(...a),
    setTicketCIExclusions: (...a: unknown[]) => saveExclusions(...a),
  }
})
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { ticketCIExclusionResolvers } = await import('../ticketCIExclusions.js')

const ctx = { tenantId: 't1', userId: 'u1', role: 'admin', permissions: new Set<string>() } as never

beforeEach(() => {
  vi.clearAllMocks()
  excludedCITypes.mockImplementation(async (_t: string, type: string) => (type === 'incident' ? ['Printer'] : []))
})

describe('ticketCIExclusions query', () => {
  it('without a ticket type returns one entry per ticket type that links CIs, read for the caller tenant', async () => {
    const out = await ticketCIExclusionResolvers.Query.ticketCIExclusions(null, {}, ctx)
    expect(out.map((e) => e.ticketType)).toEqual([...TICKET_CI_TYPES])
    expect(out.find((e) => e.ticketType === 'incident')?.ciTypes).toEqual(['Printer'])
    for (const call of excludedCITypes.mock.calls) expect(call[0]).toBe('t1')
  })

  it('with a ticket type returns only that one', async () => {
    const out = await ticketCIExclusionResolvers.Query.ticketCIExclusions(null, { ticketType: 'incident' }, ctx)
    expect(out).toEqual([{ ticketType: 'incident', ciTypes: ['Printer'] }])
  })

  it('an unknown ticket type is refused, not answered with "nothing excluded"', async () => {
    await expect(ticketCIExclusionResolvers.Query.ticketCIExclusions(null, { ticketType: 'invoice' }, ctx))
      .rejects.toThrow(/does not link CIs/)
  })
})

describe('setTicketCIExclusions mutation', () => {
  it('saves for the caller tenant and audits the list before and after', async () => {
    saveExclusions.mockResolvedValue({ ticketType: 'incident', ciTypes: ['Printer', 'Phone'] })
    const out = await ticketCIExclusionResolvers.Mutation.setTicketCIExclusions(
      null, { ticketType: 'incident', ciTypes: ['Printer', 'Phone'] }, ctx)
    expect(saveExclusions).toHaveBeenCalledWith('t1', 'incident', ['Printer', 'Phone'])
    expect(out).toEqual({ ticketType: 'incident', ciTypes: ['Printer', 'Phone'] })
    expect(audit).toHaveBeenCalledWith(ctx, 'ticket_ci_exclusions.updated', 'Tenant', 't1',
      { ticketType: 'incident', from: ['Printer'], to: ['Printer', 'Phone'] })
  })

  it('an unknown ticket type skips the "before" read and lets the store reject it; nothing is audited', async () => {
    saveExclusions.mockRejectedValue(new Error('Ticket type "invoice" does not link CIs'))
    await expect(ticketCIExclusionResolvers.Mutation.setTicketCIExclusions(null, { ticketType: 'invoice', ciTypes: [] }, ctx))
      .rejects.toThrow(/does not link CIs/)
    expect(excludedCITypes).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('an unknown ticket type the store accepts is audited with an empty "before"', async () => {
    // Defensive path: the resolver never reads "before" for a type it does not know.
    saveExclusions.mockResolvedValue({ ticketType: 'x', ciTypes: [] })
    await ticketCIExclusionResolvers.Mutation.setTicketCIExclusions(null, { ticketType: '', ciTypes: [] }, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'ticket_ci_exclusions.updated', 'Tenant', 't1', { ticketType: 'x', from: [], to: [] })
  })
})
