/**
 * The five "reopen" mutations of a change's tasks — the GraphQL binding.
 *
 * Each mutation is one line that picks a task kind and an argument name
 * (`taskId` for assessment/deploy plan, `id` for the other three). A slip in
 * that line is not a crash: it reopens NOTHING (NOT_FOUND on a valid id) or,
 * worse, looks up the task under the wrong label. So here each mutation runs
 * through the real `reopenTask` and we pin:
 *  - the Neo4j label/relationship it targets and the id it reads from args;
 *  - that it stays scoped to the caller's tenant;
 *  - that without `approval.override` nobody reopens anything (the real
 *    permission check, not a mock).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const txRun = vi.fn()
const runQueryOne = vi.fn()
vi.mock('../../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run: txRun }),
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('../helpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  writeAudit: vi.fn(),
  getCIName: vi.fn(async () => 'VM-01'),
  resetChangeRisk: vi.fn(),
}))
vi.mock('../autoTransitions.js', () => ({ evaluateAutoTransitions: vi.fn() }))

const m = await import('../reopenMutations.js')

const admin = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') } as never
const operator = { tenantId: 't1', userId: 'u2', userEmail: 'o@x', role: 'operator', permissions: perms('operator') } as never

beforeEach(() => {
  vi.clearAllMocks()
  runQueryOne.mockImplementation(async (_s: unknown, cypher: string) =>
    cypher.includes('RETURN c.id AS changeId')
      ? { changeId: 'chg-1', ciId: 'ci-1', role: null }
      : { props: { id: 'task-1', status: 'pending' } })
})

/** The first lookup the reopen does: which task node, under which relation, for which id. */
function lookup() {
  const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
  return { cypher, params }
}

describe('each reopen mutation targets its own task kind', () => {
  it.each([
    ['reopenAssessmentTask', () => m.reopenAssessmentTask(null, { taskId: 'task-1', reason: 'r' }, admin), 'HAS_ASSESSMENT', 'AssessmentTask'],
    ['reopenDeployPlanTask', () => m.reopenDeployPlanTask(null, { taskId: 'task-1', reason: 'r' }, admin), 'HAS_DEPLOY_PLAN', 'DeployPlanTask'],
    ['reopenValidationTest', () => m.reopenValidationTest(null, { id: 'task-1', reason: 'r' }, admin), 'HAS_VALIDATION', 'ValidationTest'],
    ['reopenDeploymentTask', () => m.reopenDeploymentTask(null, { id: 'task-1', reason: 'r' }, admin), 'HAS_DEPLOYMENT', 'DeploymentTask'],
    ['reopenReviewTask', () => m.reopenReviewTask(null, { id: 'task-1', reason: 'r' }, admin), 'HAS_REVIEW', 'ReviewTask'],
  ])('%s → [:%s]->(:%s), tenant-scoped, id read from the right argument', async (_name, call, rel, label) => {
    const result = await call()
    const { cypher, params } = lookup()
    expect(cypher).toContain(`-[:${rel}]->(t:${label} {id: $taskId})`)
    // Why: the id must come from the argument the SDL declares, else the lookup gets undefined.
    expect(params).toEqual({ taskId: 'task-1', tenantId: 't1' })
    expect(result).not.toBeNull()
  })
})

describe('permission', () => {
  it('without approval.override every reopen is refused before touching the graph', async () => {
    const calls = [
      () => m.reopenAssessmentTask(null, { taskId: 'x', reason: 'r' }, operator),
      () => m.reopenDeployPlanTask(null, { taskId: 'x', reason: 'r' }, operator),
      () => m.reopenValidationTest(null, { id: 'x', reason: 'r' }, operator),
      () => m.reopenDeploymentTask(null, { id: 'x', reason: 'r' }, operator),
      () => m.reopenReviewTask(null, { id: 'x', reason: 'r' }, operator),
    ]
    for (const call of calls) {
      await expect(call()).rejects.toThrow(/reopen tasks/)
    }
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(txRun).not.toHaveBeenCalled()
  })
})
