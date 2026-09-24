/**
 * The Workflow Designer's write path and the generic ticket transition.
 *
 * Why these behaviours matter:
 *  - Every designer mutation is scoped to the caller's tenant and to ONE
 *    definition: a transition or step of another definition must never be
 *    touched (B-26), and "not found" must be said instead of pretending success.
 *  - Vocabularies (actions, purposes, categories, triggers, conditions) are
 *    enforced BEFORE writing: a typo stored in the graph turns an edge into a
 *    wall or makes a step silently skip its side effects.
 *  - The change workflow must keep an approval step and a release-window step,
 *    otherwise an unapproved change can reach production unchallenged.
 *  - `saveWorkflowChanges` is an optimistic-locked, single-transaction save:
 *    a stale designer must not overwrite a colleague's edits.
 *  - A manual transition is the pipeline's (services/ticketTransition.ts,
 *    wave 7 · B1, tested there with every guard): here, that a person asks it
 *    with their permissions, that changes are sent to their own mutation, that
 *    a guard's refusal is the error on the screen and the engine's no is the
 *    result, and that errors after the move are reported, not thrown.
 *  - Duplicating / switching definitions requires `config.workflow`, and the
 *    last active uncategorised definition of a type can never be switched off
 *    (no new ticket of that type could be created any more).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { Permission } from '@opengraphity/types'
import type { GraphQLContext } from '../../../context.js'

// ── Scripted session ──────────────────────────────────────────────────────────

type Rec = { get: (k: string) => unknown }
type Res = { records: Rec[] }
interface Call { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }

const calls: Call[] = []
/** Each entry answers the first query whose text matches, once. */
let script: Array<{ match: string | RegExp; res: Res }> = []

const rec = (map: Record<string, unknown>): Rec => ({ get: (k: string) => (k in map ? map[k] : null) })
const rows = (...maps: Array<Record<string, unknown>>): Res => ({ records: maps.map(rec) })
const on = (match: string | RegExp, res: Res) => { script.push({ match, res }) }

function answer(cypher: string): Res {
  const i = script.findIndex((s) => (typeof s.match === 'string' ? cypher.includes(s.match) : s.match.test(cypher)))
  if (i < 0) return { records: [] }
  return script.splice(i, 1)[0]!.res
}
const tx = (mode: 'read' | 'write') => ({
  run: async (cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params, mode }); return answer(cypher) },
})
const mockSession = {
  executeRead:  vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx('read'))),
  executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx('write'))),
  close:        vi.fn(async () => undefined),
}
const callOf = (m: string | RegExp) => calls.find((c) => (typeof m === 'string' ? c.cypher.includes(m) : m.test(c.cypher)))

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { WORKFLOW_ACTION_TYPES: REAL_ACTIONS, isWorkflowActionType: isRealAction } =
  await import('../../../../../../packages/workflow/src/types.js')

vi.mock('@opengraphity/workflow', () => ({
  WORKFLOW_ACTION_TYPES: REAL_ACTIONS,
  isWorkflowActionType: isRealAction,
}))
// The pipeline of the transitions (wave 7 · B1): its guards and the move are tested on their own.
const pipeline = vi.hoisted(() => ({ transitionTicket: vi.fn() }))
vi.mock('../../../services/ticketTransition.js', async () => {
  const { GraphQLError: GqlError } = await import('graphql')
  return {
    transitionTicket: (...a: unknown[]) => pipeline.transitionTicket(...a),
    personActor: (c: { userId: string; permissions: unknown }) => ({ kind: 'person', userId: c.userId, permissions: c.permissions }),
    refusalError: (r: { message: string; code: string; i18n?: unknown; extensions?: Record<string, unknown> }) =>
      new GqlError(r.message, { extensions: { code: r.code, ...(r.extensions ?? {}), ...(r.i18n ? { i18n: r.i18n } : {}) } }),
  }
})
vi.mock('@opengraphity/notifications', () => ({
  WORKFLOW_STEP_NOTIFY_EVENT: 'workflow.step.entered',
  routableChannels: () => ['in_app', 'email'],
  unroutableChannels: (_t: string, ch: readonly string[]) => ch.filter((c) => c !== 'in_app' && c !== 'email'),
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  getSession: vi.fn(),
}))
vi.mock('../workflowMapping.js', async (orig) => ({
  ...(await orig<object>()),
  loadTransitionRows: vi.fn(async () => []),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ invalidateWorkflowCache: vi.fn() }))
vi.mock('../../../lib/stepEvent.js', () => ({ auditStepEntered: vi.fn(async () => undefined) }))
vi.mock('../../../lib/roles.js', async (orig) => ({
  ...(await orig<object>()),
  assertRolesExist: vi.fn(async () => undefined),
}))
vi.mock('../../../lib/stepFieldWrites.js', async (orig) => ({
  ...(await orig<object>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['impact', { name: 'impact', fieldType: 'enum', enumValues: ['low', 'high'], enumTypeName: null }],
  ])),
}))
vi.mock('../../../lib/stepDeadlineWrite.js', async (orig) => ({
  ...(await orig<object>()),
  assertDefinitionDeadlines: vi.fn(async () => undefined),
}))
vi.mock('../../../lib/workflowAuditDetails.js', () => ({
  workflowSnapshot: vi.fn(async () => ({ steps: {}, transitions: {} })),
  workflowChangeDetails: vi.fn(() => ({ changed: true })),
}))
const policy = { preApproved: ['standard'] as string[], vocabulary: ['standard', 'normal'] as string[] }
vi.mock('../../../lib/changePolicy.js', () => ({
  preApprovedChangeTypes: vi.fn(async () => policy.preApproved),
  changeTypeVocabulary:   vi.fn(async () => policy.vocabulary),
}))

