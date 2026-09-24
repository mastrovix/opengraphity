/**
 * THE WORKFLOW DESIGNER PAGE: the workflow of a ticket type drawn as steps and
 * arrows, the panels that edit them, and "Save changes".
 *
 * The workflow is what the engine runs on every ticket of that type, so what
 * is pinned here is what an administrator must be able to trust:
 *  - the page draws the workflow it was opened on, says when it is loading
 *    or does not exist, and warns that the steps of a change workflow are
 *    fixed;
 *  - clicking a step or an arrow opens its panel, and the canvas closes it;
 *  - what a panel saves waits, counted, in "Save changes", and is then sent in
 *    ONE save with every moved step and the version that was read — so a
 *    concurrent edit is refused instead of overwritten;
 *  - a save the server does not confirm is said; a version conflict is said
 *    once (by the error link), and the queued work stays for a retry;
 *  - drawing an arrow creates a manual transition from the sides used, and
 *    deleting an arrow or a step asks first; a failure is said once and
 *    never followed by a success message.
 *
 * React Flow needs a real layout to draw: it is replaced by a stand-in that
 * renders the nodes and edges it receives through the canvas's own node and
 * edge components, and keeps the props it was given (to connect two steps or
 * move one, as a drag would).
 *
 * The two tests at the end found defects while they were being written; both
 * are fixed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType, MouseEvent, ReactNode } from 'react'
import type { Connection, Edge, Node, NodeChange } from '@xyflow/react'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { WorkflowDesignerPage } from './WorkflowDesignerPage'
import type { WFStep, WFTransition, WorkflowDefinition } from './workflow-types'

// ── React Flow stand-in ──────────────────────────────────────────────────────

type Props = Record<string, unknown>
interface FlowProps {
  nodes: Node[]
  edges: Edge[]
  nodeTypes: Record<string, ComponentType<Props>>
  edgeTypes: Record<string, ComponentType<Props>>
  onNodeClick?: (e: MouseEvent, n: Node) => void
  onPaneClick?: (e: MouseEvent) => void
  onNodesChange?: (changes: NodeChange[]) => void
  onConnect?: (c: Partial<Connection> & { source: string; target: string }) => Promise<void> | void
  onReconnect?: (old: Edge, c: Partial<Connection> & { source: string; target: string }) => void
  edgesReconnectable?: boolean
  children?: ReactNode
}
const flow = vi.hoisted(() => ({ props: null as FlowProps | null }))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function FakeFlow(props: FlowProps) {
    flow.props = props
    const { nodes, edges, nodeTypes, edgeTypes, onNodeClick, onPaneClick } = props
    return (
      // A click anywhere that is not a node is a click on the canvas, as in React Flow.
      <div data-testid="pane" onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-node]')) onPaneClick?.(e) }}>
        {nodes.map((n) => {
          const Box = nodeTypes[n.type!]!
          return (
            <div key={n.id} data-node={n.id} onClick={(e) => onNodeClick?.(e, n)}>
              <Box id={n.id} data={n.data} selected={!!n.selected} />
            </div>
          )
        })}
        {edges.map((e) => {
          const Arrow = edgeTypes[e.type!]!
          return (
            <Arrow key={e.id} id={e.id} data={e.data} selected={!!e.selected} animated={!!e.animated} markerEnd="url(#arrow)"
              sourceX={0} sourceY={0} targetX={200} targetY={100}
              sourcePosition={actual.Position.Right} targetPosition={actual.Position.Left} />
          )
        })}
      </div>
    )
  }
  return {
    ...actual,
    ReactFlow: FakeFlow,
    Handle: () => null,
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
  }
})

// ── Apollo stand-in ──────────────────────────────────────────────────────────

/*
 * The fake Apollo of the page tests, with two corrections:
 *  - a query named in `inCaricamento` is still loading;
 *  - a failed mutation REJECTS even when it has an `onError`, as in Apollo
 *    Client 4 (`useMutation` calls `onError`, then rethrows; the shared fake
 *    resolves instead, as Apollo 3 did). The page relies on it: its handlers
 *    stop at the rejection and do not announce a success.
 */
