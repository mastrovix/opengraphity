/**
 * THE STATE OF THE WORKFLOW DESIGNER: how a workflow definition becomes the
 * steps and arrows on the canvas, and how the administrator's work waits
 * there until "Save changes".
 *
 * What the administrator relies on:
 *  - a step stands where it was left: a position not saved yet, then the one
 *    saved by the designer, then the layout of the shipped workflow, then a
 *    plain row — and the choice of layout follows the ENTITY type, never the
 *    workflow's name;
 *  - an arrow has the colour of its trigger and leaves from the side its
 *    layout (or the person who drew it) chose; a return arrow is dashed, and
 *    hides its label from the drawing only;
 *  - work saved in a panel ("saved locally") is queued once per step or
 *    arrow, survives the reloads that follow adding or removing a step, and
 *    a second save of the same step MERGES with the first;
 *  - moving a step is a change to save; the selection survives a reload as
 *    long as the element still exists.
 */
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { Edge, Node } from '@xyflow/react'
import { useWorkflowDesigner, defToWorkflowKey } from './useWorkflowDesigner'
import { TRIGGER_COLOR, INCIDENT_POSITIONS } from './WorkflowCanvas'
import type { EdgeNodeData, StepNodeData, WFStep, WFTransition, WorkflowDefinition } from './workflow-types'

const step = (id: string, name: string, over: Partial<WFStep> = {}): WFStep => ({
  id, name, label: name, type: 'standard', enterActions: null, exitActions: null, isInitial: false, isTerminal: false, ...over,
})
const transition = (id: string, from: string, to: string, over: Partial<WFTransition> = {}): WFTransition => ({
  id, fromStepName: from, toStepName: to, trigger: 'manual', label: `${from} to ${to}`,
  requiresInput: false, inputField: null, condition: null, timerHours: null, ...over,
})

function incident(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-1', name: 'Incident Management', entityType: 'incident', version: 3, active: true,
    steps: [
      step('s-new', 'new', { type: 'start', isInitial: true }),
      step('s-assigned', 'assigned'),
      step('s-progress', 'in_progress', { deadline: '{"hours":4}' }),
      step('s-escalated', 'escalated'),
      step('s-resolved', 'resolved'),
      // Saved by the designer: it wins over the shipped layout.
      step('s-closed', 'closed', { type: 'end', isTerminal: true, positionX: 1500, positionY: 40 }),
      // A step of the customer's, in no layout table.
      step('s-custom', 'vendor_wait'),
    ],
    transitions: [
      transition('t-assign', 'new', 'assigned'),
      transition('t-escalate', 'in_progress', 'escalated', { trigger: 'sla_breach' }),
      transition('t-reopen', 'resolved', 'in_progress', { label: 'Reopen' }),
      transition('t-drawn', 'assigned', 'vendor_wait', { trigger: 'automatic', sourceHandle: 'src-bottom', targetHandle: 'tgt-top' }),
      transition('t-close', 'resolved', 'closed', { trigger: 'timer', timerHours: 72 }),
    ],
    ...over,
  }
}

function designer(def: WorkflowDefinition | null = incident()) {
  return renderHook(({ d }: { d: WorkflowDefinition | null }) => useWorkflowDesigner(d), { initialProps: { d: def } })
}

type Hook = ReturnType<typeof designer>
const node = (h: Hook, id: string) => h.result.current.nodes.find((n) => n.id === id)!
const edge = (h: Hook, id: string) => h.result.current.edges.find((e) => e.id === id)!
const stepOf = (n: Node) => (n.data as StepNodeData).step
const trOf = (e: Edge) => (e.data as EdgeNodeData).transition
const click = {} as React.MouseEvent

describe('defToWorkflowKey — which layout the canvas uses', () => {
  it('follows the entity type, never the name; a type OpenGrafo does not ship takes the plain row', () => {
    expect(defToWorkflowKey(incident({ name: 'Emergency normal standard' }))).toBe('incident')
    expect(defToWorkflowKey(incident({ entityType: 'change' }))).toBe('change')
    expect(defToWorkflowKey(incident({ entityType: 'kb_article' }))).toBe('kb_article')
    expect(defToWorkflowKey(incident({ entityType: 'asset_request' }))).toBe('none')
    expect(defToWorkflowKey(incident({ entityType: 'none' }))).toBe('none')
    expect(defToWorkflowKey(null)).toBe('incident')
  })
})

