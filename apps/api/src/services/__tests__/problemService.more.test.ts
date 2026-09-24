/**
 * problemService.createProblem — the failure paths and custom fields.
 *
 * Why these behaviours matter:
 *  - CIs that do not exist in the tenant (or are not Configuration Items)
 *    must be REPORTED, not silently dropped: the user asked for those links
 *    and would otherwise believe the impact analysis covers them. The problem
 *    itself stays (a problem can legitimately have no CI);
 *  - a problem whose workflow instance cannot be started can never be moved
 *    or closed, so it must be deleted (tenant-scoped) and the creation must
 *    fail with a typed error — and no `problem.created` event may go out for
 *    a problem that no longer exists;
 *  - custom fields sent by the caller are resolved against the tenant's
 *    definitions and the workflow step the problem will start in, then
 *    written on the node.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('../../lib/ticketCIExclusions.js', () => import('../../lib/__tests__/ticketCIExclusionsFake.js'))
vi.mock('../../lib/ticketNumbering.js', () => import('../../lib/__tests__/ticketNumberingFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:Server)`),
}))

const h = vi.hoisted(() => ({
  session: { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn() },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn() } }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(h.session)),
}))
// The creation's event is recorded in its transaction and published after (wave 7 · B2).
vi.mock('../../lib/publishEvent.js', () => import('../../lib/__tests__/publishEventFake.js'))
vi.mock('../../lib/stepEnteredPublisher.js', () => ({ publishStepEnteredForEntity: vi.fn() }))
vi.mock('../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn().mockResolvedValue('new') }))
vi.mock('../../lib/ticketCustomFields.js', () => ({
  customFieldDefs: vi.fn(async () => [{ name: 'cost_centre', fieldType: 'text' }]),
  resolveCustomFieldWrites: vi.fn(async () => ({ cost_centre: 'CC-42' })),
}))
vi.mock('../../lib/customFieldSteps.js', () => ({ creationStepContext: vi.fn(async () => ({ stepName: 'new' })) }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const { createProblem } = await import('../problemService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { resolveCustomFieldWrites, customFieldDefs } = await import('../../lib/ticketCustomFields.js')
const { creationStepContext } = await import('../../lib/customFieldSteps.js')
const { logger } = await import('../../lib/logger.js')

const ctx = { tenantId: 'tenant-1', userId: 'user-1' }
const queriesWith = (needle: string) =>
  vi.mocked(runQuery).mock.calls.map((c) => [c[1] as string, c[2] as Record<string, unknown>] as const).filter(([q]) => q.includes(needle))

/** Which CI ids exist in the tenant (the AFFECTS MERGE returns linked = 1 only for those). */
let existingCIs = new Set<string>()

beforeEach(() => {
  vi.clearAllMocks()
  existingCIs = new Set(['ci-1'])
  // The counter, and the workflow instance with its recorded event (wave 7 · B2): each work runs on a fake tx.
  h.session.executeWrite.mockImplementation(async (work: (tx: unknown) => unknown) => work({ run: vi.fn(async () => ({ records: [{ get: () => 1 }] })) }))
  vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    if (cypher.includes('CREATE (p:Problem')) return [{ props: { id: params?.['id'], tenant_id: params?.['tenantId'], ...(params?.['customProps'] as object) } }]
    if (cypher.includes('MERGE (p)-[r:AFFECTS]->(ci)')) return [{ linked: existingCIs.has(params?.['ciId'] as string) ? 1 : 0 }]
    if (cypher.includes('WHERE ci.id IN $ids')) return (params?.['ids'] as string[]).filter((id) => existingCIs.has(id)).map((id) => ({ id }))
    return []
  }) as never)
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-1' } as never)
})