const inCaricamento = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { moduloApollo, nomeOperazione } = await import('@/test/apolloFinto')
  const base = moduloApollo()
  return {
    ...base,
    useQuery: (...args: Parameters<typeof base.useQuery>) => {
      const r = base.useQuery(...args)
      return inCaricamento.has(nomeOperazione(args[0])) ? { ...r, data: undefined, loading: true } : r
    },
    useMutation: (...args: Parameters<typeof base.useMutation>) => {
      const [run, state] = base.useMutation(...args) as [(o?: unknown) => Promise<{ errors?: Error[] } | undefined>, unknown]
      const asApollo4 = (o?: unknown) => {
        const p = (async () => {
          const r = await run(o)
          if (r?.errors?.length) throw r.errors[0]
          return r
        })()
        p.catch(() => {})
        return p
      }
      return [asApollo4, state]
    },
  }
})
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const step = (id: string, name: string, label: string, over: Partial<WFStep> = {}): WFStep => ({
  id, name, label, type: 'standard', enterActions: null, exitActions: null, isInitial: false, isTerminal: false, isOpen: true,
  category: null, purpose: null, deadline: null, currentInstances: 0, positionX: null, positionY: null, labels: [], ...over,
})
const tr = (id: string, from: string, to: string, label: string, over: Partial<WFTransition> = {}): WFTransition => ({
  id, fromStepName: from, toStepName: to, trigger: 'manual', label, requiresInput: false, inputField: null,
  condition: null, timerHours: null, sourceHandle: null, targetHandle: null, ...over,
})

const DEF: WorkflowDefinition = {
  id: 'wf-1', name: 'Incident Management', entityType: 'incident', version: 3, active: true,
  steps: [
    step('s-new', 'new', 'New', { type: 'start', isInitial: true }),
    step('s-progress', 'in_progress', 'In progress'),
    step('s-resolved', 'resolved', 'Resolved'),
    step('s-closed', 'closed', 'Closed', { type: 'end', isTerminal: true, isOpen: false }),
  ],
  transitions: [
    tr('t-start', 'new', 'in_progress', 'Start work'),
    tr('t-resolve', 'in_progress', 'resolved', 'Resolve'),
    // resolved → in_progress is a RETURN arrow in the incident layout.
    tr('t-reopen', 'resolved', 'in_progress', 'Reopen'),
    tr('t-close', 'resolved', 'closed', 'Auto-close', { trigger: 'timer', timerHours: 72 }),
  ],
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.refetch.mockImplementation(async () => ({ data: {} }))
  inCaricamento.clear()
  flow.props = null
  toast.success.mockReset()
  toast.error.mockReset()
  apolloFinto.risposte['GetWorkflowDefinitionById'] = { workflowDefinitionById: DEF }
  apolloFinto.esiti['SaveWorkflowChanges'] = { data: { saveWorkflowChanges: { id: 'wf-1', name: 'Incident Management', version: 4 } } }
})

const designer = (route = '/workflow/wf-1') => renderWithProviders(<WorkflowDesignerPage />, { route, path: '/workflow/:id?' })
const saveChanges = () => screen.getByRole('button', { name: /Save changes/ })
const panelSave = () => screen.getByRole('button', { name: 'Save' })
const confirmDelete = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' })
type User = ReturnType<typeof designer>['user']

async function renameTransition(user: User, from: string, to: string) {
  await user.click(screen.getByRole('button', { name: `Open transition ${from}` }))
  const label = screen.getByRole('textbox', { name: 'Label' })
  await user.clear(label)
  await user.type(label, to)
  await user.click(panelSave())
}

const INCIDENT_LAYOUT = [
  { stepId: 's-new', positionX: 0, positionY: 280 },
  { stepId: 's-progress', positionX: 560, positionY: 280 },
  { stepId: 's-resolved', positionX: 1120, positionY: 280 },
  { stepId: 's-closed', positionX: 1400, positionY: 280 },
]

// ── Drawing ──────────────────────────────────────────────────────────────────

