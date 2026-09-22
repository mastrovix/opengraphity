/**
 * OLA/UC: the three reads the breach sweep leans on.
 *
 * An OLA is an internal commitment between teams and a UC one with a
 * supplier; both fire an alert when a ticket is about to miss its target.
 * These three functions decide WHICH contracts apply, WHAT time zone the
 * deadline is computed in, and WHETHER the ticket is still open at all.
 *
 * Getting the last one wrong is the visible defect: an alert on a ticket
 * already resolved. Getting the time zone wrong is the invisible one — every
 * business-hours deadline silently shifts by the offset between the server
 * and the customer, which is why a missing zone is an error and not a
 * fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  closed: 0,
}))

vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...await importOriginal<typeof import('@opengraphity/neo4j')>(),
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          state.queries.push({ cypher, params })
          return { records: state.rows.map((r) => ({ get: (k: string) => r[k] })) }
        },
      }),
    close: async () => { state.closed += 1 },
  }),
}))

const { getActiveOLAContractsFor, getTenantTimezone, isEntityResolved } = await import('../olaBreach.js')

beforeEach(() => { state.rows = []; state.queries = []; state.closed = 0 })

describe('getActiveOLAContractsFor', () => {
  it('maps a contract row, reading Neo4j integers as numbers', async () => {
    state.rows = [{ id: 'ola-1', name: 'Rete — 4h', type: 'ola', resolveMinutes: 240, businessHours: true, calendarId: 'cal-1' }]
    expect(await getActiveOLAContractsFor('c-one', 'incident')).toEqual([{
      id: 'ola-1', name: 'Rete — 4h', type: 'ola',
      resolve_minutes: 240, business_hours: true, calendar_id: 'cal-1',
    }])
    expect(state.closed).toBe(1)
  })

  it('asks only for the ENABLED contracts of this tenant, its own type or "any"', async () => {
    // `coalesce(o.enabled, true)`: contracts created before the switch
    // existed have no property, and absent must mean enabled — not disabled,
    // which would quietly stop every alert a customer already relied on.
    await getActiveOLAContractsFor('c-one', 'incident')
    const { cypher, params } = state.queries[0]!
    expect(cypher).toContain('coalesce(o.enabled, true) = true')
    expect(cypher).toContain("o.entity_type = $entityType OR o.entity_type = 'any'")
    expect(cypher).toContain('{tenant_id: $tenantId}')
    expect(params).toEqual({ tenantId: 'c-one', entityType: 'incident' })
  })

  it('a contract with no calendar counts 24x7: null, not undefined', async () => {
    state.rows = [{ id: 'ola-1', name: 'x', type: 'uc', resolveMinutes: 60, businessHours: false, calendarId: null }]
    expect((await getActiveOLAContractsFor('c-one', 'change'))[0]!.calendar_id).toBeNull()
  })

  it('no contracts is an empty list, not an error', async () => {
    expect(await getActiveOLAContractsFor('c-one', 'incident')).toEqual([])
  })
})

describe('getTenantTimezone', () => {
  it('returns the configured zone', async () => {
    state.rows = [{ timezone: 'Europe/Rome' }]
    expect(await getTenantTimezone('c-one')).toBe('Europe/Rome')
    expect(state.closed).toBe(1)
  })

  it('a missing, empty or non-string zone is an ERROR that says what cannot be computed', async () => {
    // Falling back to the server zone would shift every business-hours
    // deadline of that customer, silently and by a whole offset.
    for (const timezone of [null, undefined, '', 42]) {
      state.rows = [{ timezone }]
      await expect(getTenantTimezone('c-one')).rejects.toThrow(/has no timezone configured/)
    }
  })

  it('a tenant that does not exist is the same error, and the session still closes', async () => {
    state.rows = []
    await expect(getTenantTimezone('c-ghost')).rejects.toThrow('[sla:ola] Tenant c-ghost has no timezone configured')
    expect(state.closed).toBe(1)
  })
})

describe('isEntityResolved — is this alert a false alarm?', () => {
  it.each([
    ['incident',        'Incident',       'resolved_at'],
    ['problem',         'Problem',        'resolved_at'],
    ['service_request', 'ServiceRequest', 'completed_at'],
    ['change',          'Change',         'completed_at'],
  ])('%s reads %s.%s, with its label and its own conclusion field', async (entityType, label, field) => {
    // The conclusion of a service request is `completed_at`, not
    // `resolved_at`: reading the wrong field would make every request look
    // permanently open and alert forever.
    state.rows = [{ resolvedAt: '2026-09-01T10:00:00Z' }]
    expect(await isEntityResolved('c-one', entityType, 'e-1')).toBe(true)
    const { cypher, params } = state.queries[0]!
    expect(cypher).toContain(`MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})`)
    expect(cypher).toContain(`RETURN e.${field} AS resolvedAt`)
    expect(params).toEqual({ entityId: 'e-1', tenantId: 'c-one' })
  })

  it('a ticket still open is not resolved', async () => {
    state.rows = [{ resolvedAt: null }]
    expect(await isEntityResolved('c-one', 'incident', 'inc-1')).toBe(false)
  })

  it('an entity that is GONE counts as resolved: there is nothing left to alert on', async () => {
    // A deleted ticket must not keep firing OLA alerts at the team that
    // deleted it.
    state.rows = []
    expect(await isEntityResolved('c-one', 'incident', 'inc-deleted')).toBe(true)
  })

  it('an entity type with no known conclusion field counts as still open, and asks nothing', async () => {
    // Treating it as resolved would silently switch OLA alerts off for a new
    // entity type; treating it as open keeps them, and the alert is visible.
    expect(await isEntityResolved('c-one', 'kb_article', 'kb-1')).toBe(false)
    expect(state.queries).toEqual([])
  })
})
