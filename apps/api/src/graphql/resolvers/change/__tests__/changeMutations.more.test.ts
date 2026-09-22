/**
 * changeMutations — the contracts of the Change aggregate mutations that the
 * narrower suites (createChange, deleteChange, window gate, required fields,
 * task reminder) leave open.
 *
 * Why these matter for a user:
 * - An RFC raised from a problem must link to THAT problem and push it to the
 *   `change_requested` purpose step; a silent link to a missing problem, or a
 *   problem left behind without a trace, makes the resolution path invisible.
 * - Linking/unlinking resolved tickets is tenant-scoped and refuses to remove
 *   the automatic link (the only way to drop it is deleting the change);
 *   unlinking a problem must send it back to analysis.
 * - Adding a CI must only draw task codes for tasks that will really be
 *   created, otherwise the numbering gets holes every time a CI is re-added.
 * - A transition that fails must surface as a CONFLICT and never write the
 *   audit entry; step-action errors after the commit must reach the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

// ── Scripted fake session ─────────────────────────────────────────────────────

type RunResult = { records: Array<{ get: (k: string) => unknown }> }
type Call = { cypher: string; params: Record<string, unknown> }
let calls: Call[] = []
/** Answers each Cypher statement; tests override it per scene. */
let answer: (cypher: string, params: Record<string, unknown>) => RunResult = () => ({ records: [] })

function rec(values: Record<string, unknown>) { return { get: (k: string) => values[k] } }