const M = await import('../workflowMutations.js')
const { invalidateWorkflowCache } = await import('../../../lib/workflowHelpers.js')
const { audit } = await import('../../../lib/audit.js')
const { assertDefinitionDeadlines } = await import('../../../lib/stepDeadlineWrite.js')
const { auditStepEntered } = await import('../../../lib/stepEvent.js')

const ctx: GraphQLContext = {
  tenantId: 't-1', userId: 'u-1', userEmail: 'u@test.io', role: 'admin',
  permissions: new Set<Permission>(['config.workflow', 'incident.write', 'problem.write', 'request.write', 'kb.write']),
}
const noPerms: GraphQLContext = { ...ctx, role: 'operator', permissions: new Set<Permission>() }

const caught = async (p: Promise<unknown>): Promise<GraphQLError> => {
  const e = await p.then(() => null, (err: unknown) => err)
  expect(e).toBeInstanceOf(GraphQLError)
  return e as GraphQLError
}
const caughtSync = (fn: () => unknown): GraphQLError => {
  try { fn() } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return e as GraphQLError }
  throw new Error('expected a throw')
}

beforeEach(() => {
  calls.length = 0
  script = []
  policy.preApproved = ['standard']
  policy.vocabulary = ['standard', 'normal']
  vi.clearAllMocks()
})

// ── Pure validators ───────────────────────────────────────────────────────────

describe('assertStepActions — the remaining refusals', () => {
  it('update_field without a field, or on an engine-owned field, is refused before it reaches the graph', () => {
    expect(caughtSync(() => M.assertStepActions(JSON.stringify([{ type: 'update_field', params: {} }]), 'enter')).extensions['i18n'])
      .toMatchObject({ key: 'errors.workflow.updateFieldNeedsField' })
    expect(caughtSync(() => M.assertStepActions(JSON.stringify([{ type: 'update_field', params: { field: '  ' } }]), 'enter')).message)
      .toMatch(/needs the field/)
    // `status` is written only by transitions: a step writing it would let status and step drift apart.
    const e = caughtSync(() => M.assertStepActions(JSON.stringify([{ type: 'update_field', params: { field: 'status', value: 'x' } }]), 'enter'))
    expect(e.extensions['field']).toBe('status')
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.stepField.engine_owned' })
  })

  it('a change can only be created by a step when the action names its change type', () => {
    const make = (params: Record<string, unknown>) => JSON.stringify([{ type: 'create_entity', params }])
    expect(caughtSync(() => M.assertStepActions(make({ entity_type: 'change' }), 'enter')).extensions['i18n'])
      .toMatchObject({ key: 'errors.workflow.createChangeNeedsType' })
    expect(() => M.assertStepActions(make({ entity_type: 'change', change_type: ' ' }), 'enter')).toThrow(/change type/)
    expect(() => M.assertStepActions(make({ entity_type: 'change', change_type: 'normal' }), 'enter')).not.toThrow()
    expect(() => M.assertStepActions(make({ entity_type: 'incident' }), 'enter')).not.toThrow()
    expect(() => M.assertStepActions(JSON.stringify([{ type: 'create_entity' }]), 'enter')).not.toThrow()
  })

  it('a null entry in the list is refused as an unknown action, not a crash', () => {
    expect(caughtSync(() => M.assertStepActions('[null]', 'enter')).message).toContain('action type null is unknown')
  })

  it('an empty target on notify_rule means "default recipients" and is accepted', () => {
    expect(() => M.assertStepActions(JSON.stringify([{ type: 'notify_rule', params: { target: '' } }]), 'enter')).not.toThrow()
  })

  it('an unknown notify_rule recipient is refused naming the valid ones', () => {
    const e = caughtSync(() => M.assertStepActions(JSON.stringify([{ type: 'notify_rule', params: { target: 'everyone' } }]), 'enter'))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.badTarget', params: { target: 'everyone' } })
  })
})

describe('closed vocabularies of steps and transitions', () => {
  it('normalizeStepCategory: empty keeps the stored category, unknown is refused naming the allowed values', () => {
    expect(M.normalizeStepCategory(null, 'x')).toBeNull()
    expect(M.normalizeStepCategory('  ', 'x')).toBeNull()
    expect(M.normalizeStepCategory(' active ', 'x')).toBe('active')
    // «risolto» used to be accepted: the ticket looked resolved but never got resolved_at.
    const e = caughtSync(() => M.normalizeStepCategory('risolto', 'step "done"'))
    expect(e.extensions['code']).toBe('BAD_USER_INPUT')
    expect(e.extensions['allowedCategories']).toContain('active')
  })

  it('assertTransitionTrigger: an invented trigger is refused (the edge would never fire)', () => {
    expect(M.assertTransitionTrigger(undefined, 'x')).toBeNull()
    expect(M.assertTransitionTrigger(' timer ', 'x')).toBe('timer')
    const e = caughtSync(() => M.assertTransitionTrigger('whenever', 'tr-1'))
    expect(e.extensions['allowedTriggers']).toEqual(['manual', 'automatic', 'timer', 'sla_breach'])
  })

  it('assertTransitionCondition: a typo is refused (the engine would block the edge forever), empty clears it', () => {
    expect(M.assertTransitionCondition('', 'x')).toBeNull()
    expect(M.assertTransitionCondition('all_tasks_complete', 'x')).toBe('all_tasks_complete')
    const e = caughtSync(() => M.assertTransitionCondition('all_assessment_complete', 'tr-1'))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.badCondition' })
  })

  it('normalizeStepPurpose: an invented purpose is refused with the allowed list', () => {
    const e = caughtSync(() => M.normalizeStepPurpose('approvals', 'step "x"'))
    expect(e.extensions).toMatchObject({ code: 'BAD_USER_INPUT', purpose: 'approvals' })
    expect(e.extensions['allowedPurposes']).toContain('approval')
  })

  it('customizedParams stamps who customised the definition and when', () => {
    const p = M.customizedParams(ctx)
    expect(p.customizedBy).toBe('u-1')
    expect(Number.isNaN(Date.parse(p.customizedAt))).toBe(false)
  })
})

