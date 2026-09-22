/**
 * Workflow reads bound to a ticket: the ones workflowQueries.test.ts does not reach.
 *
 * Why these behaviours matter:
 *  - the detail page of an incident, a change and a service request reads its
 *    instance, its available moves and its history from these field resolvers:
 *    a ticket WITH a workflow must show it, one without must answer
 *    null / [] rather than crash the whole page;
 *  - every one of them must carry the tenant: a ticket id alone would let one
 *    customer's page read another's workflow;
 *  - opening a definition by id (the designer) must load that definition's
 *    transitions, inside the tenant, and an unknown id is null, not an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txRun = vi.fn()
// No importOriginal: the real ci-utils opens a Neo4j driver at import.
vi.mock('../ci-utils.js', () => ({
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
}))
const getAvailableTransitions = vi.fn()
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { getAvailableTransitions: (...a: unknown[]) => getAvailableTransitions(...a) },
}))
const loadTransitionRows = vi.fn()
const mapWorkflowDefinition = vi.fn((wd: Record<string, unknown>, steps: unknown[], transitions: unknown[]) => ({ id: wd['id'], steps, transitions }))
vi.mock('../workflowMapping.js', () => ({
  loadTransitionRows: (...a: unknown[]) => loadTransitionRows(...a),
  mapWorkflowDefinition: (...a: unknown[]) => mapWorkflowDefinition(...(a as [Record<string, unknown>, unknown[], unknown[]])),
}))
const requestApprovalWouldBeSkipped = vi.fn()
vi.mock('../../../lib/requestApproval.js', () => ({
  requestApprovalWouldBeSkipped: (...a: unknown[]) => requestApprovalWouldBeSkipped(...a),
}))

const q = await import('../workflowQueries.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() } as never
const rec = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] ?? null })
const node = (props: Record<string, unknown>) => ({ properties: props })
const WI = { id: 'wi1', current_step: 'triage', status: 'active', created_at: 'a', updated_at: 'b' }
const EXEC = { id: 'e1', step_name: 'new', entered_at: '1', triggered_by: 'u', trigger_type: 'manual' }

beforeEach(() => {
  vi.clearAllMocks()
  txRun.mockResolvedValue({ records: [] })
  loadTransitionRows.mockResolvedValue([])
  getAvailableTransitions.mockResolvedValue([])
  requestApprovalWouldBeSkipped.mockResolvedValue(false)
})

describe('incidentWorkflow (query)', () => {
  it('maps the instance of an incident that has one', async () => {
    txRun.mockResolvedValue({ records: [rec({ wi: node(WI) })] })
    expect(await q.incidentWorkflow(null, { incidentId: 'i1' }, ctx)).toEqual({ id: 'wi1', currentStep: 'triage', status: 'active', createdAt: 'a', updatedAt: 'b' })
    expect(txRun.mock.calls[0]![1]).toEqual({ incidentId: 'i1', tenantId: 't1' })
  })
})

describe('field resolvers with a workflow', () => {
  const kinds = [
    ['incident', q.incidentWorkflowInstance, q.incidentAvailableTransitionsField, q.incidentWorkflowHistoryField],
    ['change', q.changeWorkflowInstance, q.changeAvailableTransitionsField, q.changeWorkflowHistoryField],
  ] as const

  it.each(kinds)('%s: instance, moves from the engine, and history — all scoped to the tenant', async (_k, instance, moves, history) => {
    txRun.mockResolvedValueOnce({ records: [rec({ wi: node(WI) })] })
    expect(await instance({ id: 'x1' }, null, ctx)).toMatchObject({ id: 'wi1', currentStep: 'triage' })

    txRun.mockResolvedValueOnce({ records: [rec({ instanceId: 'wi1' })] })
    getAvailableTransitions.mockResolvedValueOnce([{ toStep: 'closed' }])
    expect(await moves({ id: 'x1' }, null, ctx)).toEqual([{ toStep: 'closed' }])
    expect(getAvailableTransitions.mock.calls[0]![1]).toBe('wi1')

    txRun.mockResolvedValueOnce({ records: [rec({ exec: node(EXEC) }), rec({ exec: node({ ...EXEC, id: 'e2', duration_ms: 10 }) })] })
    const h = await history({ id: 'x1' }, null, ctx) as Array<Record<string, unknown>>
    expect(h.map((e) => e['id'])).toEqual(['e1', 'e2'])
    expect(String(txRun.mock.calls[2]![0])).toContain('ORDER BY exec.entered_at ASC')

    for (const [cypher, params] of txRun.mock.calls as Array<[string, Record<string, unknown>]>) {
      expect(cypher).toContain('tenant_id: $tenantId')
      expect(params).toEqual({ id: 'x1', tenantId: 't1' })
    }
  })

  it.each(kinds)('%s without a workflow: null instance, no moves (engine not asked), empty history', async (_k, instance, moves, history) => {
    expect(await instance({ id: 'x1' }, null, ctx)).toBeNull()
    expect(await moves({ id: 'x1' }, null, ctx)).toEqual([])
    expect(await history({ id: 'x1' }, null, ctx)).toEqual([])
    expect(getAvailableTransitions).not.toHaveBeenCalled()
  })

  it('service request with a workflow: the instance is mapped', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ wi: node(WI) })] })
    expect(await q.serviceRequestWorkflowInstance({ id: 'r1' }, null, ctx)).toMatchObject({ id: 'wi1' })
  })

  it('service request without a workflow: no moves, and neither the engine nor the approval rule is asked', async () => {
    expect(await q.serviceRequestAvailableTransitionsField({ id: 'r1' }, null, ctx)).toEqual([])
    expect(getAvailableTransitions).not.toHaveBeenCalled()
    expect(requestApprovalWouldBeSkipped).not.toHaveBeenCalled()
  })

  it('the approval rule is asked for this tenant and this instance', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ instanceId: 'wi7' })] })
    getAvailableTransitions.mockResolvedValueOnce([{ toStep: 'fulfil' }])
    await q.serviceRequestAvailableTransitionsField({ id: 'r1' }, null, ctx)
    expect(requestApprovalWouldBeSkipped.mock.calls[0]!.slice(1)).toEqual(['t1', 'wi7', 'fulfil', { byPerson: true }])
  })
})

describe('workflowDefinitionById', () => {
  it('loads the definition with its steps and ITS transitions, inside the tenant', async () => {
    const steps = [node({ name: 'new' })]
    txRun.mockResolvedValueOnce({ records: [rec({ wd: node({ id: 'wd9', name: 'Incident' }), steps })] })
    loadTransitionRows.mockResolvedValueOnce([{ from: 'new', to: 'closed' }])
    const out = await q.workflowDefinitionById(null, { id: 'wd9' }, ctx)
    expect(out).toEqual({ id: 'wd9', steps, transitions: [{ from: 'new', to: 'closed' }] })
    expect(txRun.mock.calls[0]![1]).toEqual({ id: 'wd9', tenantId: 't1' })
    expect(loadTransitionRows.mock.calls[0]!.slice(1)).toEqual(['wd9', 't1'])
  })
})

describe('workflowDefinitions', () => {
  it('an entity filter is passed through; absent it is null (all entities)', async () => {
    await q.workflowDefinitions(null, { entityType: 'change' }, ctx)
    await q.workflowDefinitions(null, { entityType: null }, ctx)
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['entityType']).toBe('change')
    expect((txRun.mock.calls[1]![1] as Record<string, unknown>)['entityType']).toBeNull()
  })
})

describe('workflowStepLabels', () => {
  it('localized labels are parsed and carried alongside the plain label', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ name: 'new', label: 'New', labels: JSON.stringify({ it: 'Nuovo', en: 'New' }) })] })
    const out = await q.workflowStepLabels(null, { entityType: 'incident' }, ctx) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ name: 'new', label: 'New' })
    expect(out[0]!['labels']).toBeTruthy()
    expect(txRun.mock.calls[0]![1]).toEqual({ tenantId: 't1', entityType: 'incident' })
  })
})
