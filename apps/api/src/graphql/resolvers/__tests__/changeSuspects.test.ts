/**
 * THE FIRST SUSPECTS OF AN INCIDENT (owner, 25 Sep 2026): the changes on its
 * CIs being released when it opened, or released in the tenant's window before.
 *
 * What these pin:
 *  - the release step is the one with the `implementation` purpose, whatever its
 *    name, and the window is the tenant's `recentChangesDays` counted back from
 *    the incident's opening, not from now;
 *  - running at the opening first; a running change has no «released at»;
 *  - no change workflow: nothing to suspect; a change workflow with no release
 *    step: it stops and says so; an incident that does not exist: an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const queries: { cypher: string; params: Record<string, unknown> }[] = []
let rows: unknown[] = []
let opened: { openedAt: string } | null = { openedAt: '2026-09-20T09:12:00.000Z' }
let releaseSteps = ['rilascio']
let changeSteps = [{ name: 'rilascio' }]

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    queries.push({ cypher, params })
    return rows
  }),
  runQueryOne: vi.fn(async () => opened),
  getSession:  vi.fn(),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return { ...actual, withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})) }
})
vi.mock('../../../lib/workflowHelpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/workflowHelpers.js')>()
  return { ...actual, getStepNamesByPurpose: vi.fn(async () => releaseSteps), getWorkflowSteps: vi.fn(async () => changeSteps) }
})
vi.mock('../../../lib/impactWeights.js', () => ({ impactAnalysisWeights: vi.fn(async () => ({ recentChangesDays: 7 })) }))

const { changeSuspectResolvers } = await import('../changeSuspects.js')
const { getStepNamesByPurpose } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }
const suspects = () => changeSuspectResolvers.Query.incidentChangeSuspects(undefined, { incidentId: 'inc-1' }, ctx)

beforeEach(() => {
  queries.length = 0; rows = []; opened = { openedAt: '2026-09-20T09:12:00.000Z' }
  releaseSteps = ['rilascio']; changeSteps = [{ name: 'rilascio' }]
})

describe('incidentChangeSuspects', () => {
  it('asks the step history for the release steps entered before the opening, in the tenant\'s window counted back from it', async () => {
    await suspects()
    expect(vi.mocked(getStepNamesByPurpose)).toHaveBeenCalledWith({}, 'tenant-1', 'change', ['implementation'])
    expect(queries).toHaveLength(1)
    const { cypher, params } = queries[0]!
    expect(cypher).toContain('-[:AFFECTED_BY]->(ci:ConfigurationItem {tenant_id: $tenantId})<-[:AFFECTS_CI]-(c:Change {tenant_id: $tenantId})')
    expect(cypher).toContain('coalesce(c.deleted, false) = false')
    expect(cypher).toContain('e.step_name IN $release AND e.entered_at <= $openedAt')
    expect(cypher).toMatch(/ORDER BY running DESC, lastEnd DESC\s+LIMIT 20/)
    // Seven days before the opening, not before now.
    expect(params).toEqual({ incidentId: 'inc-1', tenantId: 'tenant-1', openedAt: '2026-09-20T09:12:00.000Z', since: '2026-09-13T09:12:00.000Z', release: ['rilascio'] })
  })

  it('a change running at the opening has no «released at»; another says when its release ended; CIs in name order', async () => {
    rows = [
      { props: { id: 'c1', code: 'CHG0000231', title: 'Patch del kernel', status: 'rilascio' }, cis: [{ id: 's2', name: 'SRV-020' }], running: true, lastEnd: '2026-09-20T10:00:00.000Z' },
      { props: { id: 'c2', number: 'CHG0000219', title: 'Nuovo indice', status: 'chiusa' }, cis: [{ id: 'd1', name: 'DB-CRM' }, { id: 'a1', name: 'CRM' }], running: false, lastEnd: '2026-09-18T22:00:00.000Z' },
    ]
    expect(await suspects()).toEqual([
      { id: 'c1', code: 'CHG0000231', title: 'Patch del kernel', status: 'rilascio', runningAtOpening: true, releasedAt: null, cis: [{ id: 's2', name: 'SRV-020' }] },
      { id: 'c2', code: 'CHG0000219', title: 'Nuovo indice', status: 'chiusa', runningAtOpening: false, releasedAt: '2026-09-18T22:00:00.000Z',
        cis: [{ id: 'a1', name: 'CRM' }, { id: 'd1', name: 'DB-CRM' }] },
    ])
  })

  it('no change workflow: nothing to suspect, nothing wrong', async () => {
    releaseSteps = []; changeSteps = []
    expect(await suspects()).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('a change workflow with no release step stops and says so', async () => {
    releaseSteps = []
    await expect(suspects()).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.change.noImplementationStep' } } })
    expect(queries).toHaveLength(0)
  })

  it('an incident that does not exist is an error, not an empty list', async () => {
    opened = null
    await expect(suspects()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})