describe('WorkflowDesignerPage — the workflow on screen', () => {
  it('draws the workflow of the address: its name and version, each step, each arrow, and the legend', () => {
    designer()
    expect(apolloFinto.chiamata('GetWorkflowDefinitionById')).toEqual({ id: 'wf-1' })
    expect(screen.getByRole('heading', { name: 'Incident Management' })).toBeInTheDocument()
    expect(screen.getByText('v3 · Active')).toBeInTheDocument()
    for (const label of ['New', 'In progress', 'Resolved', 'Closed']) expect(screen.getByText(label)).toBeInTheDocument()
    for (const label of ['Start work', 'Resolve', 'Auto-close']) {
      expect(screen.getByRole('button', { name: `Open transition ${label}` })).toBeInTheDocument()
    }
    // The return arrow is drawn without its label; its button still says it, to a screen reader.
    expect(screen.getByRole('button', { name: 'Open transition Reopen' })).toHaveTextContent('')
    expect(screen.getByText('Timer (auto-close)')).toBeInTheDocument()
    expect(screen.queryByText(/steps of this workflow are fixed/)).toBeNull()
    expect(saveChanges()).toBeDisabled()
  })

  it('while the workflow loads it says so', () => {
    inCaricamento.add('GetWorkflowDefinitionById')
    designer()
    expect(screen.getByText('Loading workflow…')).toBeInTheDocument()
    expect(screen.queryByText('New')).toBeNull()
  })

  it('a workflow that does not exist is said, with nothing to save or add', () => {
    apolloFinto.risposte['GetWorkflowDefinitionById'] = { workflowDefinitionById: null }
    designer()
    expect(screen.getByText('No workflow found for this tenant.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Step/ })).toBeNull()
    expect(saveChanges()).toBeDisabled()
  })

  it('without a workflow in the address nothing is asked of the server', () => {
    designer('/workflow')
    expect(apolloFinto.chiamate['GetWorkflowDefinitionById']).toBeUndefined()
    expect(screen.getByText('No workflow found for this tenant.')).toBeInTheDocument()
  })

  it('a change workflow warns that its steps are fixed', () => {
    apolloFinto.risposte['GetWorkflowDefinitionById'] = { workflowDefinitionById: { ...DEF, entityType: 'change', name: 'Change RFC Process' } }
    designer()
    expect(screen.getByText('The steps of this workflow are fixed. You can customise labels, actions and conditions.')).toBeInTheDocument()
  })
})

// ── Panels and saving ────────────────────────────────────────────────────────

describe('WorkflowDesignerPage — panels and "Save changes"', () => {
  it('a click on a step opens its panel; its X, or a click on the canvas, closes it', async () => {
    const { user } = designer()
    await user.click(screen.getByText('In progress'))
    expect(screen.getByText('Edit the step')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('In progress')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Edit the step')).toBeNull()

    await user.click(screen.getByText('In progress'))
    await user.click(screen.getByTestId('pane'))
    expect(screen.queryByText('Edit the step')).toBeNull()
  })

  it('a click on an arrow opens its panel, which its X closes', async () => {
    const { user } = designer()
    await user.click(screen.getByRole('button', { name: 'Open transition Resolve' }))
    expect(screen.getByText('Edit the transition')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Resolve')
    expect(screen.queryByText('Edit the step')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Edit the transition')).toBeNull()
  })

  it('an arrow saved in its panel waits, counted, then goes in ONE save with the positions and the version read', async () => {
    const { user } = designer()
    await renameTransition(user, 'Resolve', 'Resolve ticket')
    expect(toast.success).toHaveBeenCalledWith('Change saved locally')
    // The arrow shows it at once, and it waits for "Save changes".
    expect(screen.getByRole('button', { name: 'Open transition Resolve ticket' })).toBeInTheDocument()
    expect(saveChanges()).toHaveTextContent('Save changes1')
    expect(apolloFinto.chiamate['SaveWorkflowChanges']).toBeUndefined()

    await user.click(saveChanges())
    expect(apolloFinto.chiamata('SaveWorkflowChanges')).toEqual({
      definitionId: 'wf-1', expectedVersion: 3, steps: [], positions: INCIDENT_LAYOUT,
      transitions: [{ transitionId: 't-resolve', label: 'Resolve ticket', trigger: 'manual', requiresInput: false, inputField: null, condition: null, timerHours: null }],
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Workflow saved — v4'))
    expect(saveChanges()).toBeDisabled()
    expect(saveChanges()).toHaveTextContent(/^Save changes$/)
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a step saved in its panel is shown at once, waits, and goes in the save', async () => {
    const { user } = designer()
    await user.click(screen.getByText('In progress'))
    const label = screen.getByRole('textbox', { name: 'Label' })
    await user.clear(label)
    await user.type(label, 'Working')
    await user.click(panelSave())
    expect(saveChanges()).toHaveTextContent('Save changes1')
    expect(screen.getByTestId('pane')).toHaveTextContent('Working')

    await user.click(saveChanges())
    const sent = apolloFinto.chiamata('SaveWorkflowChanges')!
    expect(sent['steps']).toEqual([expect.objectContaining({ stepName: 'in_progress', label: 'Working' })])
    expect(sent['transitions']).toEqual([])
  })

  it('a moved step makes "Save changes" available, and its new place is saved', async () => {
    const { user } = designer()
    act(() => { flow.props!.onNodesChange!([{ type: 'position', id: 's-progress', position: { x: 600, y: 320 }, dragging: false }]) })
    expect(saveChanges()).toBeEnabled()
    await user.click(saveChanges())
    expect(apolloFinto.chiamata('SaveWorkflowChanges')!['positions']).toEqual([
      INCIDENT_LAYOUT[0], { stepId: 's-progress', positionX: 600, positionY: 320 }, INCIDENT_LAYOUT[2], INCIDENT_LAYOUT[3],
    ])
  })

  it('a save the server does not confirm is said, and the work stays queued', async () => {
    apolloFinto.esiti['SaveWorkflowChanges'] = { data: { saveWorkflowChanges: null } }
    const { user } = designer()
    await renameTransition(user, 'Resolve', 'Resolve ticket')
    await user.click(saveChanges())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save returned no response from the server: reload the page to check the workflow state.'))
    expect(saveChanges()).toHaveTextContent('Save changes1')
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/^Workflow saved/))
  })

  it('a version conflict is said once — by the error link, not by the page — and the work stays for a retry', async () => {
    apolloFinto.esiti['SaveWorkflowChanges'] = { error: new CombinedGraphQLErrors({ errors: [{ message: 'The workflow was changed by someone else' }] }) }
    const { user } = designer()
    await renameTransition(user, 'Resolve', 'Resolve ticket')
    await user.click(saveChanges())
    await waitFor(() => expect(apolloFinto.chiamate['SaveWorkflowChanges']).toHaveLength(1))
    expect(toast.error).not.toHaveBeenCalled()
    expect(saveChanges()).toHaveTextContent('Save changes1')
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('a failure the error link did not see (the network) is said, and the work stays', async () => {
    apolloFinto.esiti['SaveWorkflowChanges'] = { error: new Error('Failed to fetch') }
    const { user } = designer()
    await renameTransition(user, 'Resolve', 'Resolve ticket')
    await user.click(saveChanges())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to fetch'))
    expect(saveChanges()).toHaveTextContent('Save changes1')
  })
})

// ── Drawing and deleting arrows and steps ────────────────────────────────────

describe('WorkflowDesignerPage — adding and deleting', () => {
  // Tour of 23 Sep 2026: the arrow was created with an empty label — a blank
  // button on every ticket. It starts with the label of the step it leads to.
  // Review of 23 Sep 2026: an arrow could only be dragged; the keyboard way creates the same transition.
  it('under the panel of a step, a transition to another step is added without dragging', async () => {
    const { user } = designer()
    await user.click(screen.getByText('In progress'))
    await user.selectOptions(screen.getByLabelText('Add a transition to'), 's-resolved')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(apolloFinto.chiamata('AddWorkflowTransition')).toEqual({
      definitionId: 'wf-1', fromStepName: 'in_progress', toStepName: 'resolved', trigger: 'manual', label: 'Resolved',
      sourceHandle: null, targetHandle: null,
    })
  })

  it('an arrow drawn between two steps creates a manual transition from the sides used, named after its target, and reloads', async () => {
    designer()
    await act(async () => { await flow.props!.onConnect!({ source: 's-new', target: 's-resolved', sourceHandle: 'src-top' }) })
    expect(apolloFinto.chiamata('AddWorkflowTransition')).toEqual({
      definitionId: 'wf-1', fromStepName: 'new', toStepName: 'resolved', trigger: 'manual', label: 'Resolved',
      sourceHandle: 'src-top', targetHandle: null,
    })
    expect(toast.success).toHaveBeenCalledWith('Transition created — set its trigger in the panel')
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)

    // Drawn without naming the sides: the layout will choose them.
    await act(async () => { await flow.props!.onConnect!({ source: 's-closed', target: 's-new', sourceHandle: null, targetHandle: null }) })
    expect(apolloFinto.chiamata('AddWorkflowTransition')).toEqual(expect.objectContaining({
      fromStepName: 'closed', toStepName: 'new', sourceHandle: null, targetHandle: null,
    }))
  })

  it('an arrow that does not join two steps is refused, and nothing is sent', async () => {
    designer()
    await act(async () => { await flow.props!.onConnect!({ source: 's-new', target: 'the-legend', sourceHandle: null, targetHandle: null }) })
    expect(toast.error).toHaveBeenCalledWith('Step not recognized')
    expect(apolloFinto.chiamate['AddWorkflowTransition']).toBeUndefined()
  })

  it('a transition that cannot be created is said once, with no success message and no reload', async () => {
    apolloFinto.esiti['AddWorkflowTransition'] = { error: new Error('A transition new → resolved already exists') }
    designer()
    await act(async () => { await flow.props!.onConnect!({ source: 's-new', target: 's-resolved', sourceHandle: 'src-right', targetHandle: 'tgt-left' }) })
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('A transition new → resolved already exists')
    expect(toast.success).not.toHaveBeenCalled()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('deleting an arrow asks first, then removes it, closes its panel and reloads', async () => {
    const { user } = designer()
    await user.click(screen.getByRole('button', { name: 'Open transition Resolve' }))
    await user.click(screen.getByRole('button', { name: 'Delete transition' }))
    expect(screen.getByRole('dialog', { name: 'Delete the transition in_progress → resolved?' })).toBeInTheDocument()
    await user.click(confirmDelete())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Transition deleted'))
    expect(apolloFinto.chiamata('RemoveWorkflowTransition')).toEqual({ definitionId: 'wf-1', transitionId: 't-resolve' })
    expect(screen.queryByText('Edit the transition')).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('an arrow that cannot be deleted is said once, and its panel stays open', async () => {
    apolloFinto.esiti['RemoveWorkflowTransition'] = { error: new Error('Tickets are waiting on this transition') }
    const { user } = designer()
    await user.click(screen.getByRole('button', { name: 'Open transition Resolve' }))
    await user.click(screen.getByRole('button', { name: 'Delete transition' }))
    await user.click(confirmDelete())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tickets are waiting on this transition'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByText('Edit the transition')).toBeInTheDocument()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })

  it('deleting a step asks first, then removes it, closes its panel and reloads', async () => {
    const { user } = designer()
    await user.click(screen.getByText('In progress'))
    await user.click(screen.getByRole('button', { name: 'Delete the step' }))
    expect(screen.getByRole('dialog', { name: 'Delete the step "In progress"?' })).toBeInTheDocument()
    await user.click(confirmDelete())
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Step deleted'))
    expect(apolloFinto.chiamata('RemoveWorkflowStep')).toEqual({ definitionId: 'wf-1', stepName: 'in_progress' })
    expect(screen.queryByText('Edit the step')).toBeNull()
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('a step that cannot be deleted is said once, and its panel stays open', async () => {
    apolloFinto.esiti['RemoveWorkflowStep'] = { error: new Error('Tickets are in this step') }
    const { user } = designer()
    await user.click(screen.getByText('In progress'))
    await user.click(screen.getByRole('button', { name: 'Delete the step' }))
    await user.click(confirmDelete())
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Tickets are in this step'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByText('Edit the step')).toBeInTheDocument()
  })
})

// ── Defects ──────────────────────────────────────────────────────────────────

describe('WorkflowDesignerPage — defects found while writing these tests', () => {
  /*
   * Found by this test (tour of 23 Sep 2026), fixed: a return arrow was drawn
   * without its label by blanking the label in the arrow's DATA, not only in
   * the drawing. Its panel opened with an empty Label, and any change saved
   * there sent `label: ''`, which the API stored over «Reopen» — the text of
   * the button people click on the ticket. The API now also refuses to leave
   * a manual transition without a label.
   */
  it('changing the condition of a return arrow keeps its label', async () => {
    const { user } = designer()
    await user.click(screen.getByRole('button', { name: 'Open transition Reopen' }))
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Reopen')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Condition (optional)' }), 'All tasks of the step completed')
    await user.click(panelSave())
    // Still drawn without its label.
    expect(screen.getByRole('button', { name: 'Open transition Reopen' })).toHaveTextContent('')
    await user.click(saveChanges())
    const sent = apolloFinto.chiamata('SaveWorkflowChanges')!['transitions'] as Array<Record<string, unknown>>
    expect(sent).toEqual([expect.objectContaining({ transitionId: 't-reopen', condition: 'all_tasks_complete', label: 'Reopen' })])
  })

  /*
   * Found by this test (tour of 23 Sep 2026), fixed: the canvas let an
   * arrow's end be dragged to another step and redrew it there, but the move
   * was only drawn — neither sent nor queued for "Save changes", and the next
   * reload put the arrow back. The API cannot move a transition, so the
   * canvas no longer offers the drag, and the arrow's panel says how to move
   * it: delete it and draw a new one.
   */
  it('an arrow\'s ends cannot be dragged to another step, and its panel says how to move it', async () => {
    const { user } = designer()
    expect(flow.props!.edgesReconnectable).toBe(false)
    expect(flow.props!.onReconnect).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Open transition Resolve' }))
    expect(screen.getByText('To move this arrow to other steps, delete it and draw a new one between the right steps.')).toBeInTheDocument()
  })
})