// ── updateWorkflowStep ────────────────────────────────────────────────────────

const stepNode = { properties: { id: 's-1', name: 'triage', label: 'Triage', type: 'standard', enter_actions: '[]', purpose: 'approval' } }

describe('updateWorkflowStep', () => {
  it('returns the stored step and invalidates the cache of the definition\'s ticket type', async () => {
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'incident' }))
    const out = await M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'triage', label: 'Triage' }, ctx)
    expect(out).toMatchObject({ id: 's-1', name: 'triage', enterActions: '[]', exitActions: null, purpose: 'approval' })
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('t-1', 'incident')
    const w = callOf('CASE WHEN $purposeGiven')!
    expect(w.params).toMatchObject({ tenantId: 't-1', definitionId: 'd-1', purposeGiven: false, customizedBy: 'u-1' })
    // No purpose sent: the approval/window guards must not run (they would read other definitions' data).
    expect(callOf('s.purpose IN $windowPurposes')).toBeUndefined()
    expect(assertDefinitionDeadlines).not.toHaveBeenCalled()
  })

  it('a step that is not in this definition of this tenant is a NotFound, not a silent success', async () => {
    const e = await caught(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'ghost', label: 'X' }, ctx))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('update_field actions are checked against the metamodel of the definition\'s ticket type', async () => {
    const enterActions = JSON.stringify([{ type: 'update_field', params: { field: 'impact', value: 'medium' } }])
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    const e = await caught(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'triage', label: 'T', enterActions }, ctx))
    expect(e.message).toContain('"medium" is not a value of the field "impact"')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('update_field on a definition that does not exist in the tenant is a NotFound', async () => {
    const exitActions = JSON.stringify([{ type: 'update_field', params: { field: 'impact', value: 'low' } }])
    const e = await caught(M.updateWorkflowStep(null, { definitionId: 'd-x', stepName: 'triage', label: 'T', exitActions }, ctx))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('a valid update_field passes and the write happens', async () => {
    const enterActions = JSON.stringify([{ type: 'update_field', params: { field: 'impact', value: 'high' } }, { type: 'publish_event' }])
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'incident' }))
    await expect(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'triage', label: 'T', enterActions }, ctx)).resolves.toBeTruthy()
  })

  it('replacing the purpose of the last approval step of a change workflow is refused', async () => {
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 1 }))
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'change' }))
    on("{purpose: 'approval'}", rows({ definitionId: 'd-1', approvalSteps: 0 }))
    const e = await caught(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'approve', label: 'A', purpose: 'review' }, ctx))
    expect(e.extensions['code']).toBe('CONFLICT')
    // Only the types that still need approval are named: those are the ones left with nowhere to go.
    expect(e.extensions['changeTypesRequiringApproval']).toEqual(['normal'])
  })

  it('if every change type is pre-approved, no approval step is required', async () => {
    policy.preApproved = ['standard', 'normal']
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 1 }))
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'change' }))
    on("{purpose: 'approval'}", rows({ definitionId: 'd-1', approvalSteps: 0 }))
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 1 }))
    await expect(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'approve', label: 'A', purpose: '' }, ctx)).resolves.toBeTruthy()
    // A new purpose may protect a deadline's target step: deadlines are re-checked.
    expect(assertDefinitionDeadlines).toHaveBeenCalledOnce()
  })

  it('removing the last release-window purpose is refused (the approval gate would switch off)', async () => {
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 1 }))
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'change' }))
    on("{purpose: 'approval'}", rows({ definitionId: 'd-1', approvalSteps: 1 }))
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 0 }))
    const e = await caught(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'deploy', label: 'D', purpose: '' }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.noWindowPurpose' })
  })

  it('a change workflow that never had a window step is not blocked by the window rule', async () => {
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 0 }))
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'change' }))
    on("{purpose: 'approval'}", rows({ definitionId: 'd-1', approvalSteps: 1 }))
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 0 }))
    await expect(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'x', label: 'X', purpose: 'triage' }, ctx)).resolves.toBeTruthy()
  })

  it('outside the change workflow the purpose guards find no row and let the write through', async () => {
    on('CASE WHEN $purposeGiven', rows({ s: stepNode, entityType: 'incident' }))
    await expect(M.updateWorkflowStep(null, { definitionId: 'd-1', stepName: 'x', label: 'X', purpose: '' }, ctx)).resolves.toBeTruthy()
  })
})

// ── Transitions of the designer ───────────────────────────────────────────────

