/**
 * RELATED TICKETS — linking incidents/problems and reading the "linked" panels.
 *
 * Why these behaviours matter:
 * - The node label is interpolated into the Cypher, so the entity type must be
 *   checked against a closed list: anything else would be a query-injection door.
 * - Every MATCH carries the caller's tenant: a link between tickets of two
 *   tenants, or a panel listing another tenant's tickets, is a data leak.
 * - Linking/unlinking fails loudly: a wrong id or an already-removed link must
 *   not look like success to the agent who clicked the button.
 * - The panels read a uniform LinkedTicketRef shape; a change created by
 *   automation (`rel.auto`) is flagged as not removable, anything else defaults
 *   to removable, and missing severity/priority come out as null, not undefined.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const runQuery = vi.fn()
const getSession = vi.fn((_db?: unknown, _mode?: string) => ({
  executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
  close,
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: (db?: unknown, mode?: string) => getSession(db, mode),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: vi.fn(),
}))

const R = await import('../relatedTickets.js')

const ctx = { tenantId: 't1', userId: 'u1' } as never
const rec = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] })

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO ERROR' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  txRun.mockResolvedValue({ records: [rec({ id: 'a' })] })
  runQuery.mockResolvedValue([])
})

describe('linkRelatedTicket', () => {
  it('links two tickets of the same type inside the caller tenant, in a write session', async () => {
    await expect(R.linkRelatedTicket(null, { entityType: 'incident', entityId: 'a', otherId: 'b' }, ctx)).resolves.toBe(true)
    const [cypher, params] = txRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (a:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(cypher).toContain('MATCH (b:Incident {id: $otherId,  tenant_id: $tenantId})')
    expect(params).toEqual({ entityId: 'a', otherId: 'b', tenantId: 't1' })
    expect(getSession.mock.calls[0]?.[1]).toBe('WRITE')
    // The session is always released, even on the happy path.
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses the Problem label for problems', async () => {
    await R.linkRelatedTicket(null, { entityType: 'problem', entityId: 'a', otherId: 'b' }, ctx)
    expect(String(txRun.mock.calls[0]?.[0])).toContain('(a:Problem')
  })

  it('rejects an unknown entity type before touching the database (the label is interpolated)', async () => {
    expect(await code(() => R.linkRelatedTicket(null, { entityType: 'Incident) DETACH DELETE (x', entityId: 'a', otherId: 'b' }, ctx))).toBe('BAD_USER_INPUT')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('refuses to link a ticket to itself', async () => {
    expect(await code(() => R.linkRelatedTicket(null, { entityType: 'incident', entityId: 'a', otherId: 'a' }, ctx))).toBe('BAD_USER_INPUT')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('fails with NOT_FOUND when either ticket is missing (or belongs to another tenant)', async () => {
    txRun.mockResolvedValue({ records: [] })
    expect(await code(() => R.linkRelatedTicket(null, { entityType: 'incident', entityId: 'a', otherId: 'b' }, ctx))).toBe('NOT_FOUND')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('unlinkRelatedTicket', () => {
  it('deletes the RELATED_TO edge scoped to the tenant on both ends', async () => {
    txRun.mockResolvedValue({ records: [rec({ n: 1 })] })
    await expect(R.unlinkRelatedTicket(null, { entityType: 'problem', entityId: 'a', otherId: 'b' }, ctx)).resolves.toBe(true)
    const [cypher, params] = txRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('(a:Problem {id: $entityId, tenant_id: $tenantId})-[r:RELATED_TO]-(b:Problem {id: $otherId, tenant_id: $tenantId})')
    expect(params['tenantId']).toBe('t1')
  })

  it('a link that was not there is NOT_FOUND, not a silent success', async () => {
    txRun.mockResolvedValue({ records: [rec({ n: 0 })] })
    expect(await code(() => R.unlinkRelatedTicket(null, { entityType: 'incident', entityId: 'a', otherId: 'b' }, ctx))).toBe('NOT_FOUND')
  })

  it('an empty result is also NOT_FOUND', async () => {
    txRun.mockResolvedValue({ records: [] })
    expect(await code(() => R.unlinkRelatedTicket(null, { entityType: 'incident', entityId: 'a', otherId: 'b' }, ctx))).toBe('NOT_FOUND')
  })

  it('rejects an unknown entity type', async () => {
    expect(await code(() => R.unlinkRelatedTicket(null, { entityType: 'change', entityId: 'a', otherId: 'b' }, ctx))).toBe('BAD_USER_INPUT')
  })
})

describe('field resolvers — the linked-ticket panels', () => {
  const cases = [
    ['incidentRelatedIncidents', R.incidentRelatedIncidents, '(i:Incident {id: $id, tenant_id: $t})-[:RELATED_TO]-(o:Incident {tenant_id: $t})'],
    ['incidentRelatedProblems', R.incidentRelatedProblems, '(p:Problem {tenant_id: $t})-[:CAUSED_BY]->(i:Incident {id: $id, tenant_id: $t})'],
    ['incidentRelatedChanges', R.incidentRelatedChanges, '(i:Incident {id: $id, tenant_id: $t})-[rel:RESOLVED_BY]->(c:Change {tenant_id: $t})'],
    ['problemLinkedIncidents', R.problemLinkedIncidents, '(p:Problem {id: $id, tenant_id: $t})-[:CAUSED_BY]->(i:Incident {tenant_id: $t})'],
    ['problemRelatedProblems', R.problemRelatedProblems, '(p:Problem {id: $id, tenant_id: $t})-[:RELATED_TO]-(o:Problem {tenant_id: $t})'],
    ['problemLinkedChanges', R.problemLinkedChanges, '(p:Problem {id: $id, tenant_id: $t})-[rel:RESOLVED_BY]->(c:Change {tenant_id: $t})'],
  ] as const

  it.each(cases)('%s scopes both ends of the pattern to the tenant', async (_n, fn, pattern) => {
    await fn({ id: 'x1' }, null, ctx)
    const [, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain(pattern)
    expect(params).toEqual({ id: 'x1', t: 't1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('the change panels hide deleted changes and show the workflow step as status', async () => {
    await R.incidentRelatedChanges({ id: 'x1' }, null, ctx)
    await R.problemLinkedChanges({ id: 'x1' }, null, ctx)
    for (const call of runQuery.mock.calls) {
      const cypher = String(call[1])
      expect(cypher).toContain('coalesce(c.deleted, false) = false')
      expect(cypher).toContain("coalesce(wi.current_step, '') AS status")
    }
  })

  it('normalises rows: missing severity/priority become null, removable defaults to true', async () => {
    runQuery.mockResolvedValue([
      { id: 'i1', number: 'INC1', title: 'T', status: 'new', severity: 'high', extra: 'dropped' },
      { id: 'c1', number: 'CHG1', title: 'C', status: 'draft', removable: false },
    ])
    const out = await R.incidentRelatedIncidents({ id: 'x' }, null, ctx)
    expect(out).toEqual([
      { id: 'i1', number: 'INC1', title: 'T', status: 'new', severity: 'high', priority: null, removable: true },
      // An automation-created RESOLVED_BY link must stay non-removable.
      { id: 'c1', number: 'CHG1', title: 'C', status: 'draft', severity: null, priority: null, removable: false },
    ])
  })
})
