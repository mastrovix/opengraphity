/**
 * The single WorkflowDefinition / WorkflowStep / TRANSITIONS_TO → GraphQL mapping.
 *
 * It used to be copied five times with drifting fields (A-23): the designer
 * then lost handles, timers and canvas positions depending on WHICH query had
 * loaded the definition. What is worth pinning here is what the designer and
 * the runtime rely on:
 *  - transitions are read only for the definition AND the tenant asked for;
 *  - optional fields come back as `null` (never `undefined`, never a guess),
 *    numbers stored as strings/Integers come back as numbers;
 *  - a step with no explicit flags derives initial/terminal/open from its type,
 *    and explicit flags always win (a customer "end" step can stay open);
 *  - steps come back in `step_order`, unordered ones last;
 *  - corrupt localized labels fail loudly instead of disappearing.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'neo4j-driver'
import {
  loadTransitionRows, mapWorkflowStep, mapWorkflowTransition, mapWorkflowDefinition, type TransitionRow,
} from '../workflowMapping.js'

function record(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] }
}

function sessionReturning(rows: Record<string, unknown>[]) {
  const run = vi.fn(async () => ({ records: rows.map(record) }))
  const session = { executeRead: async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }) }
  return { session: session as unknown as Session, run }
}

describe('loadTransitionRows', () => {
  it('queries by definition id AND tenant, and maps every column', async () => {
    const { session, run } = sessionReturning([{
      id: 'tr-1', fromStep: 'new', toStep: 'assigned', trigger: 'assign', label: 'Assign',
      labels: '{"it":"Assegna"}', requiresInput: true, inputField: 'assignee',
      condition: 'x > 1', timerHours: 4, sourceHandle: 'right', targetHandle: 'left',
    }])
    const rows = await loadTransitionRows(session, 'def-1', 'tenant-A')
    const [cypher, params] = run.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(cypher).toContain('definition_id: $defId, tenant_id: $tenantId')
    expect(params).toEqual({ defId: 'def-1', tenantId: 'tenant-A' })
    expect(rows).toEqual([{
      id: 'tr-1', fromStep: 'new', toStep: 'assigned', trigger: 'assign', label: 'Assign',
      labels: [{ language: 'it', label: 'Assegna' }], requiresInput: true, inputField: 'assignee',
      condition: 'x > 1', timerHours: 4, sourceHandle: 'right', targetHandle: 'left',
    }])
  })

  it('absent optional columns become null, not undefined', async () => {
    const { session } = sessionReturning([{ id: 'tr-2', fromStep: 'a', toStep: 'b', trigger: 't', label: 'L', requiresInput: false }])
    const [row] = await loadTransitionRows(session, 'def-1', 'tenant-A')
    expect(row).toMatchObject({ labels: [], inputField: null, condition: null, sourceHandle: null, targetHandle: null })
  })

  it('corrupt labels JSON fails naming the transition', async () => {
    const { session } = sessionReturning([{ id: 'tr-bad', labels: '{oops' }])
    await expect(loadTransitionRows(session, 'def-1', 'tenant-A')).rejects.toThrow(/transition tr-bad: labels is not valid JSON/)
  })
})

describe('mapWorkflowStep', () => {
  it('maps a fully specified step, converting numeric fields', () => {
    expect(mapWorkflowStep({
      id: 's1', definition_id: 'def-1', name: 'triage', label: 'Triage', labels: { it: 'Smistamento' }, type: 'task',
      enter_actions: '[]', exit_actions: '[{"x":1}]', timer_delay_minutes: '30', sub_workflow_id: 'wf-2',
      is_initial: false, is_terminal: false, is_open: true, category: 'active', purpose: 'work', deadline: 'P1D',
      step_order: '2', position_x: '120', position_y: 80,
    })).toEqual({
      id: 's1', definitionId: 'def-1', name: 'triage', label: 'Triage', labels: [{ language: 'it', label: 'Smistamento' }],
      type: 'task', enterActions: '[]', exitActions: '[{"x":1}]', timerDelayMinutes: 30, subWorkflowId: 'wf-2',
      isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: 'work', deadline: 'P1D',
      order: 2, positionX: 120, positionY: 80,
    })
  })

  it('without explicit flags, start is initial and end is terminal and closed', () => {
    const start = mapWorkflowStep({ id: 's', name: 'new', type: 'start' })
    const end = mapWorkflowStep({ id: 'e', name: 'closed', type: 'end' })
    expect([start.isInitial, start.isTerminal, start.isOpen]).toEqual([true, false, true])
    expect([end.isInitial, end.isTerminal, end.isOpen]).toEqual([false, true, false])
  })

  it('explicit flags win over the type (a customer end step may stay open)', () => {
    const s = mapWorkflowStep({ id: 'e', name: 'parked', type: 'end', is_open: true, is_terminal: false })
    expect(s.isOpen).toBe(true)
    expect(s.isTerminal).toBe(false)
  })

  it('missing optional fields are null, and an unordered step sorts last (999)', () => {
    const s = mapWorkflowStep({ id: 's', name: 'x', type: 'task' })
    expect(s).toMatchObject({
      enterActions: null, exitActions: null, timerDelayMinutes: null, subWorkflowId: null,
      category: null, purpose: null, deadline: null, positionX: null, positionY: null, order: 999, labels: [],
    })
  })
})

describe('mapWorkflowTransition', () => {
  const base: TransitionRow = {
    id: 't', fromStep: 'a', toStep: 'b', trigger: 'go', label: 'Go', labels: [], requiresInput: false,
    inputField: null, condition: null, timerHours: null, sourceHandle: null, targetHandle: null,
  }

  it('renames from/to to the SDL names and converts the timer to a number', () => {
    expect(mapWorkflowTransition({ ...base, timerHours: '6' })).toMatchObject({ fromStepName: 'a', toStepName: 'b', timerHours: 6 })
  })

  it('no timer → null (not 0: zero hours would fire immediately)', () => {
    expect(mapWorkflowTransition(base).timerHours).toBeNull()
  })
})

describe('mapWorkflowDefinition', () => {
  it('sorts steps by order, maps transitions, defaults version to 1 and category to null', () => {
    const def = mapWorkflowDefinition(
      { id: 'def-1', name: 'Incident', entity_type: 'incident', active: true },
      [
        { properties: { id: 'c', name: 'closed', type: 'end' } },
        { properties: { id: 'b', name: 'work', type: 'task', step_order: 2 } },
        { properties: { id: 'a', name: 'new', type: 'start', step_order: 1 } },
      ],
      [{ id: 't', fromStep: 'new', toStep: 'work', trigger: 'go', label: 'Go', labels: [], requiresInput: false,
        inputField: null, condition: null, timerHours: null, sourceHandle: null, targetHandle: null }],
    )
    expect(def).toMatchObject({ id: 'def-1', name: 'Incident', entityType: 'incident', category: null, version: 1, active: true })
    expect(def.steps.map((s) => s.name)).toEqual(['new', 'work', 'closed'])
    expect(def.transitions[0]).toMatchObject({ fromStepName: 'new', toStepName: 'work' })
  })

  it('keeps an explicit version and category', () => {
    const def = mapWorkflowDefinition({ id: 'd', name: 'n', entity_type: 'change', version: '3', category: 'normal', active: false }, [], [])
    expect(def).toMatchObject({ version: 3, category: 'normal', active: false, steps: [], transitions: [] })
  })
})
