/**
 * THE INCIDENT WORKFLOW AS DRIVEN BY MONITORING.
 *
 * When an alarm clears or comes back, Event Management moves the incident
 * through the tenant's own workflow as the `monitoring` actor. What these
 * tests pin, and what a user would see if they regressed:
 *  - `incidentTerminalSteps` answers with a (possibly empty) list and never
 *    throws: throwing here once locked a tenant out of deleting its own CIs;
 *  - a refused transition is an ERROR (the job retries and stays visible),
 *    not a silently half-closed incident;
 *  - a reopen targets a step by CATEGORY and only through a transition the
 *    engine actually offers; otherwise it fails naming candidates/available;
 *  - every query is scoped by tenant_id;
 *  - the transition comment uses the step label, not the internal name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let steps: Array<Record<string, unknown>> = []
vi.mock('../../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn(async () => steps) }))
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../../lib/logger.js', () => {
  const error = vi.fn()
  return { logger: { child: () => ({ error, warn: vi.fn(), info: vi.fn() }) }, __error: error }
})

const transition = vi.fn()
const getAvailableTransitions = vi.fn()
const addIncidentComment = vi.fn()
vi.mock('../deps.js', () => ({
  engine: async () => ({ transition, getAvailableTransitions }),
  incidents: async () => ({ addIncidentComment }),
}))
vi.mock('../../../lib/systemText.js', () => ({
  systemText: vi.fn(async (_t: string, key: string, vars: Record<string, string>) => `${key}|${vars['step']}|${vars['notes']}`),
}))
vi.mock('../../../lib/stepEvent.js', () => ({
  loadStepFacts: vi.fn(async (_s: unknown, _t: string, _e: string, step: string) => ({ step_label: `Label of ${step}` })),
}))

const wf = await import('../incidentWorkflow.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const loggerMod = await import('../../../lib/logger.js') as unknown as { __error: ReturnType<typeof vi.fn> }

const step = (name: string, category: string | null, extra: Record<string, unknown> = {}) =>
  ({ name, label: null, isInitial: false, isTerminal: false, isOpen: true, category, purpose: null, stepOrder: null, ...extra })

const session = {} as never

beforeEach(() => {
  vi.clearAllMocks()
  steps = []
})

describe('incidentTerminalSteps', () => {
  it('returns only the terminal steps', async () => {
    steps = [step('new', 'active', { isInitial: true }), step('closed', 'closed', { isTerminal: true }), step('cancelled', 'closed', { isTerminal: true })]
    await expect(wf.incidentTerminalSteps(session, 't1')).resolves.toEqual(['closed', 'cancelled'])
  })

  it('a workflow without a "resolved" step is not an error here, and no workflow is an empty list', async () => {
    steps = []
    await expect(wf.incidentTerminalSteps(session, 't1')).resolves.toEqual([])
  })
})

describe('incidentStepInfo: reopen targets', () => {
  it('orders reopen candidates by step_order, then name; excludes initial, terminal and other categories', async () => {
    steps = [
      step('new', 'active', { isInitial: true }),
      step('work_b', 'active', { stepOrder: 3 }),
      step('escalated', 'escalated', { stepOrder: 2 }),
      step('work_a', 'active', { stepOrder: 3 }),
      step('unordered', 'active'),
      step('pending', 'waiting', { stepOrder: 1 }),
      step('resolved', 'resolved'),
      step('closed', 'active', { isTerminal: true }),
    ]
    const info = await wf.incidentStepInfo(session, 't1')
    expect(info).toEqual({
      resolvedStep: 'resolved',
      terminalSteps: ['closed'],
      reopenSteps: ['escalated', 'work_a', 'work_b', 'unordered'],
    })
  })
})

describe('tenant-scoped reads', () => {
  const info = { resolvedStep: 'resolved', terminalSteps: ['closed'], reopenSteps: [] }

  it('findLinkedOpenIncident passes tenant and terminal steps, and returns null when nothing is open', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ incidentId: 'INC1' }).mockResolvedValueOnce(null)
    await expect(wf.findLinkedOpenIncident(session, 't1', 'e1', info)).resolves.toBe('INC1')
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toEqual({ eventId: 'e1', tenantId: 't1', terminalSteps: ['closed'] })
    await expect(wf.findLinkedOpenIncident(session, 't1', 'e1', info)).resolves.toBeNull()
  })

  it('incidentStep is scoped by tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ incidentId: 'i', instanceId: 'wi', step: 'new' })
    await expect(wf.incidentStep(session, 't9', 'i')).resolves.toEqual({ incidentId: 'i', instanceId: 'wi', step: 'new' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ incidentId: 'i', tenantId: 't9' })
  })

  it('loadDefinitionTransitions localizes the target label and keeps a null label null', async () => {
    vi.mocked(runQuery).mockResolvedValue([
      { fromStep: 'new', toStep: 'in_progress', toLabel: 'In progress', toLabels: JSON.stringify({ it: 'In lavorazione' }), trigger: 'manual', condition: null },
      { fromStep: 'new', toStep: 'x', toLabel: null, toLabels: null, trigger: 'automatic', condition: 'c' },
    ] as never)
    const out = await wf.loadDefinitionTransitions(session, 'wi1', 't1', 'it')
    expect(out).toEqual([
      { fromStep: 'new', toStep: 'in_progress', toLabel: 'In lavorazione', trigger: 'manual', condition: null },
      { fromStep: 'new', toStep: 'x', toLabel: null, trigger: 'automatic', condition: 'c' },
    ])
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ instanceId: 'wi1', tenantId: 't1' })
  })
})

describe('runMonitoringTransition', () => {
  it('transitions as the monitoring actor and comments with the step LABEL', async () => {
    transition.mockResolvedValue({ success: true })
    await wf.runMonitoringTransition(session, 't1', 'INC1', 'wi1', 'resolved', 'automatic', 'alarm cleared', 'resolve')
    expect(transition.mock.calls[0]![1]).toMatchObject({ instanceId: 'wi1', toStepName: 'resolved', triggeredBy: 'monitoring', triggerType: 'automatic', tenantId: 't1' })
    expect(addIncidentComment).toHaveBeenCalledWith('INC1', { tenantId: 't1', userId: 'monitoring' }, 'workflow.transitionCommentNotes|Label of resolved|alarm cleared')
  })

  it('comment=false leaves no comment (intermediate steps of an auto-close)', async () => {
    transition.mockResolvedValue({ success: true })
    await wf.runMonitoringTransition(session, 't1', 'INC1', 'wi1', 'resolved', 'automatic', 'n', 'resolve', false)
    expect(addIncidentComment).not.toHaveBeenCalled()
  })

  it('a refused transition throws with the engine reason, and without one says "unknown error"', async () => {
    transition.mockResolvedValueOnce({ success: false, error: 'guard failed' })
    await expect(wf.runMonitoringTransition(session, 't1', 'INC1', 'wi1', 'resolved', 'automatic', 'n', 'resolve'))
      .rejects.toThrow('Incident INC1: resolve transition to "resolved" failed: guard failed')
    transition.mockResolvedValueOnce({ success: false })
    await expect(wf.runMonitoringTransition(session, 't1', 'INC1', 'wi1', 'resolved', 'automatic', 'n', 'resolve'))
      .rejects.toThrow(/failed: unknown error/)
    expect(addIncidentComment).not.toHaveBeenCalled()
  })

  it('step action errors are logged, not hidden, and the transition still counts', async () => {
    transition.mockResolvedValue({ success: true, actionErrors: ['sla clock failed'] })
    await wf.runMonitoringTransition(session, 't1', 'INC1', 'wi1', 'resolved', 'automatic', 'n', 'resolve')
    expect(loggerMod.__error).toHaveBeenCalledWith(expect.objectContaining({ actionErrors: ['sla clock failed'] }), expect.stringContaining('step actions failed'))
    expect(addIncidentComment).toHaveBeenCalled()
  })
})

describe('reopenIncident', () => {
  const inc = { incidentId: 'INC1', instanceId: 'wi1', step: 'resolved' }

  it('picks the first reopen candidate the engine actually offers', async () => {
    getAvailableTransitions.mockResolvedValue([{ toStep: 'closed' }, { toStep: 'work_b' }])
    transition.mockResolvedValue({ success: true })
    const info = { resolvedStep: 'resolved', terminalSteps: ['closed'], reopenSteps: ['work_a', 'work_b'] }
    await expect(wf.reopenIncident(session, 't1', inc, info, 'alarm is back')).resolves.toBe('work_b')
    expect(transition.mock.calls[0]![1]).toMatchObject({ toStepName: 'work_b', triggerType: 'manual' })
  })

  it('no transition to a working step: error naming candidates and what is available', async () => {
    getAvailableTransitions.mockResolvedValue([{ toStep: 'closed' }])
    const info = { resolvedStep: 'resolved', terminalSteps: ['closed'], reopenSteps: ['work_a'] }
    await expect(wf.reopenIncident(session, 't1', inc, info, 'n'))
      .rejects.toThrow('candidates: work_a; available: closed')
    expect(transition).not.toHaveBeenCalled()
  })

  it('with nothing on either side the message says "none" twice', async () => {
    getAvailableTransitions.mockResolvedValue([])
    const info = { resolvedStep: 'resolved', terminalSteps: [], reopenSteps: [] }
    await expect(wf.reopenIncident(session, 't1', inc, info, 'n'))
      .rejects.toThrow('candidates: none; available: none')
  })
})
