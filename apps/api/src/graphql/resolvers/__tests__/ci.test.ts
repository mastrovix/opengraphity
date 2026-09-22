/**
 * The tickets shown on a CI's detail page (resolvers/ci.ts): ciIncidents,
 * ciChanges, ciProblems, ciServiceRequests.
 *
 * What a user loses if this regresses:
 *  - the ticket side of every query is scoped by the caller's tenant, so a CI
 *    id guessed from another organization never lists foreign tickets;
 *  - each list follows the REAL relationship its ticket uses
 *    (TICKET_CI_RELATIONSHIP): a wrong type does not fail, it silently shows
 *    an empty tab;
 *  - deleted changes stay out of the CI's change list;
 *  - incidents, changes and requests go through the SAME mapper as their main
 *    lists (B-15): a hand-built object missed non-nullable fields and the
 *    client got "Cannot return null";
 *  - problems keep their contract for missing optional data: no number → '',
 *    no priority → null (never undefined, which GraphQL rejects for String!).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TICKET_CI_RELATIONSHIP } from '@opengraphity/types'
import type { GraphQLContext } from '../../../context.js'

const runQuery = vi.fn()
const session = { tag: 'session' }
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))
vi.mock('../../../lib/mappers.js', () => ({ mapIncident: (p: Record<string, unknown>) => ({ mappedBy: 'mapIncident', id: p['id'] }) }))
vi.mock('../change/mappers.js', () => ({ mapChange: (p: Record<string, unknown>) => ({ mappedBy: 'mapChange', id: p['id'] }) }))
vi.mock('../../../services/requestService.js', () => ({ mapRequest: (p: Record<string, unknown>) => ({ mappedBy: 'mapRequest', id: p['id'] }) }))

const { ciResolvers } = await import('../ci.js')
const Q = ciResolvers.Query

const ctx = { tenantId: 'tenant-a' } as GraphQLContext
const squash = (s: unknown) => String(s).replace(/\s+/g, ' ').trim()
const lastCall = () => runQuery.mock.calls.at(-1)!

beforeEach(() => { runQuery.mockReset() })

describe('ciIncidents', () => {
  it('follows the incident relationship, tenant-scoped, and maps with the list mapper', async () => {
    runQuery.mockResolvedValue([{ props: { id: 'inc-1' } }, { props: { id: 'inc-2' } }])
    const out = await Q.ciIncidents(undefined, { ciId: 'ci-1' }, ctx)
    const [s, cypher, params] = lastCall()
    expect(s).toBe(session)
    expect(squash(cypher)).toContain(`MATCH (i:Incident {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.incident}]->(n {id: $ciId})`)
    expect(squash(cypher)).toContain('ORDER BY i.created_at DESC')
    expect(params).toEqual({ ciId: 'ci-1', tenantId: 'tenant-a' })
    expect(out).toEqual([{ mappedBy: 'mapIncident', id: 'inc-1' }, { mappedBy: 'mapIncident', id: 'inc-2' }])
  })
})

describe('ciChanges', () => {
  it('follows the change relationship, excludes deleted changes and uses the change mapper', async () => {
    runQuery.mockResolvedValue([{ props: { id: 'chg-1' } }])
    const out = await Q.ciChanges(undefined, { ciId: 'ci-1' }, ctx)
    const [, cypher, params] = lastCall()
    expect(squash(cypher)).toContain(`MATCH (c:Change {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.change}]->(n {id: $ciId})`)
    expect(squash(cypher)).toContain('WHERE coalesce(c.deleted, false) = false')
    expect(params).toEqual({ ciId: 'ci-1', tenantId: 'tenant-a' })
    expect(out).toEqual([{ mappedBy: 'mapChange', id: 'chg-1' }])
  })
})

describe('ciProblems', () => {
  it('scopes both the problem and the CI by tenant, via the problem relationship', async () => {
    runQuery.mockResolvedValue([])
    await expect(Q.ciProblems(undefined, { ciId: 'ci-1' }, ctx)).resolves.toEqual([])
    const [, cypher, params] = lastCall()
    expect(squash(cypher)).toContain(`MATCH (p:Problem {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.problem}]->(n {id: $ciId, tenant_id: $tenantId})`)
    expect(params).toEqual({ ciId: 'ci-1', tenantId: 'tenant-a' })
  })

  it('maps snake_case props to the GraphQL shape, with "" / null for missing number / priority', async () => {
    runQuery.mockResolvedValue([
      { props: { id: 'prb-1', number: 'PRB00000001', title: 'Disk full', priority: 'high', status: 'open', created_at: 'c1', updated_at: 'u1' } },
      { props: { id: 'prb-2', title: 'Legacy', status: 'closed', created_at: 'c2', updated_at: 'u2' } },
    ])
    await expect(Q.ciProblems(undefined, { ciId: 'ci-1' }, ctx)).resolves.toEqual([
      { id: 'prb-1', number: 'PRB00000001', title: 'Disk full', priority: 'high', status: 'open', createdAt: 'c1', updatedAt: 'u1' },
      { id: 'prb-2', number: '', title: 'Legacy', priority: null, status: 'closed', createdAt: 'c2', updatedAt: 'u2' },
    ])
  })
})

describe('ciServiceRequests', () => {
  it('follows the request relationship (CM-8), tenant-scoped on both ends, with the request mapper', async () => {
    runQuery.mockResolvedValue([{ props: { id: 'req-1' } }])
    const out = await Q.ciServiceRequests(undefined, { ciId: 'ci-9' }, ctx)
    const [, cypher, params] = lastCall()
    expect(squash(cypher)).toContain(`MATCH (r:ServiceRequest {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.service_request}]->(n {id: $ciId, tenant_id: $tenantId})`)
    expect(params).toEqual({ ciId: 'ci-9', tenantId: 'tenant-a' })
    expect(out).toEqual([{ mappedBy: 'mapRequest', id: 'req-1' }])
  })
})