describe('useWorkflowDesigner — drawing the definition', () => {
  it('without a definition there is nothing to draw', () => {
    const h = designer(null)
    expect(h.result.current.nodes).toEqual([])
    expect(h.result.current.edges).toEqual([])
    expect(h.result.current.selectedStep).toBeNull()
    expect(h.result.current.hasChanges).toBe(false)
  })

  it('a step stands where the designer saved it, else where the shipped layout puts it, else in a row', () => {
    const h = designer()
    expect(node(h, 's-new').position).toEqual(INCIDENT_POSITIONS['new'])
    expect(node(h, 's-escalated').position).toEqual(INCIDENT_POSITIONS['escalated'])
    expect(node(h, 's-closed').position).toEqual({ x: 1500, y: 40 })
    // Seventh step (index 6), in no table: the row.
    expect(node(h, 's-custom').position).toEqual({ x: 6 * 220, y: 200 })
    expect(h.result.current.nodes.map((n) => n.type)).toEqual(Array(7).fill('workflowStep'))
    expect(stepOf(node(h, 's-new')).type).toBe('start')
  })

  it('a workflow of a type OpenGrafo does not ship lays every unsaved step in a row', () => {
    const h = designer(incident({ entityType: 'asset_request' }))
    expect(h.result.current.selectedWorkflow).toBe('none')
    expect(node(h, 's-new').position).toEqual({ x: 0, y: 200 })
    expect(node(h, 's-escalated').position).toEqual({ x: 3 * 220, y: 200 })
    expect(node(h, 's-closed').position).toEqual({ x: 1500, y: 40 })
  })

  it('an arrow has the colour of its trigger and leaves from the side its layout chose, per trigger when it says so', () => {
    const h = designer()
    const assign = edge(h, 't-assign')
    expect(assign).toMatchObject({ source: 's-new', target: 's-assigned', sourceHandle: 'src-right', targetHandle: 'tgt-left', animated: false, type: 'workflowEdge' })
    expect((assign.data as EdgeNodeData).color).toBe(TRIGGER_COLOR['manual'])
    expect(trOf(assign).label).toBe('new to assigned')

    const escalate = edge(h, 't-escalate')
    expect(escalate).toMatchObject({ sourceHandle: 'src-top', targetHandle: 'tgt-bottom' })
    expect((escalate.data as EdgeNodeData).color).toBe(TRIGGER_COLOR['sla_breach'])
    expect(escalate.style).toMatchObject({ stroke: TRIGGER_COLOR['sla_breach'], strokeWidth: 2 })
  })

  it('an arrow drawn by hand keeps the sides it was drawn from; one in no table leaves right and enters left', () => {
    const h = designer()
    expect(edge(h, 't-drawn')).toMatchObject({ sourceHandle: 'src-bottom', targetHandle: 'tgt-top' })
    expect((edge(h, 't-drawn').data as EdgeNodeData).color).toBe(TRIGGER_COLOR['automatic'])
    // resolved→closed is in the table: its sides come from there.
    expect(edge(h, 't-close')).toMatchObject({ sourceHandle: 'src-right', targetHandle: 'tgt-left' })
    const custom = designer(incident({ transitions: [transition('t-x', 'vendor_wait', 'closed')] }))
    expect(edge(custom, 't-x')).toMatchObject({ sourceHandle: 'src-right', targetHandle: 'tgt-left' })
  })

  it('a return arrow is dashed, moving, and drawn without its label — which its transition keeps', () => {
    const h = designer()
    const reopen = edge(h, 't-reopen')
    expect(reopen).toMatchObject({ source: 's-resolved', target: 's-progress', animated: true, sourceHandle: 'src-left', targetHandle: 'tgt-right' })
    expect(reopen.style).toMatchObject({ strokeDasharray: '6,3', strokeWidth: 1.5 })
    // Hidden from the drawing only (tour of 23 Sep 2026): blanked in the data,
    // it reached the panel empty and was saved as '' over «Reopen».
    expect((reopen.data as EdgeNodeData).hideLabel).toBe(true)
    expect(trOf(reopen).label).toBe('Reopen')
    expect((edge(h, 't-assign').data as EdgeNodeData).hideLabel).toBeUndefined()
  })

  it('an arrow with an unknown trigger is drawn in the error colour, and the gap is logged', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = designer(incident({ transitions: [transition('t-hook', 'new', 'assigned', { trigger: 'webhook' })] }))
    expect((edge(h, 't-hook').data as EdgeNodeData).color).toBe('var(--color-danger)')
    expect(logged).toHaveBeenCalledWith('[TRIGGER_COLOR] unknown value: "webhook"')
  })

  it('an arrow naming a step that does not exist is attached to that name, not dropped', () => {
    const h = designer(incident({ transitions: [transition('t-ghost', 'gone', 'also_gone')] }))
    expect(edge(h, 't-ghost')).toMatchObject({ source: 'gone', target: 'also_gone' })
  })
})