describe('updateWorkflowTransition', () => {
  const wdRow = () => rows({ wd: { properties: { id: 'd-1', name: 'Inc', entity_type: 'incident', version: 3, active: true } }, steps: [] })

  it('a field present as null clears it, an absent field is left alone (M-9)', async () => {
    on('CASE WHEN $labelGiven', rows({ id: 'tr-1' }))
    on('RETURN wd, collect(s) AS steps', wdRow())
    const out = await M.updateWorkflowTransition(null, {
      definitionId: 'd-1', transitionId: 'tr-1',
      input: { requiresInput: false, condition: null, trigger: 'timer', timerHours: 4 },
    }, ctx)
    const p = callOf('CASE WHEN $labelGiven')!.params
    expect(p).toMatchObject({
      tenantId: 't-1', definitionId: 'd-1', conditionGiven: true, condition: null,
      triggerGiven: true, trigger: 'timer', timerHoursGiven: true, timerHours: 4,
      labelGiven: false, inputFieldGiven: false,
    })
    expect(out).toMatchObject({ id: 'd-1', entityType: 'incident', version: 3 })
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('t-1', 'incident')
  })

  it('a null label is not a "clear": an edge without a label could not be clicked', async () => {
    on('CASE WHEN $labelGiven', rows({ id: 'tr-1' }))
    on('RETURN wd, collect(s) AS steps', wdRow())
    await M.updateWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-1', input: { requiresInput: true, label: null } }, ctx)
    expect(callOf('CASE WHEN $labelGiven')!.params['labelGiven']).toBe(false)
    calls.length = 0
    on('CASE WHEN $labelGiven', rows({ id: 'tr-1' }))
    on('RETURN wd, collect(s) AS steps', wdRow())
    await M.updateWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-1', input: { requiresInput: true, label: 'Go' } }, ctx)
    expect(callOf('CASE WHEN $labelGiven')!.params['labelGiven']).toBe(true)
  })

  it('a transition of another definition is a NotFound and nothing is re-read (B-26)', async () => {
    const e = await caught(M.updateWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-9', input: { requiresInput: false } }, ctx))
    expect(e.message).toContain('WorkflowTransition tr-9 not found')
    expect(callOf('RETURN wd, collect(s) AS steps')).toBeUndefined()
  })

  it('a definition without steps on re-read is a NotFound', async () => {
    on('CASE WHEN $labelGiven', rows({ id: 'tr-1' }))
    const e = await caught(M.updateWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-1', input: { requiresInput: false } }, ctx))
    expect(e.message).toBe('WorkflowDefinition not found')
  })

  it('an invalid condition is refused before any write', async () => {
    await caught(M.updateWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-1', input: { requiresInput: false, condition: 'nope' } }, ctx))
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})

describe('addWorkflowTransition', () => {
  it('creates a manual edge with its label and returns the drawn handles', async () => {
    on('CREATE (from)-[tr:TRANSITIONS_TO', rows({
      tr: { properties: { trigger: 'manual', label: 'Triage', source_handle: 'r', target_handle: null } },
      fromStep: 'new', toStep: 'triage', entityType: 'incident',
    }))
    const out = await M.addWorkflowTransition(null, { definitionId: 'd-1', fromStepName: 'new', toStepName: 'triage', label: '  Triage ', sourceHandle: 'r' }, ctx)
    expect(out).toMatchObject({ fromStepName: 'new', toStepName: 'triage', trigger: 'manual', label: 'Triage', sourceHandle: 'r', targetHandle: null, requiresInput: false })
    expect(typeof out.id).toBe('string')
    const p = callOf('CREATE (from)-[tr:TRANSITIONS_TO')!.params
    expect(p).toMatchObject({ tenantId: 't-1', trigger: 'manual', label: 'Triage', targetHandle: null })
    expect(p['id']).toBe(out.id)
  })

  // Tour of 23 Sep 2026: a new arrow was stored with `label: ''` (what the
  // designer sent) or with a fixed English «New transition»: a blank or
  // foreign button on every ticket.
  it.each([undefined, null, '', '   '])('a manual edge without a label (%j) is refused, and nothing is written', async (label) => {
    const e = await caught(M.addWorkflowTransition(null, { definitionId: 'd-1', fromStepName: 'new', toStepName: 'triage', label }, ctx))
    expect(e.extensions['code']).toBe('BAD_USER_INPUT')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.workflow.manualTransitionNeedsLabel', params: { from: 'new', to: 'triage' } })
    expect(callOf('CREATE (from)')).toBeUndefined()
  })

  it('an edge nobody clicks (a timer) needs no label', async () => {
    on('CREATE (from)-[tr:TRANSITIONS_TO', rows({
      tr: { properties: { trigger: 'timer', label: '' } }, fromStep: 'resolved', toStep: 'closed', entityType: 'incident',
    }))
    await M.addWorkflowTransition(null, { definitionId: 'd-1', fromStepName: 'resolved', toStepName: 'closed', trigger: 'timer' }, ctx)
    expect(callOf('CREATE (from)-[tr:TRANSITIONS_TO')!.params).toMatchObject({ trigger: 'timer', label: '' })
  })

  it('an identical edge (same steps, same trigger) is refused: the engine would pick one at random (B-27)', async () => {
    on('RETURN tr.id AS id LIMIT 1', rows({ id: 'tr-old' }))
    const e = await caught(M.addWorkflowTransition(null, { definitionId: 'd-1', fromStepName: 'a', toStepName: 'b', trigger: 'timer', label: 'L' }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.duplicateTransition', params: { trigger: 'timer' } })
    expect(callOf('CREATE (from)')).toBeUndefined()
  })

  it('steps not in this definition are a NOT_FOUND, not an edge to nowhere', async () => {
    const e = await caught(M.addWorkflowTransition(null, { definitionId: 'd-1', fromStepName: 'a', toStepName: 'zz', label: 'Go on' }, ctx))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })
})

describe('removeWorkflowTransition', () => {
  it('returns false when the transition is not of this definition', async () => {
    await expect(M.removeWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-x' }, ctx)).resolves.toBe(false)
    expect(invalidateWorkflowCache).not.toHaveBeenCalled()
  })

  it('deletes, checks deadlines still have a path, and invalidates the cache', async () => {
    on('DELETE tr', rows({ deletedId: 'tr-1', entityType: 'problem' }))
    await expect(M.removeWorkflowTransition(null, { definitionId: 'd-1', transitionId: 'tr-1' }, ctx)).resolves.toBe(true)
    expect(assertDefinitionDeadlines).toHaveBeenCalledOnce()
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('t-1', 'problem')
  })
})

// ── executeWorkflowTransition ─────────────────────────────────────────────────

const TYPE_READ = 'RETURN wi.entity_type AS entityType'
const primeInstance = (entityType: string) => on(TYPE_READ, rows({ entityType }))
const run = (toStep = 'resolved', notes?: string) =>
  M.executeWorkflowTransition(null, { instanceId: 'wi-1', toStep, ...(notes ? { notes } : {}) }, ctx)
const movedTo = (over: Record<string, unknown> = {}) =>
  ({ moved: true, entityType: 'incident', entityId: 'e-1', fromStep: 'new', actionErrors: [], result: { success: true, instance: { id: 'wi-1' } }, ...over })

describe('executeWorkflowTransition — who asks, and what the answer looks like', () => {
  beforeEach(() => { pipeline.transitionTicket.mockResolvedValue(movedTo()) })

  it('an instance not of the caller\'s tenant is NOT_FOUND and nothing is asked of the pipeline', async () => {
    const e = await caught(run())
    expect(e.extensions['code']).toBe('NOT_FOUND')
    expect(callOf(TYPE_READ)!.params).toEqual({ instanceId: 'wi-1', tenantId: 't-1' })
    expect(pipeline.transitionTicket).not.toHaveBeenCalled()
  })

  it('changes must go through executeChangeTransition (approval gate, phase side effects)', async () => {
    primeInstance('change')
    const e = await caught(run())
    expect(e.extensions['code']).toBe('CONFLICT')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.workflow.changeUsesChangeTransition' })
    expect(pipeline.transitionTicket).not.toHaveBeenCalled()
  })

  it('asks the pipeline as a PERSON, with the permissions of the role, on a manual arc, with the notes', async () => {
    primeInstance('problem')
    await expect(run('resolved', 'cause found')).resolves.toEqual({ success: true, error: null, errorKey: null, errorParams: null, instance: { id: 'wi-1' }, actionErrors: null })
    expect(pipeline.transitionTicket).toHaveBeenCalledWith(mockSession, {
      tenantId: 't-1', instanceId: 'wi-1', toStep: 'resolved', notes: 'cause found', triggerType: 'manual',
      actor: { kind: 'person', userId: 'u-1', permissions: ctx.permissions },
    })
  })

  it('a guard\'s refusal is the error on the screen, with its code, key and fields', async () => {
    primeInstance('incident')
    pipeline.transitionTicket.mockResolvedValueOnce({ moved: false, refusal: {
      guard: 'named_approval', message: 'Waiting for an approval', code: 'CONFLICT', final: true,
      i18n: { key: 'errors.approval.pendingOnStep', params: { step: 'budget_approval' } }, extensions: { approvalId: 'ap-1' },
    } })
    const e = await caught(run('in_progress'))
    expect(e.message).toBe('Waiting for an approval')
    expect(e.extensions).toEqual({ code: 'CONFLICT', approvalId: 'ap-1', i18n: { key: 'errors.approval.pendingOnStep', params: { step: 'budget_approval' } } })
  })

  it('the engine\'s own no (the arc, its condition) comes back as the result, as before', async () => {
    primeInstance('incident')
    pipeline.transitionTicket.mockResolvedValueOnce({ moved: false, refusal: {
      guard: 'workflow', message: 'not allowed', code: 'CONFLICT', final: true,
      engine: { success: false, error: 'not allowed', errorI18n: { key: 'errors.workflow.transitionNotValid', params: { step: 'resolved' } } },
    } })
    await expect(run()).resolves.toEqual({
      success: false, error: 'not allowed', errorKey: 'errors.workflow.transitionNotValid', errorParams: [{ name: 'step', value: 'resolved' }],
      instance: null, actionErrors: null,
    })
    expect(auditStepEntered).not.toHaveBeenCalled()
  })

  it('a KB article gets its step-entered audit (its notify rules and fields come from the hook and the pipeline)', async () => {
    primeInstance('kb_article')
    pipeline.transitionTicket.mockResolvedValueOnce(movedTo({ entityType: 'kb_article', entityId: 'kb-1' }))
    await run('published')
    expect(auditStepEntered).toHaveBeenCalledWith(mockSession, ctx, 'kb_article', 'KBArticle', 'kb-1', 'published')
  })

  it('the step actions\' errors and the post-move errors are returned together, never thrown', async () => {
    primeInstance('kb_article')
    pipeline.transitionTicket.mockResolvedValueOnce(movedTo({ entityType: 'kb_article', entityId: 'kb-1', actionErrors: ['engine: boom', 'on_enter_fields: corrupt'], result: { success: true } }))
    vi.mocked(auditStepEntered).mockRejectedValueOnce('plain string failure')
    const out = await run('published')
    expect(out.actionErrors).toEqual(['engine: boom', 'on_enter_fields: corrupt', 'audit step entered: plain string failure'])
    expect(out.instance).toBeNull()
  })
})

// ── saveWorkflowChanges ───────────────────────────────────────────────────────

describe('saveWorkflowChanges', () => {
  const VERSION = 'RETURN wd.version AS version'
  const BUMP = /SET wd\.version\s+= wd\.version \+ 1/
  const wdSaved = (version = 5) => rows({ wd: { properties: { id: 'd-1', name: 'Inc', entity_type: 'incident', version, active: true } } })
  const base = { definitionId: 'd-1', transitions: [], positions: [] }

  it('saves transitions, steps and positions in one transaction and bumps the version', async () => {
    on(VERSION, rows({ version: 4 }))
    on(BUMP, wdSaved(5))
    on('collect(s) AS steps', rows({ steps: [{ properties: { id: 's-1', name: 'new', label: 'New', type: 'start' } }] }))
    const out = await M.saveWorkflowChanges(null, {
      ...base, expectedVersion: 4,
      transitions: [{ transitionId: 'tr-1', requiresInput: false, trigger: 'manual', condition: '' }],
      positions: [{ stepId: 's-1', positionX: 10, positionY: 20 }],
      steps: [{ stepName: 'new', label: 'New', enterActions: null, exitActions: null, category: 'active' }],
    }, ctx)
    expect(out).toMatchObject({ id: 'd-1', version: 5, steps: [expect.objectContaining({ name: 'new' })] })
    expect(callOf('UNWIND $transitions')!.params['transitions']).toEqual([expect.objectContaining({ transitionId: 'tr-1', trigger: 'manual', condition: null })])
    expect(callOf('UNWIND $steps')!.params['steps']).toEqual([expect.objectContaining({ stepName: 'new', category: 'active', purposeGiven: false, deadlineGiven: false })])
    expect(callOf('UNWIND $positions')!.params).toMatchObject({ tenantId: 't-1', definitionId: 'd-1' })
    // No purpose and no deadline touched: guards and deadline checks do not run.
    expect(assertDefinitionDeadlines).not.toHaveBeenCalled()
    expect(callOf('SET s.is_initial = false')).toBeUndefined()
    expect(audit).toHaveBeenCalledWith(ctx, 'workflow.updated', 'WorkflowDefinition', 'd-1', { changed: true })
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('t-1', 'incident')
    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
  })

  it('a stale designer (version moved on) is refused and nothing is written', async () => {
    on(VERSION, rows({ version: 7 }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, expectedVersion: 6, transitions: [{ transitionId: 'tr-1', requiresInput: false }] }, ctx))
    expect(e.extensions).toMatchObject({ code: 'CONFLICT', currentVersion: 7, expectedVersion: 6 })
    expect(callOf('UNWIND $transitions')).toBeUndefined()
  })

  it('a version missing on the node counts as 1', async () => {
    on(VERSION, rows({ version: null }))
    on(BUMP, wdSaved(2))
    await expect(M.saveWorkflowChanges(null, { ...base, expectedVersion: 1 }, ctx)).resolves.toMatchObject({ version: 2 })
  })

  it('a definition of another tenant is a NotFound', async () => {
    const e = await caught(M.saveWorkflowChanges(null, base, ctx))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('a definition that disappears before the bump is a NotFound', async () => {
    on(VERSION, rows({ version: 1 }))
    await caught(M.saveWorkflowChanges(null, base, ctx))
    expect(audit).not.toHaveBeenCalled()
  })

  it('two initial steps are refused', async () => {
    on(VERSION, rows({ version: 1 }))
    const step = (n: string) => ({ stepName: n, label: n, enterActions: null, exitActions: null, isInitial: true })
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [step('a'), step('b')] }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.manyInitial', params: { count: 2, steps: 'a, b' } })
  })

  it('an initial step that is not in the definition is a NOT_FOUND', async () => {
    on(VERSION, rows({ version: 1 }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'x', label: 'X', enterActions: null, exitActions: null, isInitial: true }] }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.stepNotFound' })
  })

  it('an initial step that is (or stays) terminal is refused: every ticket would be born closed (B-8)', async () => {
    on(VERSION, rows({ version: 1 }))
    on('AS terminal', rows({ terminal: true }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'closed', label: 'C', enterActions: null, exitActions: null, isInitial: true }] }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.initialAndTerminal' })
    // Clearing «terminal» in the same save makes it acceptable.
    calls.length = 0
    on(VERSION, rows({ version: 1 }))
    on('AS terminal', rows({ terminal: true }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'closed', label: 'C', enterActions: null, exitActions: null, isInitial: true, isTerminal: false }] }, ctx)
    // The other steps are demoted so there is at most one initial step.
    expect(callOf('SET s.is_initial = false')!.params).toMatchObject({ keep: 'closed', tenantId: 't-1' })
  })

  // Review of 23 Sep 2026: unticking the only initial step was saved, and the next ticket failed.
  it('unticking the only initial step is refused; with another initial one left it is saved', async () => {
    on(VERSION, rows({ version: 1 }))
    on("WHERE coalesce(s.is_initial, s.type = 'start')", rows({ definitionId: 'd-1', n: 0 }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'new', label: 'N', enterActions: null, exitActions: null, isInitial: false }] }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.noInitialStep' })
    calls.length = 0
    on(VERSION, rows({ version: 1 }))
    on("WHERE coalesce(s.is_initial, s.type = 'start')", rows({ definitionId: 'd-1', n: 1 }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'new', label: 'N', enterActions: null, exitActions: null, isInitial: false }] }, ctx)
  })

  it('a timed wait\'s delay is validated before the save and written only on a timed wait', async () => {
    const bad = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'w', label: 'W', enterActions: null, exitActions: null, timerDelayMinutes: 0 }] }, ctx))
    expect(bad.extensions['i18n']).toMatchObject({ key: 'errors.workflow.timerDelayRequired' })
    on(VERSION, rows({ version: 1 }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'w', label: 'W', enterActions: null, exitActions: null, timerDelayMinutes: 45 }] }, ctx)
    const write = callOf('s.timer_delay_minutes')!
    expect(write.cypher).toContain("CASE WHEN st.timerDelayMinutes IS NOT NULL AND s.type = 'timer_wait' THEN st.timerDelayMinutes ELSE s.timer_delay_minutes END")
    expect((write.params['steps'] as Array<Record<string, unknown>>)[0]).toMatchObject({ timerDelayMinutes: 45 })
  })

  it('a purpose change runs the change-workflow guards and the deadline check', async () => {
    on(VERSION, rows({ version: 1 }))
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 1 }))
    on("{purpose: 'approval'}", rows({ definitionId: 'd-1', approvalSteps: 1 }))
    on('s.purpose IN $windowPurposes', rows({ definitionId: 'd-1', n: 0 }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'deploy', label: 'D', enterActions: null, exitActions: null, purpose: 'review' }] }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.noWindowPurpose' })
    expect(callOf(BUMP)).toBeUndefined()
  })

  it('a purpose change that keeps the guards satisfied re-checks deadlines', async () => {
    on(VERSION, rows({ version: 1 }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'x', label: 'X', enterActions: null, exitActions: null, purpose: 'triage' }] }, ctx)
    expect(callOf('UNWIND $steps')!.params['steps']).toEqual([expect.objectContaining({ purposeGiven: true, purpose: 'triage' })])
    expect(assertDefinitionDeadlines).toHaveBeenCalledOnce()
  })

  it('a deadline is stored normalised with its calendar, and its fields are checked against the metamodel', async () => {
    const deadline = JSON.stringify({ after: 2, unit: 'days', calendar_id: 'cal-1', to_step: 'closed', set_fields: [{ field: 'impact', value: 'low' }] })
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    on(VERSION, rows({ version: 1 }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'waiting', label: '', enterActions: null, exitActions: null, deadline }] }, ctx)
    const row = (callOf('UNWIND $steps')!.params['steps'] as Array<Record<string, unknown>>)[0]!
    expect(row).toMatchObject({ deadlineGiven: true, deadlineCalendarId: 'cal-1' })
    expect(JSON.parse(String(row['deadline']))).toMatchObject({ to_step: 'closed', after: 2 })
    // The parsed object is only for the checks: it is not sent to Cypher.
    expect(row).not.toHaveProperty('parsedDeadline')
    expect(assertDefinitionDeadlines).toHaveBeenCalledOnce()
  })

  it('a deadline setting a value outside the vocabulary is refused before the transaction', async () => {
    const deadline = JSON.stringify({ after: 2, unit: 'hours', to_step: 'closed', set_fields: [{ field: 'impact', value: 'huge' }] })
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    const e = await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 'waiting', label: 'Waiting', enterActions: null, exitActions: null, deadline }] }, ctx))
    expect(e.message).toContain('deadline of step "Waiting"')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('an update_field on exit actions is checked too, and an empty deadline clears it', async () => {
    const exitActions = JSON.stringify([{ type: 'update_field', params: { field: 'impact', value: 'high' } }])
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    on(VERSION, rows({ version: 1 }))
    on(BUMP, wdSaved())
    await M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 's', label: 'S', enterActions: null, exitActions, deadline: '' }] }, ctx)
    expect(callOf('UNWIND $steps')!.params['steps']).toEqual([expect.objectContaining({ deadlineGiven: true, deadline: null, deadlineCalendarId: null })])
  })

  it('only the steps that carry update_field are checked; the others pass through untouched', async () => {
    const enterActions = JSON.stringify([{ type: 'update_field', params: { field: 'impact', value: 'nope' } }])
    on(/RETURN wd\.entity_type AS entityType$/, rows({ entityType: 'incident' }))
    const e = await caught(M.saveWorkflowChanges(null, {
      ...base,
      steps: [
        { stepName: 'plain', label: 'P', enterActions: '[{"type":"publish_event"}]', exitActions: null },
        { stepName: 'writes', label: 'W', enterActions, exitActions: null },
      ],
    }, ctx))
    // The error names the step that is wrong, not the first step of the list.
    expect(e.message).toContain('enter_actions of step "writes"[0]')
  })

  it('invalid steps and transitions are refused before any session is opened', async () => {
    await caught(M.saveWorkflowChanges(null, { ...base, steps: [{ stepName: 's', label: 'S', enterActions: null, exitActions: null, category: 'risolto' }] }, ctx))
    await caught(M.saveWorkflowChanges(null, { ...base, transitions: [{ transitionId: 't', requiresInput: false, trigger: 'nope' }] }, ctx))
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })

  it('no steps on re-read maps to an empty list', async () => {
    on(VERSION, rows({ version: 1 }))
    on(BUMP, wdSaved())
    on('collect(s) AS steps', { records: [] })
    await expect(M.saveWorkflowChanges(null, base, ctx)).resolves.toMatchObject({ steps: [] })
  })
})

