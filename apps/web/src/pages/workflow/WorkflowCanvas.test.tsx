/**
 * THE WORKFLOW CANVAS: each step drawn as a box, each transition as an arrow
 * with a clickable label, the legend of the arrow colours, and the side
 * panels on top.
 *
 * What the administrator relies on:
 *  - while the workflow loads, or when the tenant has none, the canvas SAYS
 *    so instead of showing an empty area;
 *  - a box says what kind of step it is — the special kinds by name, in the
 *    viewer's language, a process step by its technical name — and which one
 *    is selected;
 *  - the label of an arrow is a real button: it opens the transition (its
 *    click must not also reach the canvas behind, which would close the
 *    panel it just opened) and it lights up the arrow under the pointer or
 *    the keyboard focus alike;
 *  - a return arrow hides its label from the drawing, not from its button;
 *  - any two steps may be connected, whatever sides are used, but an arrow's
 *    ends cannot be dragged elsewhere: the server cannot move a transition.
 *
 * React Flow needs a real layout to draw; here it is replaced by a stand-in
 * that renders the nodes and edges it receives through the canvas's own node
 * and edge components, and keeps the props it was given.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import type { ComponentProps, ComponentType, MouseEvent, ReactNode } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { renderWithProviders } from '@/test/utils'
import { WorkflowCanvas, STEP_BG } from './WorkflowCanvas'
import type { StepNodeData, EdgeNodeData, WFStep, WFTransition, WorkflowDefinition } from './workflow-types'

type Props = Record<string, unknown>
interface FlowProps {
  nodes: Node[]
  edges: Edge[]
  nodeTypes: Record<string, ComponentType<Props>>
  edgeTypes: Record<string, ComponentType<Props>>
  onNodeClick?: (e: MouseEvent, n: Node) => void
  onPaneClick?: (e: MouseEvent) => void
  isValidConnection?: () => boolean
  edgesReconnectable?: boolean
  children?: ReactNode
}
const flow = vi.hoisted(() => ({ props: null as FlowProps | null }))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function FakeFlow(props: FlowProps) {
    flow.props = props
    const { nodes, edges, nodeTypes, edgeTypes, onNodeClick, onPaneClick, children } = props
    return (
      // A click anywhere that is not a node is a click on the canvas, as in React Flow.
      <div data-testid="pane" onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-node]')) onPaneClick?.(e) }}>
        {nodes.map((n) => {
          const Box = nodeTypes[n.type!]!
          return (
            // The class, `data-id` and focus React Flow gives a step: the keyboard path reads them.
            <div key={n.id} data-node={n.id} className="react-flow__node" data-id={n.id} tabIndex={0} onClick={(e) => onNodeClick?.(e, n)}>
              <Box id={n.id} data={n.data} selected={!!n.selected} />
            </div>
          )
        })}
        {edges.map((e) => {
          const Arrow = edgeTypes[e.type!]!
          return (
            <div key={e.id} className="react-flow__edge" data-id={e.id} data-testid={`edge-${e.id}`} tabIndex={0}>
              <Arrow id={e.id} data={e.data} selected={!!e.selected} animated={!!e.animated} markerEnd="url(#arrow)"
                sourceX={0} sourceY={0} targetX={200} targetY={100}
                sourcePosition={actual.Position.Right} targetPosition={actual.Position.Left} />
            </div>
          )
        })}
        {children}
      </div>
    )
  }
  return {
    ...actual,
    ReactFlow: FakeFlow,
    Background: () => null,
    Controls: () => null,
    MiniMap: ({ nodeColor }: { nodeColor: (n: Node) => string }) => (
      <ul aria-label="minimap">{flow.props!.nodes.map((n) => <li key={n.id} data-color={nodeColor(n)}>{n.id}</li>)}</ul>
    ),
    Handle: ({ id }: { id: string }) => <span data-testid={`handle-${id}`} />,
    BaseEdge: ({ id, style }: { id: string; style: React.CSSProperties }) => (
      <svg><path data-testid={`arrow-${id}`} data-width={String(style.strokeWidth)} data-dash={style.strokeDasharray ?? ''} /></svg>
    ),
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</>,
  }
})

const DEF: WorkflowDefinition = { id: 'wf-1', name: 'Incident Management', entityType: 'incident', version: 3, active: true, steps: [], transitions: [] }

const step = (id: string, name: string, type: WFStep['type'], label = name): WFStep => ({
  id, name, label, type, enterActions: null, exitActions: null,
})
const stepNode = (s: WFStep, selected = false): Node => ({
  id: s.id, type: 'workflowStep', position: { x: 0, y: 0 }, selected, data: { step: s, accentColor: '#0284c7' } satisfies StepNodeData,
})
const tr = (id: string, label: string): WFTransition => ({
  id, fromStepName: 'a', toStepName: 'b', trigger: 'manual', label, requiresInput: false, inputField: null, condition: null, timerHours: null,
})
const arrow = (t: WFTransition, over: Partial<Edge> = {}): Edge => ({
  id: t.id, source: 'a', target: 'b', type: 'workflowEdge', data: { transition: t, color: '#dc2626' } satisfies EdgeNodeData, ...over,
})

type CanvasProps = ComponentProps<typeof WorkflowCanvas>

function canvas(over: Partial<CanvasProps> = {}) {
  const props: CanvasProps = {
    nodes: [], edges: [], onNodesChange: vi.fn(), onEdgesChange: vi.fn(), onNodeClick: vi.fn(), onEdgeClick: vi.fn(),
    onPaneClick: vi.fn(), onConnect: vi.fn(), loading: false, def: DEF, ...over,
  }
  const r = renderWithProviders(<WorkflowCanvas {...props} />)
  return { ...r, props }
}

const LEGEND = ['Node / step', 'Manual', 'Automatic', 'SLA breach', 'Timer (auto-close)']

describe('WorkflowCanvas — before there is a workflow', () => {
  it('while the workflow loads it says so, with no canvas and no legend', () => {
    canvas({ loading: true, def: null })
    expect(screen.getByText('Loading workflow…')).toBeInTheDocument()
    expect(screen.queryByText('No workflow found for this tenant.')).toBeNull()
    expect(screen.queryByTestId('pane')).toBeNull()
    for (const entry of LEGEND) expect(screen.queryByText(entry)).toBeNull()
  })

  it('without a workflow it says the tenant has none, with no legend', () => {
    canvas({ def: null })
    expect(screen.getByText('No workflow found for this tenant.')).toBeInTheDocument()
    expect(screen.queryByTestId('pane')).toBeNull()
    for (const entry of LEGEND) expect(screen.queryByText(entry)).toBeNull()
  })
})

describe('WorkflowCanvas — the steps', () => {
  it('says what kind each step is: special kinds by name, a process step by its technical name', () => {
    canvas({ nodes: [
      stepNode(step('s1', 'new', 'start', 'New')),
      stepNode(step('s2', 'waiting_vendor', 'standard', 'Waiting for the vendor')),
      stepNode(step('s3', 'cool_down', 'timer_wait', 'Cool down')),
      stepNode(step('s4', 'split', 'parallel_fork')),
      stepNode(step('s5', 'merge', 'parallel_join')),
      stepNode(step('s6', 'child', 'sub_workflow')),
      stepNode(step('s7', 'closed', 'end', 'Closed')),
    ] })
    const box = (id: string) => screen.getByTestId('pane').querySelector(`[data-node="${id}"]`) as HTMLElement
    expect(box('s1')).toHaveTextContent(/^STARTNewnew$/)
    expect(box('s2')).toHaveTextContent(/^waiting vendorWaiting for the vendorwaiting_vendor$/)
    expect(box('s3')).toHaveTextContent('⏱ Timer wait')
    expect(box('s4')).toHaveTextContent('⑂ Fork')
    expect(box('s5')).toHaveTextContent('⑂ Join')
    expect(box('s6')).toHaveTextContent('⊞ Sub-workflow')
    expect(box('s7')).toHaveTextContent(/^ENDClosedclosed$/)
    // Four sides to arrive at and four to leave from, on every step.
    expect(within(box('s2')).getAllByTestId(/^handle-/).map((h) => h.dataset['testid'])).toEqual([
      'handle-tgt-top', 'handle-tgt-bottom', 'handle-tgt-left', 'handle-tgt-right',
      'handle-src-top', 'handle-src-bottom', 'handle-src-left', 'handle-src-right',
    ])
  })

  it('the selected step is marked, and a click on a step reaches the designer', async () => {
    const nodes = [stepNode(step('s1', 'new', 'start'), true), stepNode(step('s2', 'triage', 'standard', 'Triage desk'))]
    const { user, props } = canvas({ nodes })
    expect(screen.getByText('START').closest('.og-wf-node')).toHaveClass('is-selected')
    expect(screen.getByText('Triage desk').closest('.og-wf-node')).not.toHaveClass('is-selected')
    await user.click(screen.getByText('Triage desk'))
    expect(props.onNodeClick).toHaveBeenCalledWith(expect.anything(), nodes[1])
  })

  it('the minimap colours each step as its box, and a step of an unknown kind in the error colour', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    canvas({ nodes: [
      stepNode(step('s1', 'new', 'start')),
      stepNode(step('s2', 'triage', 'standard')),
      stepNode(step('s3', 'odd', 'legacy_kind' as WFStep['type'])),
    ] })
    const colours = within(screen.getByRole('list', { name: 'minimap' })).getAllByRole('listitem').map((li) => li.dataset['color'])
    expect(colours).toEqual([STEP_BG['start'], STEP_BG['standard'], 'var(--color-danger)'])
    expect(screen.getByTestId('pane').querySelector('[data-node="s1"] .og-wf-node')).toHaveStyle({ backgroundColor: STEP_BG['start'] })
    expect(logged).toHaveBeenCalledWith('[STEP_BG] unknown value: "legacy_kind"')
  })
})

describe('WorkflowCanvas — the transitions', () => {
  it('the label of an arrow opens its transition, and the click does not also reach the canvas', async () => {
    const resolve = arrow(tr('t2', 'Resolve'))
    const { user, props } = canvas({ edges: [arrow(tr('t1', 'Start work')), resolve] })
    await user.click(screen.getByRole('button', { name: 'Open transition Resolve' }))
    expect(props.onEdgeClick).toHaveBeenCalledTimes(1)
    expect(props.onEdgeClick).toHaveBeenCalledWith(expect.anything(), resolve)
    expect(props.onPaneClick).not.toHaveBeenCalled()
    // A click on the empty canvas does reach it.
    await user.click(screen.getByTestId('pane'))
    expect(props.onPaneClick).toHaveBeenCalledTimes(1)
  })

  it('under the pointer or the keyboard focus the arrow thickens and its label shows the settings icon', () => {
    canvas({ edges: [arrow(tr('t1', 'Start work'))] })
    const label = screen.getByRole('button', { name: 'Open transition Start work' })
    const line = screen.getByTestId('arrow-t1')
    expect(line).toHaveAttribute('data-width', '1.5')
    expect(label.querySelector('svg')).toBeNull()
    fireEvent.mouseEnter(label)
    expect(line).toHaveAttribute('data-width', '2.5')
    expect(label.querySelector('svg')).not.toBeNull()
    fireEvent.mouseLeave(label)
    expect(line).toHaveAttribute('data-width', '1.5')
    fireEvent.focus(label)
    expect(line).toHaveAttribute('data-width', '2.5')
    expect(label.querySelector('svg')).not.toBeNull()
    fireEvent.blur(label)
    expect(line).toHaveAttribute('data-width', '1.5')
    expect(label.querySelector('svg')).toBeNull()
  })

  it('a selected arrow stays highlighted; a moving (return) arrow is dashed', () => {
    canvas({ edges: [arrow(tr('t1', 'Start work'), { selected: true }), arrow(tr('t2', ''), { animated: true })] })
    const selected = screen.getByRole('button', { name: 'Open transition Start work' })
    expect(selected).toHaveClass('is-selected')
    expect(selected.querySelector('svg')).not.toBeNull()
    expect(screen.getByTestId('arrow-t1')).toHaveAttribute('data-width', '2.5')
    expect(screen.getByTestId('arrow-t1')).toHaveAttribute('data-dash', '')
    expect(screen.getByTestId('arrow-t2')).toHaveAttribute('data-dash', '6 3')
    expect(screen.getByRole('button', { name: 'Open transition' })).not.toHaveClass('is-selected')
  })

  it('a return arrow is drawn without its label, but its button is still named by it', async () => {
    const reopen = arrow(tr('t3', 'Reopen'), { animated: true, data: { transition: tr('t3', 'Reopen'), color: '#dc2626', hideLabel: true } satisfies EdgeNodeData })
    const { user, props } = canvas({ edges: [reopen] })
    const label = screen.getByRole('button', { name: 'Open transition Reopen' })
    expect(label).toHaveTextContent('')
    await user.click(label)
    expect(props.onEdgeClick).toHaveBeenCalledWith(expect.anything(), reopen)
  })

  it('an arrow that came without its data is still drawn and clickable, unlabelled', async () => {
    const bare: Edge = { id: 't9', source: 'a', target: 'b', type: 'workflowEdge' }
    const { user, props } = canvas({ edges: [bare] })
    const label = screen.getByRole('button', { name: 'Open transition' })
    expect(label).toHaveTextContent('')
    await user.click(label)
    expect(props.onEdgeClick).toHaveBeenCalledWith(expect.anything(), bare)
  })

  it('any two steps may be connected, whatever sides are used', () => {
    const { props } = canvas()
    expect(flow.props!.isValidConnection!()).toBe(true)
    expect((flow.props as unknown as Record<string, unknown>)['onConnect']).toBe(props.onConnect)
  })

  it('an arrow\'s ends cannot be dragged to other steps: the server cannot move a transition', () => {
    canvas()
    expect(flow.props!.edgesReconnectable).toBe(false)
    expect((flow.props as unknown as Record<string, unknown>)['onReconnect']).toBeUndefined()
  })
})

describe('WorkflowCanvas — legend and panels', () => {
  it('the legend explains the steps and the colour of each trigger; the side panels are drawn on top', () => {
    canvas({ children: <aside aria-label="side panel">Edit the step</aside> })
    for (const entry of LEGEND) expect(screen.getByText(entry)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'side panel' })).toHaveTextContent('Edit the step')
  })
})

// Review of 23 Sep 2026: React Flow sends Enter and Space to its own selection only.
describe('WorkflowCanvas — from the keyboard', () => {
  it('Enter on a focused step, or Space on a focused arrow, opens its panel as a click does', async () => {
    const nodes = [stepNode(step('s1', 'new', 'start')), stepNode(step('s2', 'triage', 'standard', 'Triage desk'))]
    const edges = [arrow(tr('t1', 'Take'))]
    const { user, props } = canvas({ nodes, edges })
    ;(screen.getByText('Triage desk').closest('.react-flow__node') as HTMLElement).focus()
    await user.keyboard('{Enter}')
    expect(props.onNodeClick).toHaveBeenCalledWith(expect.anything(), nodes[1])
    screen.getByTestId('edge-t1').focus()
    await user.keyboard(' ')
    expect(props.onEdgeClick).toHaveBeenCalledWith(expect.anything(), edges[0])
  })

  it('other keys do nothing', async () => {
    const nodes = [stepNode(step('s2', 'triage', 'standard', 'Triage desk'))]
    const { user, props } = canvas({ nodes })
    ;(screen.getByText('Triage desk').closest('.react-flow__node') as HTMLElement).focus()
    await user.keyboard('a{Tab}')
    expect(props.onNodeClick).not.toHaveBeenCalled()
  })
})