describe('useWorkflowDesigner — selection', () => {
  it('a step click selects the step and unselects the arrows; an arrow click the reverse; the canvas clears both', () => {
    const h = designer()
    act(() => { h.result.current.handleNodeClick(click, node(h, 's-progress')) })
    expect(h.result.current.selectedStep?.name).toBe('in_progress')
    expect(h.result.current.selectedTr).toBeNull()
    expect(h.result.current.edges.every((e) => e.selected === false)).toBe(true)

    act(() => { h.result.current.handleEdgeClick(click, edge(h, 't-assign')) })
    expect(h.result.current.selectedTr?.id).toBe('t-assign')
    expect(h.result.current.selectedStep).toBeNull()
    expect(h.result.current.nodes.every((n) => n.selected === false)).toBe(true)

    act(() => { h.result.current.handlePaneClick() })
    expect(h.result.current.selectedStep).toBeNull()
    expect(h.result.current.selectedTr).toBeNull()
  })

  it('the selection survives a reload while the element exists, and is dropped when it is gone', () => {
    const h = designer()
    act(() => { h.result.current.handleNodeClick(click, node(h, 's-progress')) })
    h.rerender({ d: incident() })
    expect(h.result.current.selectedNodeId).toBe('s-progress')
    h.rerender({ d: incident({ steps: incident().steps.filter((s) => s.id !== 's-progress') }) })
    expect(h.result.current.selectedNodeId).toBeNull()

    act(() => { h.result.current.handleEdgeClick(click, edge(h, 't-assign')) })
    h.rerender({ d: incident() })
    expect(h.result.current.selectedEdgeId).toBe('t-assign')
    h.rerender({ d: incident({ transitions: [] }) })
    expect(h.result.current.selectedEdgeId).toBeNull()
  })
})