// ── duplicate / activate ──────────────────────────────────────────────────────

describe('duplicateWorkflowDefinition', () => {
  const SRC = 'src.entity_type AS entityType, src.name AS name'
  const TAKEN = 'entity_type: $entityType, name: $name'
  const OUT = 'properties(wd) AS props, collect(s) AS steps'

  it('requires config.workflow', async () => {
    const e = await caught(M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: 'Copy' }, noPerms))
    expect(e.extensions['code']).toBe('FORBIDDEN')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('a blank name is refused', async () => {
    const e = await caught(M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: '   ' }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.copyNameRequired' })
  })

  it('a source of another tenant is a NotFound', async () => {
    const e = await caught(M.duplicateWorkflowDefinition(null, { definitionId: 'd-x', name: 'Copy' }, ctx))
    expect(e.message).toBe('WorkflowDefinition d-x not found')
  })

  it('a name already used for that ticket type is refused (the seed looks definitions up by name)', async () => {
    on(SRC, rows({ entityType: 'incident', name: 'Inc' }))
    on(TAKEN, rows({ id: 'd-2' }))
    const e = await caught(M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: ' Inc ' }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.copyNameTaken', params: { name: 'Inc', entityType: 'incident' } })
    expect(callOf('CREATE (dst:WorkflowDefinition)')).toBeUndefined()
  })

  it('copies definition, steps and transitions under a new id, inactive, and removes the temporary link', async () => {
    on(SRC, rows({ entityType: 'request', name: 'Req' }))
    on(OUT, rows({ props: { id: 'new', name: 'Laptop', entity_type: 'request', category: 'hw', version: 1, active: false }, steps: null }))
    const out = await M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: ' Laptop ', category: ' hw ' }, ctx)
    expect(out).toMatchObject({ name: 'Laptop', category: 'hw', active: false, steps: [] })
    const create = callOf('CREATE (dst:WorkflowDefinition)')!
    expect(create.params).toMatchObject({ tenantId: 't-1', name: 'Laptop', category: 'hw', userId: 'u-1' })
    const newId = create.params['newId']
    for (const needle of ['CREATE (ns:WorkflowStep)', 'CREATE (a)-[nt:TRANSITIONS_TO]->(b)', 'REMOVE s.copied_from']) {
      expect(callOf(needle)!.params).toMatchObject({ newId, tenantId: 't-1' })
    }
    expect(audit).toHaveBeenCalledWith(ctx, 'workflow.duplicated', 'WorkflowDefinition', newId, { copiedFrom: 'd-1', name: 'Laptop', category: 'hw' })
    expect(invalidateWorkflowCache).toHaveBeenCalledWith('t-1', 'request')
  })

  it('a blank category means "no category"', async () => {
    on(SRC, rows({ entityType: 'request', name: 'Req' }))
    on(OUT, rows({ props: { id: 'new', name: 'X' }, steps: [] }))
    await M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: 'X', category: '  ' }, ctx)
    expect(callOf('CREATE (dst:WorkflowDefinition)')!.params['category']).toBeNull()
  })

  // Owner's decision, review of 23 Sep 2026: a catalog item's copy is catalog-only, never the generic fallback.
  it('a copy made for the catalog is marked catalog-only', async () => {
    on(SRC, rows({ entityType: 'request', name: 'Req' }))
    on(OUT, rows({ props: { id: 'new', name: 'X', catalog_only: true }, steps: [] }))
    const out = await M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: 'X', catalogOnly: true }, ctx)
    expect(callOf('CREATE (dst:WorkflowDefinition)')!.params['catalogOnly']).toBe(true)
    expect(callOf('CREATE (dst:WorkflowDefinition)')!.cypher).toContain('catalog_only: $catalogOnly')
    expect(out).toMatchObject({ catalogOnly: true })
  })

  it('a copy made anywhere else is not catalog-only', async () => {
    on(SRC, rows({ entityType: 'request', name: 'Req' }))
    on(OUT, rows({ props: { id: 'new', name: 'Y' }, steps: [] }))
    const out = await M.duplicateWorkflowDefinition(null, { definitionId: 'd-1', name: 'Y' }, ctx)
    expect(callOf('CREATE (dst:WorkflowDefinition)')!.params['catalogOnly']).toBe(false)
    expect(out).toMatchObject({ catalogOnly: false })
  })
})

