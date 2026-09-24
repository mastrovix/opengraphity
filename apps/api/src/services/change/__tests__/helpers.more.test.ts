/**
 * THE SHARED CHANGE HELPERS — what every change mutation stands on.
 *
 * `change/helpers.ts` is the centre of the change modules: the audit timeline,
 * the task codes, the workflow lookups, the risk maths and the tasks a step
 * creates when the change enters it. A regression here does not break one
 * button, it breaks all of them at once:
 *  - a write that ignores the caller's transaction leaves half a change behind
 *    when the other half rolls back;
 *  - task codes taken for tasks that already exist leave holes in the
 *    numbering ("where is TASK00000065?");
 *  - a workflow lookup that picks one of two diverging steps hides corruption
 *    and lets a deleted change be operated on;
 *  - an aggregate risk computed while a CI is still unassessed shows a
 *    "LOW · 0" band nobody measured, and a pre-approved change that fails to
 *    advance sits in approval forever with nothing to approve.
 *
 * The database is a scripted router over the Cypher text; the write path goes
 * through a fake session (`executeWrite`) or a fake transaction (`run`), so the
 * tests can tell the two apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

type Route = (q: string, params: Record<string, unknown>) => unknown
let many: Route = () => []
let one: Route = () => null

vi.mock('../../../lib/db.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => many(q, p)),
  runQueryOne: vi.fn(async (_s: unknown, q: string, p: Record<string, unknown>) => one(q, p)),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn(async () => 'draft'),
  getStepPurpose:     vi.fn(async () => null),
}))
vi.mock('../../../lib/workflowTargets.js', () => ({ targetStepByPurpose: vi.fn(async () => 'scheduled') }))
vi.mock('../../../lib/systemText.js', () => ({ systemText: vi.fn(async () => 'Pre-approved') }))
vi.mock('../../../lib/sequence.js', () => ({ nextSequenceBlock: vi.fn() }))
vi.mock('../../../lib/ticketNumbering.js', () => ({ nextTicketNumber: vi.fn(async () => 'CHG00000042') }))
vi.mock('../approvalCreation.js', () => ({ createChangeApprovals: vi.fn() }))
vi.mock('../../../lib/changePolicy.js', () => ({ isPreApprovedChangeType: vi.fn(async () => false) }))
// The pipeline of the transitions (wave 7 · B1): the pre-approval moves the change through it.
const transition = vi.hoisted(() => vi.fn())
vi.mock('../../ticketTransition.js', () => ({ transitionTicket: transition }))
vi.mock('../scoring.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../scoring.js')>()
  return {
    ...orig,
    determineApprovalRoute: vi.fn(async (_t: string, score: number) => (score >= 50 ? 'cab' : 'manager')),
    deriveChangePriority:   vi.fn(async (_t: string, type: string | null, risk: number | null) => `${type ?? 'none'}:${risk ?? 'unknown'}`),
  }
})

const h = await import('../helpers.js')
const { nextSequenceBlock } = await import('../../../lib/sequence.js')
const { nextTicketNumber } = await import('../../../lib/ticketNumbering.js')
const { getStepPurpose } = await import('../../../lib/workflowHelpers.js')
const { createChangeApprovals } = await import('../approvalCreation.js')
const { isPreApprovedChangeType } = await import('../../../lib/changePolicy.js')
const { deriveChangePriority, determineApprovalRoute } = await import('../scoring.js')
const { runQuery } = await import('../../../lib/db.js')

// ── fake session / transaction ────────────────────────────────────────────────

const writes: { q: string; params: Record<string, unknown>; via: 'session' | 'tx' }[] = []
const session = {
  executeWrite: vi.fn(async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown) =>
    fn({ run: (q, p) => { writes.push({ q, params: p, via: 'session' }); return { records: [] } } })),
  close: vi.fn(),
} as never
const tx = { run: vi.fn(async (q: string, p: Record<string, unknown>) => { writes.push({ q, params: p, via: 'tx' }); return { records: [] } }) } as never

const operator = { tenantId: 't1', userId: 'u1', role: 'operator', permissions: perms('operator') } as never

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  many = () => []
  one = () => null
})

async function failure(p: Promise<unknown>): Promise<{ message: string; extensions: Record<string, unknown> }> {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e, 'the call should have failed').not.toBeNull()
  return e as { message: string; extensions: Record<string, unknown> }
}

// ── writeAudit + the session/transaction switch ───────────────────────────────

describe('writeAudit', () => {
  it('on a session it opens its own write transaction', async () => {
    await h.writeAudit(session, 'c1', 't1', 'created', 'u1', 'Created')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ via: 'session', params: { changeId: 'c1', tenantId: 't1', action: 'created', actorId: 'u1', detail: 'Created', detailKey: null, detailParams: null } })
  })

  it('inside a caller transaction it writes there, so it rolls back with the rest', async () => {
    await h.writeAudit(tx, 'c1', 't1', 'ci_risk_computed', null, 'db: risk 3', { key: 'ciRisk', params: { ci: 'db', score: '3' } })
    expect(writes[0]!.via).toBe('tx')
    // The timeline composes the sentence in the viewer's language from key + params.
    expect(writes[0]!.params).toMatchObject({ detailKey: 'ciRisk', detailParams: JSON.stringify({ ci: 'db', score: '3' }) })
    expect(writes[0]!.q).toContain('MATCH (c:Change {id: $changeId, tenant_id: $tenantId})')
  })
})

// ── codes ─────────────────────────────────────────────────────────────────────

describe('codes', () => {
  it('the change code comes from the tenant\'s numbering', async () => {
    expect(await h.nextChangeCode(tx, 't1')).toBe('CHG00000042')
    expect(nextTicketNumber).toHaveBeenCalledWith(tx, 't1', 'change')
  })

  it('task codes: a block of consecutive numbers ending at the counter, zero-padded', async () => {
    vi.mocked(nextSequenceBlock).mockResolvedValue(12)
    expect(await h.getNextTaskCodes(tx, 't1', 3)).toEqual(['TASK00000010', 'TASK00000011', 'TASK00000012'])
    expect(nextSequenceBlock).toHaveBeenCalledWith(tx, 't1', 'task', 3)
  })

  it('asking for no code does not touch the counter (no hole in the numbering)', async () => {
    expect(await h.getNextTaskCodes(tx, 't1', 0)).toEqual([])
    expect(await h.getNextTaskCodes(tx, 't1', -1)).toEqual([])
    expect(nextSequenceBlock).not.toHaveBeenCalled()
  })

  it('chiaviDaCreare: only the natural keys that do not exist yet', async () => {
    many = () => [{ chiave: 'k2' }]
    expect([...await h.chiaviDaCreare(tx, 'AssessmentTask', ['k1', 'k2', 'k3'], 't1')]).toEqual(['k1', 'k3'])
    // The tenant with the key: the (tenant_id, change_key) constraint's index (review of 23 Sep 2026).
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('MATCH (t:AssessmentTask {tenant_id: $tenantId})')
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ tenantId: 't1' })
  })

  it('chiaviDaCreare with no keys does not query', async () => {
    expect((await h.chiaviDaCreare(tx, 'ReviewTask', [], 't1')).size).toBe(0)
    expect(runQuery).not.toHaveBeenCalled()
  })
})

// ── sanity checks and loaders ─────────────────────────────────────────────────

describe('assertCIHasOwnerAndSupport', () => {
  it('passes when every CI has both groups', async () => {
    many = () => [{ id: 'ci1', name: 'db', ownerTeamId: 'a', supportTeamId: 'b' }]
    await expect(h.assertCIHasOwnerAndSupport(session, 't1', ['ci1'])).resolves.toBeUndefined()
  })

  it.each([[{ ownerTeamId: null, supportTeamId: 'b' }], [{ ownerTeamId: 'a', supportTeamId: null }]])(
    'a CI missing a group blocks the change and is named (%o)', async (teams) => {
      many = () => [{ id: 'ci1', name: 'db', ownerTeamId: 'a', supportTeamId: 'b' }, { id: 'ci2', name: 'web-01', ...teams }]
      const e = await failure(h.assertCIHasOwnerAndSupport(session, 't1', ['ci1', 'ci2']))
      expect(e.extensions['i18n']).toMatchObject({ key: 'errors.ci.missingGroups', params: { ci: 'web-01' } })
    })
})

describe('loaders', () => {
  it('loadChange excludes deleted changes and returns null when missing', async () => {
    let seen = ''
    one = (q) => { seen = q; return { props: { id: 'c1' } } }
    expect(await h.loadChange(session, 'c1', 't1')).toEqual({ id: 'c1' })
    expect(seen).toContain(h.CHANGE_NOT_DELETED)
    one = () => null
    expect(await h.loadChange(session, 'c1', 't1')).toBeNull()
  })

  it('names fall back to the id, so the timeline never shows an empty name', async () => {
    one = () => null
    expect(await h.getCIName(session, 'ci1', 't1')).toBe('ci1')
    expect(await h.getQuestionText(session, 'q1', 't1')).toBe('q1')
    expect(await h.getAnswerLabel(session, 'o1', 't1')).toBe('o1')
    one = () => ({ name: 'db', text: 'Is it down?', label: 'Yes' })
    expect(await h.getCIName(session, 'ci1', 't1')).toBe('db')
    expect(await h.getQuestionText(session, 'q1', 't1')).toBe('Is it down?')
    expect(await h.getAnswerLabel(session, 'o1', 't1')).toBe('Yes')
  })

  it('getCurrentStep returns the step or null', async () => {
    one = () => ({ step: 'assessment' })
    expect(await h.getCurrentStep(session, 'c1', 't1')).toBe('assessment')
    one = () => null
    expect(await h.getCurrentStep(session, 'c1', 't1')).toBeNull()
  })
})

// ── workflow lookups ──────────────────────────────────────────────────────────

describe('loadChangeWorkflow', () => {
  const ok = { props: { id: 'c1' }, deleted: false, instanceId: 'wi1', wiStep: 'assessment', relStep: 'assessment' }

  it('returns instance, step and props when everything agrees', async () => {
    one = () => ok
    expect(await h.loadChangeWorkflow(session, 'c1', 't1')).toEqual({ instanceId: 'wi1', currentStep: 'assessment', props: { id: 'c1' } })
  })

  it('a missing change is NotFound', async () => {
    const e = await failure(h.loadChangeWorkflow(session, 'c1', 't1'))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it.each([
    [{ deleted: true }, 'was deleted'],
    [{ instanceId: null }, 'no linked WorkflowInstance'],
    [{ relStep: null }, 'without CURRENT_STEP'],
    // Divergence is corruption: surfaced, never resolved by picking one side.
    [{ wiStep: 'draft' }, 'inconsistent workflow instance'],
  ])('%o is a CONFLICT', async (over, text) => {
    one = () => ({ ...ok, ...over })
    const e = await failure(h.loadChangeWorkflow(session, 'c1', 't1'))
    expect(e.extensions['code']).toBe('CONFLICT')
    expect(e.message).toContain(text)
  })
})

describe('getInstanceId', () => {
  it('returns the instance id', async () => {
    one = () => ({ id: 'wi1', deleted: false })
    expect(await h.getInstanceId(session, 'c1', 't1')).toBe('wi1')
  })

  it('missing change → NotFound; deleted or unlinked → CONFLICT', async () => {
    expect((await failure(h.getInstanceId(session, 'c1', 't1'))).extensions['code']).toBe('NOT_FOUND')
    one = () => ({ id: 'wi1', deleted: true })
    const deleted = await failure(h.getInstanceId(session, 'c1', 't1'))
    expect(deleted.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.change.deleted' } })
    one = () => ({ id: null, deleted: false })
    expect((await failure(h.getInstanceId(session, 'c1', 't1'))).message).toContain('no linked WorkflowInstance')
  })
})

describe('assertInitialStep', () => {
  it('a missing (or deleted) change is NotFound', async () => {
    expect((await failure(h.assertInitialStep(session, 'c1', 't1'))).extensions['code']).toBe('NOT_FOUND')
  })

  it('outside the initial step the edit is refused, naming the current step', async () => {
    one = (q) => (q.includes('properties(c) AS props') ? { props: { id: 'c1' } } : { step: 'approval' })
    const e = await failure(h.assertInitialStep(session, 'c1', 't1'))
    expect(e.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.change.onlyInInitialStep', params: { current: 'approval' } } })
  })

  it('in the initial step it returns the change', async () => {
    one = (q) => (q.includes('properties(c) AS props') ? { props: { id: 'c1' } } : { step: 'draft' })
    expect(await h.assertInitialStep(session, 'c1', 't1')).toEqual({ id: 'c1' })
  })
})

describe('assertUserInCITeam', () => {
  it('a member of the group passes', async () => {
    one = () => ({ ok: true })
    await expect(h.assertUserInCITeam(session, 'ci1', 't1', operator, 'owner')).resolves.toBeUndefined()
  })
})

// ── risk ──────────────────────────────────────────────────────────────────────

describe('resetChangeRisk', () => {
  it('a missing change is NotFound', async () => {
    expect((await failure(h.resetChangeRisk(tx, 'c1', 't1'))).extensions['code']).toBe('NOT_FOUND')
    expect(writes).toHaveLength(0)
  })

  it('clears the derived fields and falls back to the priority of the type alone', async () => {
    one = () => ({ changeType: 'normal' })
    await h.resetChangeRisk(tx, 'c1', 't1')
    expect(deriveChangePriority).toHaveBeenCalledWith('t1', 'normal', null)
    expect(writes[0]!.q).toContain('c.aggregate_risk_score = null')
    expect(writes[0]!.params).toMatchObject({ changeId: 'c1', tenantId: 't1', priority: 'normal:unknown' })
  })
})

describe('recomputeCIRiskIfReady', () => {
  it.each([[null], [{ ownerDone: true, supportDone: false }], [{ ownerDone: false, supportDone: true }]])(
    'nothing is computed until both owner and support are done (%o)', async (row) => {
      one = () => row
      await h.recomputeCIRiskIfReady(tx, 'c1', 'ci1', 't1', 'u1')
      expect(writes).toHaveLength(0)
    })

  it('both done: the CI risk is the rounded average, written on the edge and in the timeline', async () => {
    one = (q) => (q.includes('ownerDone') ? { ownerDone: true, supportDone: true, ownerScore: 4, supportScore: 7 } : { name: 'db-01' })
    await h.recomputeCIRiskIfReady(tx, 'c1', 'ci1', 't1', 'u1')
    expect(writes[0]!.params).toMatchObject({ risk: 6, ciId: 'ci1' })
    expect(writes[0]!.q).toContain("r.ci_phase = 'assessed'")
    expect(writes[1]!.params).toMatchObject({ action: 'ci_risk_computed', detail: 'db-01: risk 6', detailKey: 'ciRisk', actorId: 'u1' })
  })

  it('a missing score counts as 0', async () => {
    one = (q) => (q.includes('ownerDone') ? { ownerDone: true, supportDone: true, ownerScore: null, supportScore: 5 } : null)
    await h.recomputeCIRiskIfReady(tx, 'c1', 'ci1', 't1', null)
    expect(writes[0]!.params['risk']).toBe(3)
  })
})

describe('computeAggregateRisk', () => {
  it('a CI still unassessed means the risk is unknown: reset, not "LOW · 0"', async () => {
    one = (q) => (q.includes('maxRisk') ? { maxRisk: 2, unassessed: 1, changeType: 'normal' } : { changeType: 'normal' })
    await h.computeAggregateRisk(tx, 'c1', 't1')
    expect(determineApprovalRoute).not.toHaveBeenCalled()
    expect(writes[0]!.q).toContain('c.aggregate_risk_score = null')
  })

  it('a change with no CI rows at all is reset too', async () => {
    one = (q) => (q.includes('maxRisk') ? null : { changeType: 'emergency' })
    await h.computeAggregateRisk(tx, 'c1', 't1')
    expect(writes[0]!.params['priority']).toBe('emergency:unknown')
  })

  it('all assessed: the max risk sets route and priority', async () => {
    one = () => ({ maxRisk: 60, unassessed: 0, changeType: 'normal' })
    await h.computeAggregateRisk(tx, 'c1', 't1')
    expect(writes[0]!.params).toMatchObject({ maxRisk: 60, route: 'cab', priority: 'normal:60' })
  })

  it('a null max with nothing unassessed is treated as 0', async () => {
    one = () => ({ maxRisk: null, unassessed: 0, changeType: null })
    await h.computeAggregateRisk(tx, 'c1', 't1')
    expect(writes[0]!.params).toMatchObject({ maxRisk: 0, route: 'manager', priority: 'none:0' })
  })
})

// ── afterEnterStep ────────────────────────────────────────────────────────────

describe('afterEnterStep', () => {
  it('a step with no hook and no approval purpose does nothing', async () => {
    await h.afterEnterStep(tx, 'c1', 't1', 'assessment')
    expect(writes).toHaveLength(0)
    expect(createChangeApprovals).not.toHaveBeenCalled()
  })

  it('an unknown hook is a misconfigured workflow: blocked, not a silently empty phase', async () => {
    one = () => ({ hook: 'bogus' })
    const e = await failure(h.afterEnterStep(tx, 'c1', 't1', 'deploy'))
    expect(e.extensions['code']).toBe('CONFLICT')
    expect(e.message).toContain('unknown on_enter_create hook "bogus"')
  })

  it('validation_and_deployment with no CI creates nothing and takes no code', async () => {
    one = () => ({ hook: 'validation_and_deployment' })
    await h.afterEnterStep(tx, 'c1', 't1', 'deploy')
    expect(writes).toHaveLength(0)
    expect(nextSequenceBlock).not.toHaveBeenCalled()
  })

  it('validation_and_deployment: codes only for the tasks that are really born', async () => {
    one = () => ({ hook: 'validation_and_deployment' })
    many = (q) => {
      if (q.includes('RETURN ci.id AS ciId')) return [{ ciId: 'a' }, { ciId: 'b' }]
      // CI a already has its validation test (re-entering the step).
      if (q.includes('MATCH (t:ValidationTest {tenant_id: $tenantId})')) return [{ chiave: 'c1-a' }]
      return []
    }
    vi.mocked(nextSequenceBlock).mockResolvedValue(103)
    await h.afterEnterStep(tx, 'c1', 't1', 'deploy')
    expect(nextSequenceBlock).toHaveBeenCalledWith(tx, 't1', 'task', 3)
    expect(writes[0]!.params['ciCodes']).toEqual([
      { ciId: 'a', valKey: 'c1-a', depKey: 'c1-a-exec', valCode: null, depCode: 'TASK00000101' },
      { ciId: 'b', valKey: 'c1-b', depKey: 'c1-b-exec', valCode: 'TASK00000102', depCode: 'TASK00000103' },
    ])
  })

  it('review: one task per CI, and none re-coded when they already exist', async () => {
    one = () => ({ hook: 'review' })
    many = (q) => {
      if (q.includes('RETURN ci.id AS ciId')) return [{ ciId: 'a' }, { ciId: 'b' }]
      if (q.includes('MATCH (t:ReviewTask {tenant_id: $tenantId})')) return [{ chiave: 'c1-b-review' }]
      return []
    }
    vi.mocked(nextSequenceBlock).mockResolvedValue(7)
    await h.afterEnterStep(tx, 'c1', 't1', 'review')
    expect(writes[0]!.params['ciCodes']).toEqual([
      { ciId: 'a', key: 'c1-a-review', code: 'TASK00000007' },
      { ciId: 'b', key: 'c1-b-review', code: null },
    ])
  })

  it('review with no CI writes nothing', async () => {
    one = () => ({ hook: 'review' })
    await h.afterEnterStep(tx, 'c1', 't1', 'review')
    expect(writes).toHaveLength(0)
  })

  describe('entering an approval step', () => {
    beforeEach(() => { vi.mocked(getStepPurpose).mockImplementation(async (_s, _t, _e, step) => (step === 'cab' ? 'approval' : null)) })

    it('creates the approval requirements; a change type that is not pre-approved stays there', async () => {
      one = (q) => (q.includes('c.change_type AS t') ? { t: 'normal' } : null)
      await h.afterEnterStep(tx, 'c1', 't1', 'cab')
      expect(createChangeApprovals).toHaveBeenCalledWith(tx, 'c1', 't1')
      expect(isPreApprovedChangeType).toHaveBeenCalledWith('t1', 'normal')
      expect(transition).not.toHaveBeenCalled()
    })

    it('a change with no type is never treated as pre-approved', async () => {
      await h.afterEnterStep(tx, 'c1', 't1', 'cab')
      expect(isPreApprovedChangeType).not.toHaveBeenCalled()
    })

    it('a pre-approved type moves on to the scheduled step, and that step\'s hook runs', async () => {
      vi.mocked(isPreApprovedChangeType).mockResolvedValue(true)
      transition.mockResolvedValue({ moved: true, actionErrors: [] })
      const hooks: string[] = []
      one = (q, p) => {
        if (q.includes('c.change_type AS t')) return { t: 'standard' }
        if (q.includes('wi.id AS id')) return { id: 'wi1', deleted: false }
        if (q.includes('on_enter_create AS hook')) { hooks.push(p['stepName'] as string); return null }
        return null
      }
      await h.afterEnterStep(tx, 'c1', 't1', 'cab')
      // The pre-approval is the approval's outcome, signed by the system.
      expect(transition).toHaveBeenCalledWith(tx, {
        tenantId: 't1', instanceId: 'wi1', toStep: 'scheduled', notes: 'Pre-approved',
        actor: { kind: 'system', path: 'approval' }, triggerType: 'automatic',
      })
      // The step reached automatically gets its own side effects.
      expect(hooks).toEqual(['cab', 'scheduled'])
    })

    it.each([['change_window', 'window closed'], ['workflow', 'The workflow refused the transition']])(
      'a failed pre-approval is loud, never a change stuck with nothing to approve (%s)', async (guard, reason) => {
        vi.mocked(isPreApprovedChangeType).mockResolvedValue(true)
        transition.mockResolvedValue({ moved: false, refusal: { guard, final: true, code: 'CONFLICT', message: reason } })
        one = (q) => {
          if (q.includes('c.change_type AS t')) return { t: 'standard' }
          if (q.includes('wi.id AS id')) return { id: 'wi1', deleted: false }
          return null
        }
        const e = await failure(h.afterEnterStep(tx, 'c1', 't1', 'cab'))
        expect(e.extensions).toMatchObject({ code: 'CONFLICT', i18n: { key: 'errors.change.preApprovalFailed', params: { type: 'standard' } } })
        expect(e.message).toContain(reason)
      })
  })
})