describe('useWorkflowDesigner — work waiting for "Save changes"', () => {
  const change = (label: string) => ({
    transitionId: 't-assign', label, trigger: 'automatic', requiresInput: false, inputField: null, condition: null, timerHours: null,
  })

  it('an arrow saved locally is queued once — the last save wins — and still drawn after a reload', () => {
    const h = designer()
    act(() => { h.result.current.handleSaveLocally(change('Take it')) })
    act(() => { h.result.current.handleSaveLocally(change('Take it now')) })
    act(() => { h.result.current.handleSaveLocally({ ...change('Escalate'), transitionId: 't-escalate', trigger: 'sla_breach' }) })
    expect(h.result.current.hasChanges).toBe(true)
    expect(h.result.current.pendingChanges.map((c) => [c.transitionId, c.label])).toEqual([['t-assign', 'Take it now'], ['t-escalate', 'Escalate']])

    // A step was added elsewhere: the definition is reloaded.
    h.rerender({ d: incident() })
    expect(trOf(edge(h, 't-assign'))).toMatchObject({ label: 'Take it now', trigger: 'automatic' })
    expect((edge(h, 't-assign').data as EdgeNodeData).color).toBe(TRIGGER_COLOR['automatic'])
  })

  it('a step saved twice is MERGED: a field sent only the first time (the deadline) is kept', () => {
    const h = designer()
    const base = { stepName: 'in_progress', enterActions: null, exitActions: null, isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose: 'work' }
    act(() => { h.result.current.handleSaveStepLocally({ ...base, label: 'Working', deadline: '{"hours":8}' }) })
    act(() => { h.result.current.handleSaveStepLocally({ ...base, label: 'Working on it' }) })
    expect(h.result.current.hasChanges).toBe(true)
    expect(h.result.current.pendingStepChanges).toEqual([{ ...base, label: 'Working on it', deadline: '{"hours":8}' }])

    h.rerender({ d: incident() })
    expect(stepOf(node(h, 's-progress'))).toMatchObject({ label: 'Working on it', deadline: '{"hours":8}', category: 'active', purpose: 'work' })
  })

  it('after a reload a queued step keeps its own deadline when none was sent, and loses it when it was removed', () => {
    const h = designer()
    const base = { enterActions: null, exitActions: null, isInitial: false, isTerminal: false, isOpen: true, category: null }
    act(() => { h.result.current.handleSaveStepLocally({ ...base, stepName: 'in_progress', label: 'In progress' }) })
    act(() => { h.result.current.handleSaveStepLocally({ ...base, stepName: 'resolved', label: 'Resolved', deadline: '', purpose: null }) })
    h.rerender({ d: incident({ steps: incident().steps.map((s) => (s.name === 'resolved' ? { ...s, deadline: '{"hours":1}' } : s)) }) })
    expect(stepOf(node(h, 's-progress')).deadline).toBe('{"hours":4}')
    expect(stepOf(node(h, 's-progress')).purpose).toBeNull()
    expect(stepOf(node(h, 's-resolved')).deadline).toBeNull()
  })

  it('moving a step is a change to save, and the new place survives a reload; a step still being dragged is not', () => {
    const h = designer()
    act(() => { h.result.current.onNodesChange([{ type: 'position', id: 's-custom', position: { x: 90, y: 90 }, dragging: true }]) })
    expect(h.result.current.hasChanges).toBe(false)
    act(() => { h.result.current.onNodesChange([{ type: 'position', id: 's-custom', position: { x: 100, y: 110 }, dragging: false }]) })
    expect(h.result.current.hasChanges).toBe(true)
    expect(node(h, 's-custom').position).toEqual({ x: 100, y: 110 })
    // Moved, not saved yet: this position wins even over the one saved by the designer.
    act(() => { h.result.current.onNodesChange([{ type: 'position', id: 's-closed', position: { x: 7, y: 8 }, dragging: false }]) })
    h.rerender({ d: incident() })
    expect(node(h, 's-custom').position).toEqual({ x: 100, y: 110 })
    expect(node(h, 's-closed').position).toEqual({ x: 7, y: 8 })
  })

  it('once saved, the queue and the moves are forgotten: a reload shows the definition as it is', () => {
    const h = designer()
    act(() => {
      h.result.current.handleSaveLocally(change('Take it'))
      h.result.current.onNodesChange([{ type: 'position', id: 's-custom', position: { x: 100, y: 110 }, dragging: false }])
    })
    act(() => { h.result.current.clearLocalChanges() })
    expect(h.result.current.hasChanges).toBe(false)
    expect(h.result.current.pendingChanges).toEqual([])
    expect(h.result.current.pendingStepChanges).toEqual([])
    h.rerender({ d: incident() })
    expect(node(h, 's-custom').position).toEqual({ x: 6 * 220, y: 200 })
    expect(trOf(edge(h, 't-assign')).label).toBe('new to assigned')
  })

  it('what a panel saves shows at once on the selected step or arrow, and only there', () => {
    const h = designer()
    act(() => { h.result.current.handleNodeClick(click, node(h, 's-progress')) })
    act(() => { h.result.current.onStepSaved({ label: 'Working' }) })
    expect(h.result.current.selectedStep?.label).toBe('Working')
    expect(stepOf(node(h, 's-assigned')).label).toBe('assigned')

    act(() => { h.result.current.handleEdgeClick(click, edge(h, 't-escalate')) })
    act(() => { h.result.current.onEdgeSaved({ condition: 'has_linked_change' }) })
    expect(h.result.current.selectedTr).toMatchObject({ id: 't-escalate', condition: 'has_linked_change' })
    expect(trOf(edge(h, 't-assign')).condition).toBeNull()
  })
})
