/**
 * THE PROBLEMS STILL OPEN ON AN INCIDENT'S CIs (owner, 25 Sep 2026): the known
 * error matching of ITIL, proposed on the incident and never applied on its own.
 *
 * What these pin:
 *  - «open» and «known error» come from the steps of the tenant's problem
 *    workflow (class and purpose), never from their names;
 *  - only the problems on the incident's CIs and not linked to it yet, known
 *    errors first, and a bounded list;
 *  - each suggestion says why it is there: the incident's CIs it affects, in
 *    name order, and its workaround;
 *  - an incident that does not exist is an error, not an empty list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const queries: { cypher: string; params: Record<string, unknown> }[] = []
let rows: unknown[] = []
let incidentExists = true

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    queries.push({ cypher, params })
    return rows
  }),
  runQueryOne: vi.fn(async () => (incidentExists ? { id: 'inc-1' } : null)),
  getSession:  vi.fn(),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))

vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }
})

vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()
  return {
    ...actual,
    getStepNamesByClass:   vi.fn(async () => ({ open: ['nuovo', 'in_analisi', 'documentato'], in_progress: [], resolved: ['risolto'], closed: ['chiuso'] })),
    getStepNamesByPurpose: vi.fn(async () => ['documentato']),
  }
})

const { problemResolvers } = await import('../problem.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }
const suggest = () => problemResolvers.Query.incidentProblemSuggestions(undefined, { incidentId: 'inc-1' }, ctx)

beforeEach(() => { queries.length = 0; rows = []; incidentExists = true })

describe('incidentProblemSuggestions', () => {
  it('asks for the open problems on the incident\'s CIs not linked to it, known errors first, from the steps\' class and purpose', async () => {
    await suggest()
    expect(queries).toHaveLength(1)
    const { cypher, params } = queries[0]!
    expect(cypher).toContain('(i:Incident {id: $incidentId, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci:ConfigurationItem {tenant_id: $tenantId})<-[:AFFECTS]-(p:Problem {tenant_id: $tenantId})')
    expect(cypher).toContain('NOT (p)-[:CAUSED_BY]->(i)')
    expect(cypher).toMatch(/ORDER BY CASE WHEN p\.status IN \$known THEN 0 ELSE 1 END, p\.updated_at DESC\s+LIMIT 20/)
    // No step name written in the query: the tenant's own, whatever they are called.
    expect(cypher).not.toMatch(/'(known_error|under_investigation|closed|resolved)'/)
    expect(params).toEqual({ incidentId: 'inc-1', tenantId: 'tenant-1', open: ['nuovo', 'in_analisi', 'documentato'], known: ['documentato'] })
  })

  it('each suggestion: the problem, whether it is a known error, its workaround and the incident\'s CIs it affects', async () => {
    rows = [
      { props: { id: 'p1', number: 'PRB0000044', title: 'Picchi di CPU', status: 'documentato', workaround: 'Riavviare il pool' },
        cis: [{ id: 's2', name: 'SRV-020' }, { id: 'd1', name: 'DB-CRM' }] },
      { props: { id: 'p2', title: 'Lentezza del portale', status: 'in_analisi' }, cis: [{ id: 's2', name: 'SRV-020' }] },
    ]
    expect(await suggest()).toEqual([
      { id: 'p1', number: 'PRB0000044', title: 'Picchi di CPU', status: 'documentato', knownError: true, workaround: 'Riavviare il pool',
        cis: [{ id: 'd1', name: 'DB-CRM' }, { id: 's2', name: 'SRV-020' }] },
      { id: 'p2', number: '', title: 'Lentezza del portale', status: 'in_analisi', knownError: false, workaround: null,
        cis: [{ id: 's2', name: 'SRV-020' }] },
    ])
  })

  it('an incident that does not exist is an error, not an empty list', async () => {
    incidentExists = false
    await expect(suggest()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(queries).toHaveLength(0)
  })
})
