/**
 * The diagnostics list of service maps whose incident the monitoring engine
 * could not handle (SV-4). The engine writes the reason on the map and clears
 * it on the next successful reconciliation; this read is what tells an admin
 * "these services are broken and nobody gets an incident for them".
 *
 * What must not regress: the read is scoped to ONE tenant (a diagnostics page
 * listing another customer's services would leak across the perimeter), only
 * maps that actually carry a problem are listed, and a map without a name is
 * still shown (by id) instead of disappearing.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Queryable } from '@opengraphity/neo4j'
import { serviceMapsWithIncidentProblem, SERVICE_INCIDENT_PROBLEMS_CYPHER } from '../serviceIncidentProblems.js'

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })

function sessionReturning(rows: Array<Record<string, unknown>>) {
  const run = vi.fn(async () => ({ records: rows.map(rec) }))
  return { session: { run } as unknown as Queryable, run }
}

describe('serviceMapsWithIncidentProblem', () => {
  it('reads only the given tenant, and only maps that carry an incident problem', async () => {
    const { session, run } = sessionReturning([])
    await serviceMapsWithIncidentProblem(session, 'tenant-a')
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(params).toEqual({ tenantId: 'tenant-a' })
    // Tenant scoping is in the MATCH itself, not left to the caller.
    expect(cypher).toContain('ServiceMap {tenant_id: $tenantId}')
    expect(cypher).toContain('m.incident_problem IS NOT NULL')
    expect(cypher).toBe(SERVICE_INCIDENT_PROBLEMS_CYPHER)
  })

  it('maps each record to {id, name} as strings, preserving the query order', async () => {
    const { session } = sessionReturning([
      { id: 'map-2', name: 'Billing' },
      // The Cypher coalesces a missing name to the id: the row keeps showing.
      { id: 'map-9', name: 'map-9' },
      { id: 42, name: 7 },
    ])
    expect(await serviceMapsWithIncidentProblem(session, 'tenant-a')).toEqual([
      { id: 'map-2', name: 'Billing' },
      { id: 'map-9', name: 'map-9' },
      { id: '42', name: '7' },
    ])
  })

  it('no broken maps means an empty list, not an error', async () => {
    const { session } = sessionReturning([])
    expect(await serviceMapsWithIncidentProblem(session, 'tenant-a')).toEqual([])
  })
})
