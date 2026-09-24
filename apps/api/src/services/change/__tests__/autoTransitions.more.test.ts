/**
 * autoTransitions — the paths the main suite leaves out:
 *
 * - `revertProblemAfterChangeDetached`: when the change that was fixing a
 *   problem is unlinked or deleted, a problem that had advanced ONLY because of
 *   that change must go back to investigation. Otherwise it sits forever in
 *   "change in progress" with no change to finish it, and cannot be closed.
 *   A problem in any other step must be left alone.
 * - A cycle of automatic transitions (A → B → A) is a misconfigured workflow:
 *   it must fail loudly instead of writing an execution per hop.
 * - Linked problems: when the transition to "change in progress" is refused,
 *   the walker must NOT then jump the problem to "resolved" as if it had moved.
 *
 * Step names are resolved from the tenant's purposes/categories; here a fixed
 * factory-like table stands in for the tenant workflow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { evaluateCondition: vi.fn() },
}))
// The ITSM conditions register themselves on import; this suite fires only unconditioned arcs.
vi.mock('../../../workflow/conditions.js', () => ({}))
// Never a real driver: the module only needs toNumber.
vi.mock('@opengraphity/neo4j', () => ({ toNumber: (v: unknown) => Number(v), getSession: vi.fn() }))
vi.mock('../../../lib/db.js', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../../lib/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, key: string) => `text:${key}`) }))
// The pipeline of the transitions (wave 7 · B1): its guards and its notes are tested on their own.
const transition = vi.fn()
vi.mock('../../ticketTransition.js', () => ({ transitionTicket: (...a: unknown[]) => transition(...a) }))
const refused = { moved: false, refusal: { guard: 'required_fields', final: true, message: 'required field missing' } }
vi.mock('../../../lib/workflowHelpers.js', () => ({ getStepPurpose: vi.fn() }))
vi.mock('../../eventCorrelation.js', () => ({
  resolveChangeWindowSteps: vi.fn(async () => ({ implementation: ['deployment'], planned: ['scheduled'], all: ['deployment', 'scheduled'] })),
}))
vi.mock('../../../jobs/eventCorrelateWorker.js', () => ({ enqueueChangeWindowReevaluation: vi.fn() }))
vi.mock('../../serviceImpact/sync.js', () => ({ notifyChangeWindowChanged: vi.fn(async () => 0) }))

const BY_PURPOSE: Record<string, Record<string, string[]>> = {
  change:  { implementation: ['deployment'], review: ['review'] },
  problem: { change_requested: ['change_requested'], change_in_progress: ['change_in_progress'], investigation: ['under_investigation'] },
}
const BY_CATEGORY: Record<string, Record<string, string[]>> = {
  change:   { closed: ['closed'] },
  problem:  { resolved: ['resolved'] },
  incident: { active: ['in_progress'], escalated: ['escalated'], resolved: ['resolved'] },
}
const lookup = (table: typeof BY_PURPOSE, entity: string, keys: readonly string[]) => keys.flatMap((k) => table[entity]?.[k] ?? [])
vi.mock('../../../lib/workflowTargets.js', () => ({
  stepNamesByPurposeOrdered: vi.fn(async (_s: unknown, _t: string, e: string, p: string[]) => lookup(BY_PURPOSE, e, p)),
  stepNamesByCategory:       vi.fn(async (_s: unknown, _t: string, e: string, c: string[]) => lookup(BY_CATEGORY, e, c)),
  targetStepByPurpose:       vi.fn(async (_s: unknown, _t: string, e: string, p: string[]) => lookup(BY_PURPOSE, e, p)[0]),
  targetStepByCategory:      vi.fn(async (_s: unknown, _t: string, e: string, c: string[]) => lookup(BY_CATEGORY, e, c)[0]),
}))

const { evaluateAutoTransitions, revertProblemAfterChangeDetached } = await import('../autoTransitions.js')
const { runQuery, runQueryOne } = await import('../../../lib/db.js')
const { getStepPurpose } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator', permissions: perms('operator') }
const session = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([] as never)
  vi.mocked(runQueryOne).mockResolvedValue(null)
})

describe('revertProblemAfterChangeDetached', () => {
  it('a problem that is not ours (or has no workflow) is left alone', async () => {
    await revertProblemAfterChangeDetached(session, 'pb-1', ctx)
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ problemId: 'pb-1', tenantId: 'tenant-1' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toContain('MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})')
    expect(transition).not.toHaveBeenCalled()
  })

  it('a problem in a step that did not depend on the change is not moved', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'pw-1', step: 'known_error' } as never)
    vi.mocked(getStepPurpose).mockResolvedValue('known_error' as never)
    await revertProblemAfterChangeDetached(session, 'pb-1', ctx)
    expect(getStepPurpose).toHaveBeenCalledWith(session, 'tenant-1', 'problem', 'known_error')
    expect(transition).not.toHaveBeenCalled()
  })

  it.each(['change_requested', 'change_in_progress'])('a problem waiting on the change (%s) goes back to investigation', async (purpose) => {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'pw-1', step: purpose } as never)
    vi.mocked(getStepPurpose).mockResolvedValue(purpose as never)
    transition.mockResolvedValue({ moved: true })
    await revertProblemAfterChangeDetached(session, 'pb-1', ctx)
    expect(transition).toHaveBeenCalledWith(session, {
      tenantId: 'tenant-1', instanceId: 'pw-1', toStep: 'under_investigation', notes: 'text:change.resolvingDetached',
      actor: { kind: 'system', path: 'change_follow', userId: 'user-1' }, triggerType: 'automatic',
    })
  })

  it('a refused transition does not throw (the pipeline logs and notes it): unlinking the change still succeeds', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'pw-1', step: 'change_requested' } as never)
    vi.mocked(getStepPurpose).mockResolvedValue('change_requested' as never)
    transition.mockResolvedValue(refused)
    await expect(revertProblemAfterChangeDetached(session, 'pb-1', { ...ctx, userId: undefined as never })).resolves.toBeUndefined()
    // Without a user (a system caller) the transition is attributed to "system".
    expect(transition.mock.calls[0]![1]).toMatchObject({ actor: { userId: 'system' } })
  })
})

describe('evaluateAutoTransitions — cycle of automatic transitions', () => {
  it('re-entering a step already walked fails with CONFLICT instead of looping', async () => {
    let step = 'a'
    vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, q: string) =>
      (q.includes('properties(c) AS entityProps') ? { instanceId: 'wi-1', step, tenantId: 'tenant-1', entityProps: {} } : null) as never)
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, q: string) =>
      (q.includes("TRANSITIONS_TO {trigger: 'automatic'}") ? [{ toStep: step === 'a' ? 'b' : 'a', condition: null }] : []) as never)
    transition.mockImplementation(async (_s: unknown, p: { toStep: string }) => { step = p.toStep; return { moved: true } })

    const err = await evaluateAutoTransitions(session, 'chg-1', ctx).then(() => null, (e: unknown) => e as { message: string; extensions: Record<string, unknown> })
    expect(err?.message).toMatch(/cycle of automatic transitions b → a/)
    expect(err?.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.change.autoTransitionCycle', params: { from: 'b', to: 'a' } } })
    // Exactly one hop was written (a → b); the cycle is caught before the second.
    expect(transition).toHaveBeenCalledTimes(1)
  })
})

describe('evaluateAutoTransitions — linked problems when the problem transition fails', () => {
  it('a refused "change in progress" does not let the problem jump to resolved', async () => {
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, q: string) =>
      (q.includes('MATCH (p:Problem') ? [{ changeStep: 'closed', instanceId: 'pw-1', problemStep: 'change_requested' }] : []) as never)
    transition.mockResolvedValue(refused)

    await evaluateAutoTransitions(session, 'chg-1', ctx)

    expect(transition).toHaveBeenCalledTimes(1)
    expect(transition.mock.calls[0]![1]).toMatchObject({ instanceId: 'pw-1', toStep: 'change_in_progress', notes: 'text:change.changeInStep' })
  })

  it('when it succeeds, a closed change drives the problem through in-progress to resolved', async () => {
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, q: string) =>
      (q.includes('MATCH (p:Problem') ? [{ changeStep: 'closed', instanceId: 'pw-1', problemStep: 'change_requested' }] : []) as never)
    transition.mockResolvedValue({ moved: true })
    await evaluateAutoTransitions(session, 'chg-1', ctx)
    expect(transition.mock.calls.map((c) => (c[1] as { toStep: string }).toStep)).toEqual(['change_in_progress', 'resolved'])
  })
})