const tx = {
  run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    calls.push({ cypher, params })
    return answer(cypher, params)
  }),
}
const session = {
  executeRead:  vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  executeWrite: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn(session)),
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
  getSession:  vi.fn(() => session),
  mapCI:       vi.fn((p: Record<string, unknown>) => ({ id: p['id'], type: p['type'] })),
}))
vi.mock('@opengraphity/workflow', () => ({
  registerTaskCreator: vi.fn(),
  workflowEngine: {
    transition: vi.fn(async () => ({ success: true })),
    getAvailableTransitions: vi.fn(async () => []),
    registerCondition: vi.fn(),
    onStepEntered: vi.fn(),
  },
}))
vi.mock('../queries.js', () => ({ change: vi.fn(async (_: unknown, a: { id: string }) => ({ id: a.id, title: 'T' })) }))
vi.mock('../autoTransitions.js', () => ({
  evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined),
  revertProblemAfterChangeDetached: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../windowGate.js', () => ({ assertChangeWindowGate: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../helpers.js', () => ({
  afterEnterStep: vi.fn().mockResolvedValue(undefined),
  writeAudit: vi.fn().mockResolvedValue(undefined),
  getNextTaskCodes: vi.fn(async (_s: unknown, _t: string, n: number) => Array.from({ length: n }, (_, i) => `TASK${i + 1}`)),
  chiaviDaCreare: vi.fn(async (_s: unknown, _l: string, keys: string[]) => new Set(keys)),
  assertCIHasOwnerAndSupport: vi.fn().mockResolvedValue(undefined),
  assertInitialStep: vi.fn().mockResolvedValue({}),
  getCIName: vi.fn().mockResolvedValue('web-01'),
  loadChangeWorkflow: vi.fn(async () => ({ instanceId: 'wi-1', currentStep: 'assessment', props: { id: 'chg-1', title: 'Patch' } })),
}))
vi.mock('../../../../services/changeCreationService.js', () => ({
  createChangeRFC: vi.fn(async () => ({ id: 'chg-1', code: 'CHG00000001' })),
}))
vi.mock('../../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
  propsToFieldValues: (p: Record<string, unknown>) => ({ ...p }),
}))
vi.mock('../../../../lib/workflowTargets.js', () => ({ stepNamesByPurposeOrdered: vi.fn(async () => ['change_requested']) }))
vi.mock('../../../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, key: string, p: Record<string, string>) => `${key}:${p['code']}`) }))
vi.mock('../../../../lib/ticketCIExclusions.js', () => ({ assertCIsLinkable: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../lib/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
vi.mock('@opengraphity/sla', () => ({
  getActiveOLAContractsFor: vi.fn().mockResolvedValue([]),
  cancelOLABreaches: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../jobs/eventCorrelateWorker.js', () => ({ enqueueChangeWindowReevaluation: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../services/serviceImpact/sync.js', () => ({ notifyChangeWindowChanged: vi.fn().mockResolvedValue(1) }))

const mod = await import('../changeMutations.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const ciUtils = await import('../../ci-utils.js')
const helpers = await import('../helpers.js')
const { revertProblemAfterChangeDetached, evaluateAutoTransitions } = await import('../autoTransitions.js')
const { change: getChange } = await import('../queries.js')
const { logger } = await import('../../../../lib/logger.js')
const { assertCIsLinkable } = await import('../../../../lib/ticketCIExclusions.js')
const { assertChangeWindowGate } = await import('../windowGate.js')
const sla = await import('@opengraphity/sla')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u-1', userEmail: 'op@test.io', role: 'admin', permissions: perms('admin') }

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  answer = () => ({ records: [] })
})

const baseInput = { title: 'T', why: 'w', what: 'x', affectedCIIds: ['ci-1'] }

// ── createChange: link to the requesting problem / incident ──────────────────

describe('createChange — RFC raised from a problem', () => {
  it('links the problem (auto link, tenant-scoped) and moves it to the change_requested purpose step', async () => {
    answer = (c) => {
      if (c.includes('MERGE (p)-[rel:RESOLVED_BY]->(c)')) return { records: [rec({ id: 'prb-1' })] }
      if (c.includes('HAS_WORKFLOW')) return { records: [rec({ id: 'wi-p' })] }
      return { records: [] }
    }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([{ toStep: 'change_requested' }] as never)
    const res = await mod.createChange(null, { input: { ...baseInput, problemId: 'prb-1' } }, ctx)
    expect(res).toMatchObject({ id: 'chg-1' })
    const link = calls.find((c) => c.cypher.includes('RESOLVED_BY'))!
    expect(link.cypher).toContain('rel.auto = true')
    expect(link.params).toMatchObject({ problemId: 'prb-1', changeId: 'chg-1', tenantId: 't1' })
    // The note tells the problem timeline which RFC moved it.
    expect(workflowEngine.transition).toHaveBeenCalledWith(session,
      expect.objectContaining({ instanceId: 'wi-p', toStepName: 'change_requested', tenantId: 't1', notes: 'change.rfcCreated:CHG00000001' }),
      expect.anything())
  })

  it('a missing problem is NOT_FOUND: no silent link to an id that does not exist', async () => {
    await expect(mod.createChange(null, { input: { ...baseInput, problemId: 'ghost' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('a problem without workflow instance is linked but not transitioned', async () => {
    answer = (c) => (c.includes('MERGE (p)') ? { records: [rec({ id: 'prb-1' })] } : { records: [] })
    await mod.createChange(null, { input: { ...baseInput, problemId: 'prb-1' } }, ctx)
    expect(workflowEngine.getAvailableTransitions).not.toHaveBeenCalled()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('no reachable change_requested step: the problem stays put and it is logged, not swallowed', async () => {
    answer = (c) => {
      if (c.includes('MERGE (p)')) return { records: [rec({ id: 'prb-1' })] }
      if (c.includes('HAS_WORKFLOW')) return { records: [rec({ id: 'wi-p' })] }
      return { records: [] }
    }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([{ toStep: 'closed' }] as never)
    await mod.createChange(null, { input: { ...baseInput, problemId: 'prb-1' } }, ctx)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ problemId: 'prb-1', available: ['closed'] }), expect.any(String))
  })

  it('a refused problem transition does not undo the change, but is logged', async () => {
    answer = (c) => {
      if (c.includes('MERGE (p)')) return { records: [rec({ id: 'prb-1' })] }
      if (c.includes('HAS_WORKFLOW')) return { records: [rec({ id: 'wi-p' })] }
      return { records: [] }
    }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([{ toStep: 'change_requested' }] as never)
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: false, error: 'guard' } as never)
    await expect(mod.createChange(null, { input: { ...baseInput, problemId: 'prb-1' } }, ctx)).resolves.toMatchObject({ id: 'chg-1' })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ toStep: 'change_requested', error: 'guard' }), expect.any(String))
  })
})

describe('createChange — RFC raised from an incident', () => {
  it('links the incident with an automatic RESOLVED_BY and no transition', async () => {
    answer = (c) => (c.includes('MERGE (i)') ? { records: [rec({ id: 'inc-1' })] } : { records: [] })
    await mod.createChange(null, { input: { ...baseInput, incidentId: 'inc-1' } }, ctx)
    const link = calls.find((c) => c.cypher.includes('MERGE (i)'))!
    expect(link.cypher).toContain('rel.auto = true')
    expect(link.params).toMatchObject({ incidentId: 'inc-1', changeId: 'chg-1', tenantId: 't1' })
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('a missing incident is NOT_FOUND', async () => {
    await expect(mod.createChange(null, { input: { ...baseInput, incidentId: 'ghost' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

// ── deleteChange: post-commit cleanups not covered elsewhere ────────────────

describe('deleteChange — post-commit cleanups', () => {
  beforeEach(() => { answer = () => ({ records: [rec({ id: 'chg-1' })] }) })

  it('cancels the OLA breach timers of every active contract', async () => {
    vi.mocked(sla.getActiveOLAContractsFor).mockResolvedValueOnce([{ id: 'ola-1' }, { id: 'ola-2' }] as never)
    await mod.deleteChange(null, { id: 'chg-1' }, ctx)
    expect(sla.getActiveOLAContractsFor).toHaveBeenCalledWith('t1', 'change')
    expect(sla.cancelOLABreaches).toHaveBeenCalledWith('chg-1', ['ola-1', 'ola-2'])
  })

  it('an OLA cleanup failure is logged and does not undo the deletion', async () => {
    vi.mocked(sla.getActiveOLAContractsFor).mockRejectedValueOnce(new Error('redis'))
    await expect(mod.deleteChange(null, { id: 'chg-1' }, ctx)).resolves.toBe(true)
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ changeId: 'chg-1' }), expect.any(String))
  })

  it('problems resolved by the deleted change go back to analysis, and the session is closed', async () => {
    vi.mocked(ciUtils.runQuery).mockResolvedValueOnce([{ id: 'prb-1' }, { id: 'prb-2' }] as never)
    await mod.deleteChange(null, { id: 'chg-1' }, ctx)
    expect(vi.mocked(revertProblemAfterChangeDetached).mock.calls.map((c) => c[1])).toEqual(['prb-1', 'prb-2'])
    expect(session.close).toHaveBeenCalled()
  })
})

// ── linkResolvedTicket / unlinkResolvedTicket ────────────────────────────────

describe('linkResolvedTicket', () => {
  it('rejects a ticket type that is neither incident nor problem (it would be interpolated as a label)', async () => {
    await expect(mod.linkResolvedTicket(null, { changeId: 'chg-1', entityType: 'User', entityId: 'x' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(tx.run).not.toHaveBeenCalled()
  })

  it.each([['incident', 'Incident'], ['problem', 'Problem']])('links a %s within the tenant and returns the change', async (type, label) => {
    answer = () => ({ records: [rec({ id: 'chg-1' })] })
    const res = await mod.linkResolvedTicket(null, { changeId: 'chg-1', entityType: type, entityId: 'e-1' }, ctx)
    expect(calls[0]!.cypher).toContain(`MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})`)
    // A deleted change must not be linkable.
    expect(calls[0]!.cypher).toContain('coalesce(c.deleted, false) = false')
    expect(calls[0]!.params).toMatchObject({ tenantId: 't1', changeId: 'chg-1', entityId: 'e-1' })
    expect(res).toMatchObject({ id: 'chg-1' })
  })

  it('change or ticket not found (or in another tenant) is NOT_FOUND', async () => {
    await expect(mod.linkResolvedTicket(null, { changeId: 'chg-1', entityType: 'incident', entityId: 'e-1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(getChange).not.toHaveBeenCalled()
  })
})

describe('unlinkResolvedTicket', () => {
  it('rejects an unknown ticket type', async () => {
    await expect(mod.unlinkResolvedTicket(null, { changeId: 'chg-1', entityType: 'change', entityId: 'x' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
  })

  it('no link → NOT_FOUND, nothing deleted', async () => {
    await expect(mod.unlinkResolvedTicket(null, { changeId: 'chg-1', entityType: 'incident', entityId: 'e-1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(calls.some((c) => c.cypher.includes('DELETE r'))).toBe(false)
  })

  it('an automatic link cannot be removed: FORBIDDEN, the edge stays', async () => {
    answer = () => ({ records: [rec({ auto: true })] })
    await expect(mod.unlinkResolvedTicket(null, { changeId: 'chg-1', entityType: 'problem', entityId: 'p-1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(calls.some((c) => c.cypher.includes('DELETE r'))).toBe(false)
    expect(revertProblemAfterChangeDetached).not.toHaveBeenCalled()
  })

  it('an incident link is deleted and no problem is reverted', async () => {
    answer = () => ({ records: [rec({ auto: false })] })
    await mod.unlinkResolvedTicket(null, { changeId: 'chg-1', entityType: 'incident', entityId: 'i-1' }, ctx)
    const del = calls.find((c) => c.cypher.includes('DELETE r'))!
    expect(del.cypher).toContain('MATCH (e:Incident')
    expect(del.params).toMatchObject({ tenantId: 't1' })
    expect(revertProblemAfterChangeDetached).not.toHaveBeenCalled()
  })

  it('a problem link is deleted and the problem goes back to analysis', async () => {
    answer = () => ({ records: [rec({ auto: false })] })
    await mod.unlinkResolvedTicket(null, { changeId: 'chg-1', entityType: 'problem', entityId: 'p-1' }, ctx)
    expect(revertProblemAfterChangeDetached).toHaveBeenCalledWith(session, 'p-1', ctx)
    expect(session.close).toHaveBeenCalled()
  })
})

// ── addCIToChange / removeCIFromChange ───────────────────────────────────────

describe('addCIToChange', () => {
  function ciRow(props: Record<string, unknown>, label = 'Server') {
    vi.mocked(ciUtils.runQueryOne).mockResolvedValueOnce({ ciProps: props, ciLabel: label } as never)
  }

  it('draws a code only for the tasks that will really be created (no holes when a CI is re-added)', async () => {
    // Owner assessment and deploy plan are missing; the support assessment already exists.
    vi.mocked(helpers.chiaviDaCreare)
      .mockResolvedValueOnce(new Set(['chg-1-ci-1-owner']))
      .mockResolvedValueOnce(new Set(['chg-1-ci-1-deployplan']))
    ciRow({ id: 'ci-1', type: 'server' })
    await mod.addCIToChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)
    expect(helpers.getNextTaskCodes).toHaveBeenCalledWith(session, 't1', 2)
    const write = calls.find((c) => c.cypher.includes('MERGE (c)-[r_aci:AFFECTS_CI]->(ci)'))!
    expect(write.params).toMatchObject({
      ownerCode: 'TASK1', supportCode: null, planCode: 'TASK2',
      // The key checked for existence is the very same string the MERGE uses.
      chiaveOwner: 'chg-1-ci-1-owner', chiaveSupport: 'chg-1-ci-1-support', chiavePiano: 'chg-1-ci-1-deployplan',
      tenantId: 't1',
    })
    expect(vi.mocked(helpers.chiaviDaCreare).mock.calls[1]).toEqual([session, 'DeployPlanTask', ['chg-1-ci-1-deployplan']])
    expect(helpers.writeAudit).toHaveBeenCalledWith(tx, 'chg-1', 't1', 'ci_added', 'u-1', 'CI web-01 added', { key: 'ciAdded', params: { ci: 'web-01' } })
  })

  it('returns the CI in assessment phase, deriving the type from the label when the node has none', async () => {
    ciRow({ id: 'ci-1' }, 'Server')
    const res = await mod.addCIToChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)
    expect(res).toMatchObject({ ci: { id: 'ci-1', type: 'server' }, ciPhase: 'assessment', riskScore: null })
  })

  it('an excluded CI type is refused before any session is opened', async () => {
    vi.mocked(assertCIsLinkable).mockRejectedValueOnce(new Error('excluded'))
    await expect(mod.addCIToChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)).rejects.toThrow('excluded')
    expect(assertCIsLinkable).toHaveBeenCalledWith('t1', 'change', ['ci-1'])
    expect(ciUtils.withSession).not.toHaveBeenCalled()
  })

  it('a change past its initial step refuses new CIs and writes nothing', async () => {
    vi.mocked(helpers.assertInitialStep).mockRejectedValueOnce(new Error('not initial'))
    await expect(mod.addCIToChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)).rejects.toThrow('not initial')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('a CI that cannot be read back after the write is an internal error, not a half result', async () => {
    await expect(mod.addCIToChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  })
})

describe('removeCIFromChange', () => {
  it('deletes the link and the CI tasks in one transaction with the audit entry', async () => {
    await expect(mod.removeCIFromChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)).resolves.toBe(true)
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    expect(calls[0]!.cypher).toContain('DETACH DELETE resp, t, dp')
    expect(calls[0]!.params).toMatchObject({ changeId: 'chg-1', ciId: 'ci-1', tenantId: 't1' })
    expect(helpers.writeAudit).toHaveBeenCalledWith(tx, 'chg-1', 't1', 'ci_removed', 'u-1', 'CI web-01 removed', { key: 'ciRemoved', params: { ci: 'web-01' } })
  })

  it('refuses outside the initial step', async () => {
    vi.mocked(helpers.assertInitialStep).mockRejectedValueOnce(new Error('not initial'))
    await expect(mod.removeCIFromChange(null, { changeId: 'chg-1', ciId: 'ci-1' }, ctx)).rejects.toThrow('not initial')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})

// ── executeChangeTransition ──────────────────────────────────────────────────

describe('executeChangeTransition', () => {
  it('passes the default change type "normal" to the window gate when the change has none', async () => {
    await mod.executeChangeTransition(null, { changeId: 'chg-1', toStep: 'scheduled' }, ctx)
    expect(assertChangeWindowGate).toHaveBeenCalledWith(session, ctx, expect.objectContaining({ changeType: 'normal', currentStep: 'assessment', toStep: 'scheduled', tenantId: 't1' }))
  })

  it('a refused transition is a CONFLICT and writes no audit entry', async () => {
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: false, error: 'guard failed' } as never)
    await expect(mod.executeChangeTransition(null, { changeId: 'chg-1', toStep: 'scheduled' }, ctx))
      .rejects.toMatchObject({ message: 'guard failed', extensions: { code: 'CONFLICT' } })
    expect(helpers.writeAudit).not.toHaveBeenCalled()
    expect(evaluateAutoTransitions).not.toHaveBeenCalled()
  })

  it('writes a stable action with trimmed notes and exposes step-action errors to the client', async () => {
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: true, actionErrors: ['sla timer'] } as never)
    const res = await mod.executeChangeTransition(null, { changeId: 'chg-1', toStep: 'scheduled', notes: '  night window ' }, ctx)
    expect(helpers.writeAudit).toHaveBeenCalledWith(session, 'chg-1', 't1', 'change_step_entered', 'u-1',
      'scheduled: night window', { key: 'stepEntered', params: { step: 'scheduled', notes: ': night window' } })
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ actionErrors: ['sla timer'] }), expect.any(String))
    expect(res).toMatchObject({ id: 'chg-1', actionErrors: ['sla timer'] })
  })

  it('without notes the audit detail is the step alone, actionErrors null, and a missing user acts as system', async () => {
    const res = await mod.executeChangeTransition(null, { changeId: 'chg-1', toStep: 'scheduled' }, { ...ctx, userId: undefined } as unknown as GraphQLContext)
    expect(workflowEngine.transition).toHaveBeenCalledWith(session, expect.objectContaining({ triggeredBy: 'system' }), expect.objectContaining({ userId: 'system' }))
    expect(vi.mocked(helpers.writeAudit).mock.calls[0]![5]).toBe('scheduled')
    expect(vi.mocked(helpers.writeAudit).mock.calls[0]![6]).toEqual({ key: 'stepEntered', params: { step: 'scheduled', notes: '' } })
    expect(res).toMatchObject({ actionErrors: null })
  })

  it('returns null when the change can no longer be read', async () => {
    vi.mocked(getChange).mockResolvedValueOnce(null as never)
    await expect(mod.executeChangeTransition(null, { changeId: 'chg-1', toStep: 'scheduled' }, ctx)).resolves.toBeNull()
  })
})
