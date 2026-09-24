/**
 * Change approval gate (approvalGate.ts): who may decide, and what must never
 * be left half-done.
 *
 * Why these behaviours matter:
 *  - Only a member of the requirement's team, or someone holding
 *    `approval.override`, may approve or reject. A regression here lets any
 *    operator approve a change on behalf of the CAB.
 *  - A change outside its approval step, deleted, or without a change type is
 *    refused with a precise error instead of being approved or guessed at.
 *  - "Approvals complete but the transition failed" must be an error: the user
 *    would otherwise see "approved" with the change stuck in approval forever.
 *  - A rejection requires a reason and an explicit choice of what to reopen.
 *  - The approvals panel shows `canApprove` / `onBehalf` correctly, so an admin
 *    is warned when approving for a team they are not part of.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const txRun = vi.fn(async () => ({ records: [] }))
const session = {
  executeWrite: vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun })),
}
const withSessionWrite: boolean[] = []
vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>, write?: boolean) => { withSessionWrite.push(write === true); return fn(session) }),
  runQuery: vi.fn(),
  runQueryOne: vi.fn(),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { getAvailableTransitions: vi.fn() } }))
// The pipeline of the transitions (wave 7 · B1): the outcome of the approvals moves the change through it.
const transition = vi.hoisted(() => vi.fn())
vi.mock('../../../../services/ticketTransition.js', () => ({ transitionTicket: transition }))
const refused = (message: string, i18n?: { key: string }) => ({ moved: false, refusal: { guard: 'workflow', final: true, code: 'CONFLICT', message, ...(i18n ? { i18n } : {}) } })
vi.mock('../queries.js', () => ({ change: vi.fn(async (_p: unknown, a: { id: string }) => ({ id: a.id })) }))
vi.mock('../../../../services/change/autoTransitions.js', () => ({ evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../services/change/helpers.js', () => ({
  afterEnterStep: vi.fn().mockResolvedValue(undefined),
  getInstanceId: vi.fn().mockResolvedValue('wi-1'),
  writeAudit: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../services/change/approvalCreation.js', () => ({ areAllApprovalsSatisfied: vi.fn() }))
vi.mock('../../../../lib/workflowTargets.js', () => ({
  targetStepByPurpose: vi.fn(async (_s: unknown, _t: string, _e: string, purposes: string[]) => (purposes[0] === 'scheduled' ? 'in_calendar' : 'evaluation')),
}))
vi.mock('../../../../services/change/scoring.js', () => ({ deriveChangePriority: vi.fn(async () => 'medium') }))
vi.mock('../../../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, key: string) => `text:${key}`) }))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { runQuery, runQueryOne } = await import('../../ci-utils.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { afterEnterStep, writeAudit } = await import('../../../../services/change/helpers.js')
const { areAllApprovalsSatisfied } = await import('../../../../services/change/approvalCreation.js')
const { evaluateAutoTransitions } = await import('../../../../services/change/autoTransitions.js')
const { deriveChangePriority } = await import('../../../../services/change/scoring.js')
const { approveChangeApproval, rejectChangeApproval, changeApprovals } = await import('../approvalGate.js')

const admin = { tenantId: 't1', userId: 'u-admin', userEmail: 'a@x', role: 'admin', permissions: perms('admin') } as never
const operator = { tenantId: 't1', userId: 'u-op', userEmail: 'o@x', role: 'operator', permissions: perms('operator') } as never

interface Gate { step?: Record<string, unknown> | null; member?: boolean; requirement?: Record<string, unknown> | null }
function gate(g: Gate = {}) {
  const step = g.step === undefined ? { step: 'cab', purpose: 'approval', changeType: 'normal', teamName: 'CAB' } : g.step
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('CURRENT_STEP')) return step
    if (cypher.includes(':MEMBER_OF]')) return { ok: g.member ?? false }
    if (cypher.includes("status: 'pending'")) return g.requirement === undefined ? { id: 'appr-1' } : g.requirement
    return { id: 'x' }
  }) as never)
}

async function caught(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p } catch (e) { return e as GraphQLError }
  throw new Error('expected an error')
}

beforeEach(() => {
  vi.clearAllMocks()
  withSessionWrite.length = 0
  vi.mocked(areAllApprovalsSatisfied).mockResolvedValue(false)
  transition.mockResolvedValue({ moved: true, actionErrors: [] })
  vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_calendar' }] as never)
})

describe('approveChangeApproval — eligibility and state', () => {
  it('a team member (no override) may approve; the check is scoped to user, team and tenant', async () => {
    gate({ member: true })
    await expect(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: '  looks good ' }, operator)).resolves.toEqual({ id: 'chg-1' })
    const membership = vi.mocked(runQueryOne).mock.calls.find(([, c]) => String(c).includes(':MEMBER_OF]'))!
    expect(membership[2]).toEqual({ userId: 'u-op', tenantId: 't1', teamId: 'team-cab' })
    // The note is trimmed into the audit line, after the team name.
    expect(writeAudit).toHaveBeenCalledWith(session, 'chg-1', 't1', 'change_approved', 'u-op', 'CAB: looks good')
    // The mutation runs on a WRITE session.
    expect(withSessionWrite).toEqual([true])
  })

  it('a non-member without override is FORBIDDEN and nothing is written', async () => {
    gate({ member: false })
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, operator))
    expect(err.extensions['code']).toBe('FORBIDDEN')
    expect(vi.mocked(runQueryOne).mock.calls.some(([, c]) => String(c).includes("a.status = 'approved'"))).toBe(false)
  })

  it('an admin with approval.override skips the membership query', async () => {
    gate()
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin)
    expect(vi.mocked(runQueryOne).mock.calls.some(([, c]) => String(c).includes(':MEMBER_OF]'))).toBe(false)
    // Without a note the audit line is just the team name.
    expect(writeAudit).toHaveBeenCalledWith(session, 'chg-1', 't1', 'change_approved', 'u-admin', 'CAB')
  })

  it('an unknown or deleted change is NOT_FOUND', async () => {
    gate({ step: null })
    expect((await caught(approveChangeApproval(null, { changeId: 'chg-x', teamId: 't' }, admin))).extensions['code']).toBe('NOT_FOUND')
  })

  it('a step without a declared purpose is refused with its own i18n key', async () => {
    gate({ step: { step: 'draft', purpose: null, changeType: 'normal', teamName: null } })
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 't' }, admin))
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.message).toContain('purpose not declared')
    expect(err.extensions['i18n']).toMatchObject({ key: 'errors.approval.notInApprovalNoPurpose', params: { step: 'draft', purpose: '' } })
  })

  it('a change without a change type is a CONFLICT, never evaluated as "normal"', async () => {
    for (const changeType of [null, '   ']) {
      gate({ step: { step: 'cab', purpose: 'approval', changeType, teamName: 'CAB' } })
      const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 't' }, admin))
      expect(err.extensions['code']).toBe('CONFLICT')
      expect(err.extensions['i18n']).toMatchObject({ key: 'errors.change.noChangeType' })
    }
  })

  it('a requirement already resolved (or missing) is NOT_FOUND and not audited', async () => {
    gate({ requirement: null })
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin))
    expect(err.extensions).toMatchObject({ code: 'NOT_FOUND', i18n: { key: 'errors.approval.requirementGone' } })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('with requirements still pending the change does not move', async () => {
    gate()
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin)
    expect(transition).not.toHaveBeenCalled()
  })
})

describe('approveChangeApproval — the last approval advances the change', () => {
  it('writes the outcome, moves to the scheduled-purpose step and runs the follow-ups', async () => {
    gate()
    vi.mocked(areAllApprovalsSatisfied).mockResolvedValue(true)
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin)
    expect(transition).toHaveBeenCalledWith(session, {
      tenantId: 't1', instanceId: 'wi-1', toStep: 'in_calendar', notes: 'text:change.approvalsComplete',
      actor: { kind: 'system', path: 'approval', userId: 'u-admin' }, triggerType: 'manual',
    })
    expect(afterEnterStep).toHaveBeenCalledWith(session, 'chg-1', 't1', 'in_calendar')
    expect(evaluateAutoTransitions).toHaveBeenCalled()
  })

  it('a failed transition after the last approval is a CONFLICT naming the step and the reason', async () => {
    gate()
    vi.mocked(areAllApprovalsSatisfied).mockResolvedValue(true)
    transition.mockResolvedValue(refused('guard failed'))
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin))
    expect(err.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.approval.didNotAdvance', params: { step: 'in_calendar', reason: 'guard failed' } } })
    expect(afterEnterStep).not.toHaveBeenCalled()
  })

  it('a guard of the scheduled step (its required fields) holds the change in approval, and says so', async () => {
    gate()
    vi.mocked(areAllApprovalsSatisfied).mockResolvedValue(true)
    transition.mockResolvedValue({ moved: false, refusal: { guard: 'required_fields', final: true, code: 'BAD_USER_INPUT', message: 'Field "window" is required' } })
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, admin))
    expect(err.message).toBe('Approvals complete but the change did not move to "in_calendar": Field "window" is required')
    expect(afterEnterStep).not.toHaveBeenCalled()
  })
})

describe('rejectChangeApproval', () => {
  it('requires a non-blank reason', async () => {
    const err = await caught(rejectChangeApproval(null, { changeId: 'chg-1', teamId: 't', note: '   ', reopenAll: true }, admin))
    expect(err.extensions).toMatchObject({ code: 'BAD_USER_INPUT', i18n: { key: 'errors.approval.rejectNeedsNote' } })
  })

  it('requires choosing what to reopen (all, or at least one task)', async () => {
    const err = await caught(rejectChangeApproval(null, { changeId: 'chg-1', teamId: 't', note: 'no rollback' }, admin))
    expect(err.extensions).toMatchObject({ code: 'BAD_USER_INPUT', i18n: { key: 'errors.change.chooseAssessmentsToReopen' } })
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('a non-member cannot reject either', async () => {
    gate({ member: false })
    const err = await caught(rejectChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: 'x', reopenTaskIds: ['a1'] }, operator))
    expect(err.extensions['code']).toBe('FORBIDDEN')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('reopens only the chosen tasks, resets priority from the type, returns to assessment and audits the reason', async () => {
    gate({ member: true })
    await rejectChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: '  no rollback ', reopenTaskIds: ['a1', 'a2'] }, operator)
    // Priority is re-derived from the change type with the risk cleared.
    expect(deriveChangePriority).toHaveBeenCalledWith('t1', 'normal', null)
    const params = (txRun.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(params).toMatchObject({ changeId: 'chg-1', tenantId: 't1', all: false, ids: ['a1', 'a2'], priority: 'medium' })
    expect(transition).toHaveBeenCalledWith(session, expect.objectContaining({
      toStep: 'evaluation', notes: 'text:change.approvalRejected', actor: { kind: 'system', path: 'approval', userId: 'u-op' },
    }))
    expect(writeAudit).toHaveBeenCalledWith(session, 'chg-1', 't1', 'change_rejected', 'u-op', 'CAB: no rollback')
    expect(afterEnterStep).toHaveBeenCalledWith(session, 'chg-1', 't1', 'evaluation')
  })

  it('a refused return transition is a CONFLICT carrying the engine i18n, and nothing is audited', async () => {
    gate()
    transition.mockResolvedValue(refused('locked', { key: 'errors.workflow.locked' }))
    const err = await caught(rejectChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: 'x', reopenAll: true }, admin))
    expect(err.message).toBe('locked')
    expect(err.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.workflow.locked' } })
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('a refusal without a translation key falls back to the generic rejection key', async () => {
    gate()
    transition.mockResolvedValue(refused('The workflow refused the transition'))
    const err = await caught(rejectChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: 'x', reopenAll: true }, admin))
    expect(err.message).toBe('The workflow refused the transition')
    expect(err.extensions['i18n']).toEqual({ key: 'errors.approval.rejectFailed' })
  })
})

describe('changeApprovals (field resolver)', () => {
  const rows = [
    { kind: 'change_manager', teamId: 'cm', teamName: 'CM', status: 'pending', approvedByName: null, approvedAt: null, isMember: false },
    { kind: 'owner_group', teamId: 'dba', teamName: 'DBA', status: 'pending', approvedByName: null, approvedAt: null, isMember: true },
    { kind: 'owner_group', teamId: 'net', teamName: 'NET', status: 'approved', approvedByName: 'Anna', approvedAt: '2026-09-01', isMember: true },
  ]

  it('an operator can approve only where they are a member, and never on behalf', async () => {
    vi.mocked(runQuery).mockResolvedValue(rows as never)
    const r = await changeApprovals({ id: 'chg-1' }, null, operator)
    expect(r.map((x) => [x.teamId, x.canApprove, x.onBehalf])).toEqual([['cm', false, false], ['dba', true, false], ['net', false, false]])
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ changeId: 'chg-1', tenantId: 't1', userId: 'u-op' })
  })

  it('an admin can approve any pending requirement, flagged on-behalf where not a member', async () => {
    vi.mocked(runQuery).mockResolvedValue(rows as never)
    const r = await changeApprovals({ id: 'chg-1' }, null, admin)
    expect(r.map((x) => [x.teamId, x.canApprove, x.onBehalf])).toEqual([['cm', true, true], ['dba', true, false], ['net', false, false]])
    expect(r[2]).toMatchObject({ approvedByName: 'Anna', approvedAt: '2026-09-01' })
  })
})