describe('createProblem — CIs that could not be linked', () => {
  // Review of 23 Sep 2026: the check came after the problem was committed, and
  // threw before its workflow and event — a problem nobody could move or close.
  it('reports the missing CIs with a typed error naming them, BEFORE anything is written', async () => {
    existingCIs = new Set(['ci-1'])
    const err = await createProblem({ title: 'Disk full', priority: 'high', affectedCIs: ['ci-1', 'ci-ghost', 'ci-other-tenant'] }, ctx)
      .then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toContain('2 of the 3 given CIs')
    expect((err as GraphQLError).message).toContain('ci-ghost, ci-other-tenant')
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      i18n: { key: 'errors.problem.ciMissing', params: { missing: 2, total: 3, ids: 'ci-ghost, ci-other-tenant' } },
    })
    expect(queriesWith('WHERE ci.id IN $ids')[0]![0]).toContain('(ci:Application OR ci:Server)')
    expect(queriesWith('CREATE (p:Problem')).toHaveLength(0)
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('a CI deleted between the check and the link: the problem is completed, and the gap logged', async () => {
    existingCIs = new Set(['ci-1', 'ci-2'])
    vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('CREATE (p:Problem')) return [{ props: { id: params?.['id'], tenant_id: params?.['tenantId'] } }]
      if (cypher.includes('WHERE ci.id IN $ids')) return [{ id: 'ci-1' }, { id: 'ci-2' }]
      if (cypher.includes('MERGE (p)-[r:AFFECTS]->(ci)')) return [{ linked: params?.['ciId'] === 'ci-1' ? 1 : 0 }]
      return []
    }) as never)
    await expect(createProblem({ title: 'P', priority: 'low', affectedCIs: ['ci-1', 'ci-2'] }, ctx)).resolves.toBeDefined()
    expect(workflowEngine.createInstance).toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it('every CI linked → no error', async () => {
    existingCIs = new Set(['ci-1', 'ci-2'])
    await expect(createProblem({ title: 'P', priority: 'low', affectedCIs: ['ci-1', 'ci-2'] }, ctx)).resolves.toBeDefined()
  })
})

describe('createProblem — workflow instance failure', () => {
  it('deletes the just-created problem in its tenant, fails with a typed error and publishes nothing', async () => {
    vi.mocked(workflowEngine.createInstance).mockRejectedValue(new Error('no active workflow for problem'))

    const err = await createProblem({ title: 'P', priority: 'high', category: 'network' }, ctx).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toBe('Problem not created: its workflow instance could not be started (no active workflow for problem)')
    expect((err as GraphQLError).extensions).toMatchObject({ i18n: { key: 'errors.problem.workflowInstance', params: { reason: 'no active workflow for problem' } } })

    const created = queriesWith('CREATE (p:Problem')[0]![1]
    const [del] = queriesWith('DETACH DELETE')
    expect(del![0]).toContain('MATCH (p:Problem {id: $id, tenant_id: $tenantId})')
    expect(del![1]).toEqual({ id: created['id'], tenantId: 'tenant-1' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('a non-Error rejection is still reported with its text', async () => {
    vi.mocked(workflowEngine.createInstance).mockRejectedValue('engine offline')
    await expect(createProblem({ title: 'P', priority: 'high' }, ctx)).rejects.toThrow('could not be started (engine offline)')
  })
})

describe('createProblem — custom fields', () => {
  it('resolves them against the tenant definitions and the creation step, and writes them on the node', async () => {
    const input = [{ name: 'cost_centre', value: 'CC-42' }]
    const created = await createProblem({ title: 'P', priority: 'high', category: 'network', customFields: input as never }, ctx)

    expect(customFieldDefs).toHaveBeenCalledWith(h.session, 'tenant-1', 'problem')
    expect(creationStepContext).toHaveBeenCalledWith(h.session, 'tenant-1', 'problem', 'network')
    expect(resolveCustomFieldWrites).toHaveBeenCalledWith('tenant-1', 'problem', [{ name: 'cost_centre', fieldType: 'text' }], input,
      { current: null, stepContext: { stepName: 'new' } })
    expect(queriesWith('CREATE (p:Problem')[0]![1]['customProps']).toEqual({ cost_centre: 'CC-42' })
    expect(created).toMatchObject({ cost_centre: 'CC-42' })
  })

  it('without customFields nothing is resolved and no custom property is written', async () => {
    await createProblem({ title: 'P', priority: 'high' }, ctx)
    expect(resolveCustomFieldWrites).not.toHaveBeenCalled()
    expect(queriesWith('CREATE (p:Problem')[0]![1]['customProps']).toEqual({})
  })

  it('a rejected custom field stops the creation before anything is written', async () => {
    vi.mocked(resolveCustomFieldWrites).mockRejectedValueOnce(new Error('cost_centre is required'))
    await expect(createProblem({ title: 'P', priority: 'high', customFields: [] as never }, ctx)).rejects.toThrow('cost_centre is required')
    expect(queriesWith('CREATE (p:Problem')).toHaveLength(0)
  })
})