describe('setWorkflowDefinitionActive', () => {
  const FIND = 'wd.category AS category, wd.active AS active'
  const OTHERS = 'count(wd) AS n'
  const WRITE = 'SET wd.active = $active'
  const written = () => rows({ props: { id: 'd-1', name: 'Inc', entity_type: 'incident', active: false }, steps: null })

  it('requires config.workflow', async () => {
    const e = await caught(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: true }, noPerms))
    expect(e.extensions['code']).toBe('FORBIDDEN')
  })

  it('a definition of another tenant is a NotFound', async () => {
    const e = await caught(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: true }, ctx))
    expect(e.extensions['code']).toBe('NOT_FOUND')
  })

  it('switching off the last active uncategorised definition is refused', async () => {
    on(FIND, rows({ entityType: 'incident', name: 'Inc', category: null, active: true }))
    on(OTHERS, rows({ n: 0 }))
    const e = await caught(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: false }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.lastActiveDefinition', params: { name: 'Inc', entityType: 'incident' } })
    expect(callOf(WRITE)).toBeUndefined()
  })

  it('switching off is fine when another uncategorised definition stays active', async () => {
    on(FIND, rows({ entityType: 'incident', name: 'Inc', category: null, active: true }))
    on(OTHERS, rows({ n: 1 }))
    on(WRITE, written())
    await expect(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: false }, ctx)).resolves.toMatchObject({ steps: [] })
    expect(audit).toHaveBeenCalledWith(ctx, 'workflow.deactivated', 'WorkflowDefinition', 'd-1')
  })

  it('a missing count reads as zero others (refused, not allowed)', async () => {
    on(FIND, rows({ entityType: 'incident', name: 'Inc', category: null, active: true }))
    await caught(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: false }, ctx))
  })

  // Review of 23 Sep 2026: switched off, every request of the catalog items using it failed at creation.
  it('switching off a workflow that catalog items use is refused, naming them', async () => {
    on(FIND, rows({ entityType: 'service_request', name: 'Laptop flow', category: 'hardware', active: true }))
    on('MATCH (i:ServiceCatalogItem', rows({ name: 'New laptop' }, { name: 'Laptop repair' }))
    const e = await caught(M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: false }, ctx))
    expect(e.extensions['i18n']).toMatchObject({ key: 'errors.workflow.usedByCatalogItems', params: { name: 'Laptop flow', items: 'New laptop, Laptop repair' } })
    expect(callOf('MATCH (i:ServiceCatalogItem')!.params).toEqual({ tenantId: 't-1', definitionId: 'd-1' })
    expect(callOf(WRITE)).toBeUndefined()
  })

  it('a categorised definition can be switched off without the fallback check; activation is audited', async () => {
    on(FIND, rows({ entityType: 'incident', name: 'Inc', category: 'security', active: true }))
    on(WRITE, written())
    await M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: false }, ctx)
    expect(callOf(OTHERS)).toBeUndefined()
    on(FIND, rows({ entityType: 'incident', name: 'Inc', category: null, active: false }))
    on(WRITE, rows({ props: { id: 'd-1' }, steps: [] }))
    await M.setWorkflowDefinitionActive(null, { definitionId: 'd-1', active: true }, ctx)
    expect(callOf(WRITE)!.params).toMatchObject({ tenantId: 't-1', active: false })
    expect(audit).toHaveBeenLastCalledWith(ctx, 'workflow.activated', 'WorkflowDefinition', 'd-1')
  })
})
