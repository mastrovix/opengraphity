/**
 * lib/ticketsWithoutSla.ts — open tickets that no SLA policy covers.
 *
 * Since there are no factory SLA policies any more, a ticket outside every
 * policy simply has no SLA, and the administrator must see it in the
 * configuration check. If the query lost its tenant scope a customer would see
 * someone else's ticket numbers; if it counted tickets whose creator already
 * acknowledged the warning, the list would never empty out.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'neo4j-driver'

const { ticketsWithoutSla } = await import('../ticketsWithoutSla.js')

function fakeSession(records: Array<Record<string, unknown>>) {
  const run = vi.fn(async () => ({ records: records.map((r) => ({ get: (k: string) => r[k] })) }))
  const session = { executeRead: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({ run })) }
  return { session: session as unknown as Session, run }
}

describe('ticketsWithoutSla', () => {
  it('reads only the tenant, skips closed and acknowledged tickets, passes the limit', async () => {
    const { session, run } = fakeSession([{ count: 12, numbers: ['INC1', 'REQ2'] }])
    expect(await ticketsWithoutSla(session, 't1', 2)).toEqual({ count: 12, numbers: ['INC1', 'REQ2'] })
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(params).toEqual({ tenantId: 't1', limit: 2 })
    // All three ticket kinds that carry an SLA, each scoped to the tenant.
    for (const label of ['Incident', 'Problem', 'ServiceRequest']) {
      expect(cypher).toContain(`(e:${label} {tenant_id: $tenantId})`)
    }
    expect(cypher).toContain('sla_absence_acknowledged_at IS NULL')
    expect(cypher).toContain('coalesce(e.resolved_at, e.completed_at, e.closed_at) IS NULL')
  })

  it('uses a limit of 10 by default', async () => {
    const { session, run } = fakeSession([{ count: 0, numbers: [] }])
    await ticketsWithoutSla(session, 't1')
    expect((run.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]['limit']).toBe(10)
  })

  it('converts a Neo4j Integer count to a plain number', async () => {
    const { session } = fakeSession([{ count: { toNumber: () => 4 }, numbers: ['A'] }])
    expect(await ticketsWithoutSla(session, 't1')).toEqual({ count: 4, numbers: ['A'] })
  })

  it('treats a null numbers list as empty', async () => {
    const { session } = fakeSession([{ count: 0, numbers: null }])
    expect(await ticketsWithoutSla(session, 't1')).toEqual({ count: 0, numbers: [] })
  })

  it('returns zero when the query yields no record', async () => {
    const { session } = fakeSession([])
    expect(await ticketsWithoutSla(session, 't1')).toEqual({ count: 0, numbers: [] })
  })
})
