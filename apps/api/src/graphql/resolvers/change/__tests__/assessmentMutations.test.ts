/**
 * Assessment task mutations: answering questions, completing the task (which
 * produces the CI risk score that drives the change's priority and approval
 * route), and assigning the task to a team or a person.
 *
 * Why these contracts matter to a user:
 * - a completed assessment must be frozen, otherwise the risk score the CAB
 *   approved could be rewritten after the fact;
 * - completion must refuse while questions are unanswered, or a half-filled
 *   assessment would produce a falsely low risk;
 * - the CI type chosen for the questions must be the customer's one when both
 *   exist, and an ambiguity must be reported, not resolved at random;
 * - every read is scoped to the caller's tenant and every write is gated by
 *   the CI team check, so nobody can answer another team's (or tenant's) task;
 * - a failed auto-transition after the commit must not make the mutation fail,
 *   because the completion is already saved and the user would retry it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

type Row = Record<string, unknown> | null
const write = vi.fn<(q: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>>()
const runQueryOne = vi.fn<(s: unknown, q: string, p: Record<string, unknown>) => Promise<Row>>()
const runQuery = vi.fn<(s: unknown, q: string, p: Record<string, unknown>) => Promise<unknown[]>>()
const writeAudit = vi.fn()
const getCIName = vi.fn(async () => 'db-01')
const getQuestionText = vi.fn(async () => 'Is there downtime?')
const getAnswerLabel = vi.fn(async () => 'Yes')
const getCurrentStep = vi.fn(async () => 'assessment')
const assertUserInCITeam = vi.fn()
const recomputeCIRiskIfReady = vi.fn()
const computeAggregateRisk = vi.fn()
const assertAssignablePerson = vi.fn()
const evaluateAutoTransitions = vi.fn()
const environmentRiskScore = vi.fn(async () => 0)
const changeEnvironmentWeight = vi.fn(async () => ({ weight: 0, isDefault: false }))
const logError = vi.fn()

vi.mock('../../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run: write }),
    executeRead:  (w: (tx: unknown) => unknown) => w({ run: write }),
  }),
  runQuery:    (...a: [unknown, string, Record<string, unknown>]) => runQuery(...a),
  runQueryOne: (...a: [unknown, string, Record<string, unknown>]) => runQueryOne(...a),
}))
vi.mock('../../../../services/change/helpers.js', () => ({
  writeAudit:             (...a: unknown[]) => writeAudit(...a),
  getCIName:              () => getCIName(),
  getQuestionText:        () => getQuestionText(),
  getAnswerLabel:         () => getAnswerLabel(),
  getCurrentStep:         () => getCurrentStep(),
  assertUserInCITeam:     (...a: unknown[]) => assertUserInCITeam(...a),
  recomputeCIRiskIfReady: (...a: unknown[]) => recomputeCIRiskIfReady(...a),
  computeAggregateRisk:   (...a: unknown[]) => computeAggregateRisk(...a),
  afterEnterStep:         vi.fn(),
}))
vi.mock('../../../../services/change/autoTransitions.js', () => ({
  evaluateAutoTransitions: (...a: unknown[]) => evaluateAutoTransitions(...a),
}))
vi.mock('../../../../lib/environmentRisk.js', () => ({
  environmentRiskScore: () => environmentRiskScore(),
}))
vi.mock('../../../../lib/changeEnvironmentWeight.js', () => ({
  changeEnvironmentWeight: () => changeEnvironmentWeight(),
}))
vi.mock('../../../../services/ticketAssignment.js', () => ({
  assertAssignablePerson: (...a: unknown[]) => assertAssignablePerson(...a),
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => logError(...a), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const {
  submitAssessmentResponse, completeAssessmentTask,
  assignAssessmentTaskToTeam, assignAssessmentTaskToUser, assignDeployPlanTaskToUser,
} = await import('../assessmentMutations.js')

const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'a@b.c', role: 'admin', permissions: perms('admin') } as never

const TASK_PROPS = { id: 'task-1', tenant_id: 'c-test', status: 'pending', responder_role: 'owner', ci_id: 'ci-1', created_at: '2026-09-01' }

/** Route runQueryOne by the query it receives, the way the real graph would. */
function routeOne(routes: Array<[RegExp, Row]>) {
  runQueryOne.mockImplementation(async (_s, q) => {
    for (const [re, row] of routes) if (re.test(q)) return row
    throw new Error(`unexpected runQueryOne: ${q.slice(0, 80)}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  write.mockResolvedValue({ records: [] })
  runQuery.mockResolvedValue([])
  environmentRiskScore.mockResolvedValue(0)
  changeEnvironmentWeight.mockResolvedValue({ weight: 0, isDefault: false })
})

// ── submitAssessmentResponse ─────────────────────────────────────────────────

describe('submitAssessmentResponse', () => {
  it('records the answer scoped to the tenant, moves the task in progress and audits it', async () => {
    routeOne([
      [/HAS_ASSESSMENT/, { props: TASK_PROPS, changeId: 'chg-1' }],
      [/RETURN properties\(t\) AS props/, { props: { ...TASK_PROPS, status: 'in-progress' } }],
    ])
    const out = await submitAssessmentResponse(null, { taskId: 'task-1', questionId: 'q1', optionId: 'o1' }, ctx)
    expect(out).toMatchObject({ id: 'task-1', status: 'in-progress' })

    // The lookup must be tenant-scoped and skip soft-deleted changes.
    const [, lookup, lookupParams] = runQueryOne.mock.calls[0]!
    expect(lookup).toContain('Change {tenant_id: $tenantId}')
    expect(lookup).toContain('coalesce(c.deleted, false) = false')
    expect(lookupParams).toMatchObject({ tenantId: 'c-test', taskId: 'task-1' })

    // The option must belong to the question in the same tenant, or a caller
    // could inject the score of an unrelated question.
    const [cypher, params] = write.mock.calls[0]!
    expect(cypher).toContain('AssessmentQuestion {id: $questionId, tenant_id: $tenantId})-[:HAS_OPTION]->(opt:AnswerOption {id: $optionId})')
    expect(cypher).toContain("SET t.status = 'in-progress'")
    expect(params).toMatchObject({ tenantId: 'c-test', questionId: 'q1', optionId: 'o1', userId: 'u1' })

    expect(assertUserInCITeam).toHaveBeenCalledWith(expect.anything(), 'ci-1', 'c-test', ctx, 'owner')
    expect(writeAudit.mock.calls[0]![3]).toBe('assessment_response_submitted')
    expect(writeAudit.mock.calls[0]![5]).toBe('Functional · db-01: "Is there downtime?" → Yes')
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ key: 'responseSubmitted', params: { role: 'owner', answer: 'Yes' } })
  })

  it('a support task is checked against the support team', async () => {
    routeOne([
      [/HAS_ASSESSMENT/, { props: { ...TASK_PROPS, responder_role: 'support' }, changeId: 'chg-1' }],
      [/RETURN properties\(t\) AS props/, null],
    ])
    // No task left after the write: the mutation answers null rather than inventing one.
    await expect(submitAssessmentResponse(null, { taskId: 'task-1', questionId: 'q1', optionId: 'o1' }, ctx)).resolves.toBeNull()
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
    expect(writeAudit.mock.calls[0]![5]).toMatch(/^Technical · /)
  })

  it('an unknown (or other-tenant) task is not found and nothing is written', async () => {
    routeOne([[/HAS_ASSESSMENT/, null]])
    await expect(submitAssessmentResponse(null, { taskId: 'nope', questionId: 'q1', optionId: 'o1' }, ctx))
      .rejects.toThrow(/nope/)
    expect(write).not.toHaveBeenCalled()
  })

  it('a completed task is frozen: its answers can no longer change', async () => {
    routeOne([[/HAS_ASSESSMENT/, { props: { ...TASK_PROPS, status: 'completed' }, changeId: 'chg-1' }]])
    await expect(submitAssessmentResponse(null, { taskId: 'task-1', questionId: 'q1', optionId: 'o1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'CONFLICT', i18n: { key: 'errors.assessment.answersLocked' } } })
    expect(write).not.toHaveBeenCalled()
  })

  it('a user outside the CI team cannot answer', async () => {
    routeOne([[/HAS_ASSESSMENT/, { props: TASK_PROPS, changeId: 'chg-1' }]])
    assertUserInCITeam.mockRejectedValueOnce(new Error('forbidden'))
    await expect(submitAssessmentResponse(null, { taskId: 'task-1', questionId: 'q1', optionId: 'o1' }, ctx)).rejects.toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
  })
})

// ── completeAssessmentTask ───────────────────────────────────────────────────

type CiType = { id: string | null; scope: string; label: string }
function completeContext(over: { taskProps?: Record<string, unknown>; ciTypes?: CiType[] | null; ciEnv?: string | null } = {}) {
  return {
    taskProps: { ...TASK_PROPS, ...(over.taskProps ?? {}) },
    changeId: 'chg-1', ciId: 'ci-1', ciLabel: 'Server',
    ciTypes: over.ciTypes === undefined ? [{ id: 'type-base', scope: 'base', label: 'Server' }] : over.ciTypes,
    ciEnv: over.ciEnv ?? 'production',
  }
}

function setupComplete(opts: {
  ctx1?: Row
  questions?: Array<{ questionId: string; weight: unknown; maxScore: unknown }>
  responses?: Array<{ questionId: string; score: unknown }>
  after?: Row
} = {}) {
  routeOne([
    [/HAS_ASSESSMENT/, opts.ctx1 === undefined ? completeContext() : opts.ctx1],
    [/RETURN properties\(t\) AS props/, opts.after === undefined ? { props: { ...TASK_PROPS, status: 'completed', score: 50 } } : opts.after],
  ])
  runQuery.mockImplementation(async (_s, q) => {
    if (q.includes('HAS_QUESTION')) return opts.questions ?? [
      { questionId: 'q1', weight: 2, maxScore: 10 },
      { questionId: 'q2', weight: null, maxScore: 10 },
    ]
    if (q.includes('HAS_RESPONSE')) return opts.responses ?? [
      { questionId: 'q1', score: 5 },
      { questionId: 'q2', score: 5 },
    ]
    throw new Error(`unexpected runQuery: ${q.slice(0, 80)}`)
  })
}

describe('completeAssessmentTask', () => {
  it('scores the weighted answers, completes the task and recomputes the risk in one transaction', async () => {
    setupComplete()
    const out = await completeAssessmentTask(null, { taskId: 'task-1' }, ctx)
    expect(out).toMatchObject({ id: 'task-1', status: 'completed', score: 50 })

    // (2*5 + 1*5) / (2*10 + 1*10) = 50%: a null weight counts as 1, not 0.
    const [cypher, params] = write.mock.calls[0]!
    expect(cypher).toContain("SET t.status = 'completed'")
    expect(params).toMatchObject({ score: 50, tenantId: 'c-test', userId: 'u1' })

    // The questions are the owner (functional) ones of the resolved CI type, in this tenant.
    const qCall = runQuery.mock.calls.find((c) => c[1].includes('HAS_QUESTION'))!
    expect(qCall[2]).toEqual({ ciTypeId: 'type-base', tenantId: 'c-test', category: 'functional' })

    expect(writeAudit.mock.calls[0]![5]).toBe('Functional · db-01: score 50')
    expect(recomputeCIRiskIfReady).toHaveBeenCalledWith(expect.anything(), 'chg-1', 'ci-1', 'c-test', 'u1')
    expect(computeAggregateRisk).toHaveBeenCalledWith(expect.anything(), 'chg-1', 'c-test')
    expect(evaluateAutoTransitions).toHaveBeenCalledTimes(1)
  })

  it('the environment factor enters the score', async () => {
    setupComplete({ questions: [{ questionId: 'q1', weight: 1, maxScore: 10 }], responses: [{ questionId: 'q1', score: 10 }] })
    environmentRiskScore.mockResolvedValueOnce(0)
    changeEnvironmentWeight.mockResolvedValueOnce({ weight: 10, isDefault: false })
    await completeAssessmentTask(null, { taskId: 'task-1' }, ctx)
    // A full-score answer diluted by a zero-risk environment weighing 10:
    // the score must be strictly below 100.
    expect(write.mock.calls[0]![1]!['score']).toBeLessThan(100)
  })

  it('the customer CI type wins over a base type with the same label', async () => {
    setupComplete({ ctx1: completeContext({ ciTypes: [
      { id: 'type-base', scope: 'base', label: 'Server' },
      { id: 'type-tenant', scope: 'tenant', label: 'Server' },
    ] }) })
    await completeAssessmentTask(null, { taskId: 'task-1' }, ctx)
    const qCall = runQuery.mock.calls.find((c) => c[1].includes('HAS_QUESTION'))!
    expect(qCall[2]['ciTypeId']).toBe('type-tenant')
  })

  it('two definitions of the same level are an ambiguity reported to the user, not a random pick', async () => {
    setupComplete({ ctx1: completeContext({ ciTypes: [
      { id: 't1', scope: 'base', label: 'Server' },
      { id: 't2', scope: 'base', label: 'Host' },
    ] }) })
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('matches 2 CI type definitions (Server [t1], Host [t2])'),
      extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.ci.ambiguousType', params: { ci: 'ci-1', types: 'Server, Host' } } },
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('no CI type (null list or a null OPTIONAL MATCH row) means no questions: refused, not scored 0', async () => {
    // collect() over a missing OPTIONAL MATCH yields one map with null id.
    setupComplete({ ctx1: completeContext({ ciTypes: [{ id: null, scope: '', label: '' }] }), questions: [] })
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.assessment.noQuestionForCategory' } } })
    expect(runQuery.mock.calls[0]![2]['ciTypeId']).toBeNull()

    setupComplete({ ctx1: completeContext({ ciTypes: null }), questions: [] })
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'CONFLICT' } })
    expect(write).not.toHaveBeenCalled()
  })

  it('a support task looks up the technical questions', async () => {
    setupComplete({ ctx1: completeContext({ taskProps: { responder_role: 'support' } }) })
    await completeAssessmentTask(null, { taskId: 'task-1' }, ctx)
    expect(runQuery.mock.calls.find((c) => c[1].includes('HAS_QUESTION'))![2]['category']).toBe('technical')
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
    expect(writeAudit.mock.calls[0]![5]).toMatch(/^Technical · /)
  })

  it('refuses while questions are unanswered, saying how many', async () => {
    setupComplete({ responses: [{ questionId: 'q1', score: 5 }] })
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT', i18n: { key: 'errors.assessment.missingAnswers', params: { count: 1 } } },
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('an unknown task is not found; a completed one cannot be completed twice', async () => {
    setupComplete({ ctx1: null })
    await expect(completeAssessmentTask(null, { taskId: 'nope' }, ctx)).rejects.toThrow(/nope/)

    setupComplete({ ctx1: completeContext({ taskProps: { status: 'completed' } }) })
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.task.alreadyCompleted' } } })
    expect(write).not.toHaveBeenCalled()
  })

  it('a user outside the CI team cannot complete', async () => {
    setupComplete()
    assertUserInCITeam.mockRejectedValueOnce(new Error('forbidden'))
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx)).rejects.toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
  })

  it('a failed auto-transition after the commit is logged, and the mutation still returns the completed task', async () => {
    setupComplete()
    evaluateAutoTransitions.mockRejectedValueOnce(new Error('workflow down'))
    const out = await completeAssessmentTask(null, { taskId: 'task-1' }, ctx)
    expect(out).toMatchObject({ status: 'completed' })
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ changeId: 'chg-1', step: 'assessment' }), expect.any(String))
  })

  it('even when the current step cannot be read while logging the failure', async () => {
    setupComplete({ after: null })
    evaluateAutoTransitions.mockRejectedValueOnce(new Error('workflow down'))
    getCurrentStep.mockRejectedValueOnce(new Error('db gone'))
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx)).resolves.toBeNull()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ step: null }), expect.any(String))
  })

  it('a failure inside the transaction propagates: the task must not look completed', async () => {
    setupComplete()
    computeAggregateRisk.mockRejectedValueOnce(new Error('risk failed'))
    await expect(completeAssessmentTask(null, { taskId: 'task-1' }, ctx)).rejects.toThrow('risk failed')
    expect(evaluateAutoTransitions).not.toHaveBeenCalled()
  })
})

// ── assignAssessmentTaskToTeam ───────────────────────────────────────────────

describe('assignAssessmentTaskToTeam', () => {
  it('reassigns the team within the tenant, drops a person who is not in the new team, audits it', async () => {
    routeOne([
      [/HAS_ASSESSMENT/, { changeId: 'chg-1', ciId: 'ci-1', role: 'support', taskProps: TASK_PROPS }],
      [/RETURN properties\(t\) AS props/, { props: TASK_PROPS }],
    ])
    const out = await assignAssessmentTaskToTeam(null, { taskId: 'task-1', teamId: 'tm-2' }, ctx)
    expect(out).toMatchObject({ id: 'task-1' })

    const [cypher, params] = write.mock.calls[0]!
    expect(cypher).toContain('MATCH (tm:Team {id: $teamId, tenant_id: $tenantId})')
    expect(cypher).toContain('DELETE userRel')
    expect(params).toMatchObject({ taskId: 'task-1', teamId: 'tm-2', tenantId: 'c-test' })
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
    expect(writeAudit.mock.calls[0]![5]).toBe('Technical · db-01: team reassigned')
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ key: 'teamReassigned', params: { role: 'Technical' } })
  })

  it('returns null when the task vanished after the write', async () => {
    routeOne([
      [/HAS_ASSESSMENT/, { changeId: 'chg-1', ciId: 'ci-1', role: 'owner', taskProps: TASK_PROPS }],
      [/RETURN properties\(t\) AS props/, null],
    ])
    await expect(assignAssessmentTaskToTeam(null, { taskId: 'task-1', teamId: 'tm-2' }, ctx)).resolves.toBeNull()
  })

  it('an unknown task is not found; the CI team check gates the write', async () => {
    routeOne([[/HAS_ASSESSMENT/, null]])
    await expect(assignAssessmentTaskToTeam(null, { taskId: 'nope', teamId: 'tm-2' }, ctx)).rejects.toThrow(/nope/)

    routeOne([[/HAS_ASSESSMENT/, { changeId: 'chg-1', ciId: 'ci-1', role: 'owner', taskProps: TASK_PROPS }]])
    assertUserInCITeam.mockRejectedValueOnce(new Error('forbidden'))
    await expect(assignAssessmentTaskToTeam(null, { taskId: 'task-1', teamId: 'tm-2' }, ctx)).rejects.toThrow('forbidden')
    expect(write).not.toHaveBeenCalled()
  })
})

// ── assignAssessmentTaskToUser / assignDeployPlanTaskToUser ──────────────────

describe('assignAssessmentTaskToUser', () => {
  function routes(isMember: Row, userRow: Row = { name: 'Anna Rossi' }, after: Row = { props: TASK_PROPS }) {
    routeOne([
      [/HAS_ASSESSMENT/, { changeId: 'chg-1', ciId: 'ci-1', role: 'owner', taskProps: TASK_PROPS }],
      [/isMember/, isMember],
      [/u\.name AS name/, userRow],
      [/RETURN properties\(t\) AS props/, after],
    ])
  }

  it('assigns a member of the task team, replacing the previous assignee, and audits the name', async () => {
    routes({ isMember: true })
    const out = await assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: 'u2' }, ctx)
    expect(out).toMatchObject({ id: 'task-1' })
    const [cypher, params] = write.mock.calls[0]!
    expect(cypher).toContain('DELETE old')
    expect(cypher).toContain('CREATE (t)-[:ASSIGNED_TO]->(u)')
    expect(params).toMatchObject({ userId: 'u2', tenantId: 'c-test' })
    expect(assertAssignablePerson).toHaveBeenCalledWith(expect.anything(), 'u2', 'c-test')
    expect(writeAudit.mock.calls[0]![5]).toBe('Functional · db-01: assigned to Anna Rossi')
  })

  it('falls back to the user id in the audit when the name cannot be read, and null when the task vanished', async () => {
    routes({ isMember: true }, null, null)
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: 'u2' }, ctx)).resolves.toBeNull()
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ params: { user: 'u2' } })
  })

  it('refuses a person who is not in the task team (or when the task has no team)', async () => {
    routes({ isMember: false })
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: 'u9' }, ctx))
      .rejects.toThrow('The user does not belong to the assigned team')
    routes(null)
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: 'u9' }, ctx))
      .rejects.toThrow('The user does not belong to the assigned team')
    expect(write).not.toHaveBeenCalled()
  })

  it('refuses a person who cannot be assigned (e.g. deactivated), before writing', async () => {
    routes({ isMember: true })
    assertAssignablePerson.mockRejectedValueOnce(new Error('inactive'))
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: 'u2' }, ctx)).rejects.toThrow('inactive')
    expect(write).not.toHaveBeenCalled()
  })

  it('a support task unassigned: the audit carries the technical role; null when the task vanished', async () => {
    routeOne([
      [/HAS_ASSESSMENT/, { changeId: 'chg-1', ciId: 'ci-1', role: 'support', taskProps: TASK_PROPS }],
      [/RETURN properties\(t\) AS props/, null],
    ])
    await expect(assignAssessmentTaskToUser(null, { taskId: 'task-1', userId: null }, ctx)).resolves.toBeNull()
    expect(writeAudit.mock.calls[0]![5]).toBe('Technical · db-01: assignment removed')
  })

  it('an unknown task is not found', async () => {
    routeOne([[/HAS_ASSESSMENT/, null]])
    await expect(assignAssessmentTaskToUser(null, { taskId: 'nope', userId: 'u2' }, ctx)).rejects.toThrow(/nope/)
  })
})

describe('assignDeployPlanTaskToUser', () => {
  const PLAN_PROPS = { id: 'plan-1', status: 'planning', steps: '[]', created_at: '2026-09-01' }
  function routes(isMember: Row, userRow: Row = { name: 'Anna Rossi' }, after: Row = { props: PLAN_PROPS }) {
    routeOne([
      [/HAS_DEPLOY_PLAN/, { changeId: 'chg-1', ciId: 'ci-1' }],
      [/isMember/, isMember],
      [/u\.name AS name/, userRow],
      [/RETURN properties\(t\) AS props/, after],
    ])
  }

  it('assigns a member of the plan team; the check is always against the support team', async () => {
    routes({ isMember: true })
    const out = await assignDeployPlanTaskToUser(null, { taskId: 'plan-1', userId: 'u2' }, ctx)
    expect(out).toMatchObject({ id: 'plan-1', steps: [] })
    expect(runQueryOne.mock.calls[0]![1]).toContain('Change {tenant_id: $tenantId}')
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
    expect(write.mock.calls[0]![0]).toContain('MATCH (t:DeployPlanTask {id: $taskId, tenant_id: $tenantId})')
    expect(writeAudit.mock.calls[0]![3]).toBe('deploy_plan_user_assigned')
    expect(writeAudit.mock.calls[0]![5]).toBe('Planning · db-01: assigned to Anna Rossi')
  })

  it('falls back to the user id and returns null when the plan vanished', async () => {
    routes({ isMember: true }, null, null)
    await expect(assignDeployPlanTaskToUser(null, { taskId: 'plan-1', userId: 'u2' }, ctx)).resolves.toBeNull()
    expect(writeAudit.mock.calls[0]![6]).toMatchObject({ key: 'planUserAssigned', params: { user: 'u2' } })
  })

  it('refuses a non-member, and an unassignable person, before writing', async () => {
    routes({ isMember: false })
    await expect(assignDeployPlanTaskToUser(null, { taskId: 'plan-1', userId: 'u9' }, ctx)).rejects.toThrow(/assigned team/)
    routes(null)
    await expect(assignDeployPlanTaskToUser(null, { taskId: 'plan-1', userId: 'u9' }, ctx)).rejects.toThrow(/assigned team/)
    routes({ isMember: true })
    assertAssignablePerson.mockRejectedValueOnce(new Error('inactive'))
    await expect(assignDeployPlanTaskToUser(null, { taskId: 'plan-1', userId: 'u2' }, ctx)).rejects.toThrow('inactive')
    expect(write).not.toHaveBeenCalled()
  })

  it('an unknown plan is not found', async () => {
    routeOne([[/HAS_DEPLOY_PLAN/, null]])
    await expect(assignDeployPlanTaskToUser(null, { taskId: 'nope', userId: 'u2' }, ctx)).rejects.toThrow(/nope/)
    expect(assertUserInCITeam).not.toHaveBeenCalled()
  })
})
