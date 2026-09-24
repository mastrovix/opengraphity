/**
 * A CMDB CHAIN DRAWN.
 *
 * What the drawing must say: a box per type, in the viewer's words, the root
 * marked; a line per link with the relation's name, all solid — every link
 * is required, and the legend says an alternative is another chain; the arrow
 * the relation's own way (a certificate installed on the server points up to
 * it); the chosen box marked.
 * A click on a box chooses it, a click on the empty canvas lets it go. Nothing
 * is dragged or drawn by hand. React Flow needs a real layout: a stand-in
 * renders the boxes through the canvas's own node component and keeps the
 * props it was given.
 */
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import type { ComponentType, MouseEvent } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { renderWithProviders } from '@/test/utils'
import { ChainCanvas } from './ChainCanvas'
import type { ChainNode } from './chainModel'

interface FlowProps {
  nodes: Node[]; edges: Edge[]; nodeTypes: Record<string, ComponentType<Record<string, unknown>>>
  onNodeClick?: (e: MouseEvent, n: Node) => void; onPaneClick?: (e: MouseEvent) => void
  nodesDraggable?: boolean; nodesConnectable?: boolean
}
const flow = vi.hoisted(() => ({ props: null as FlowProps | null }))
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function FakeFlow(props: FlowProps) {
    flow.props = props
    return (
      <div data-testid="pane" onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-node]')) props.onPaneClick?.(e) }}>
        {props.nodes.map((n) => {
          const Box = props.nodeTypes[n.type!]!
          return <div key={n.id} data-node={n.id} onClick={(e) => props.onNodeClick?.(e, n)}><Box id={n.id} data={n.data} /></div>
        })}
        {props.edges.map((e) => <div key={e.id} data-testid={`edge-${e.id}`}>{String(e.label)}</div>)}
      </div>
    )
  }
  return { ...actual, ReactFlow: FakeFlow, Background: () => null, Controls: () => null, Handle: () => null }
})

const NODES: ChainNode[] = [
  { id: 'r', parentId: null, ciType: 'application', relationType: null, direction: null, required: true },
  { id: 's', parentId: 'r', ciType: 'server', relationType: 'HOSTED_ON', direction: 'outgoing', required: true },
  { id: 'c', parentId: 's', ciType: 'certificate', relationType: 'INSTALLED_ON', direction: 'incoming', required: false },
]

describe('ChainCanvas', () => {
  it('a box per type in the viewer\'s words, the root marked, the chosen one marked', () => {
    renderWithProviders(<ChainCanvas nodes={NODES} chosenId="s" onChoose={vi.fn()} />)
    const boxes = screen.getAllByTestId('chain-box')
    expect(boxes.map((b) => b.textContent)).toEqual(['Applicationroot', 'Server', 'Certificate'])
    expect(boxes[1]).toHaveAttribute('aria-current', 'true')
    expect(boxes[0]).not.toHaveAttribute('aria-current')
  })

  it('a line per link: the relation\'s name, solid (every link is required, the legend says so), the arrow the relation\'s way', () => {
    renderWithProviders(<ChainCanvas nodes={NODES} chosenId={null} onChoose={vi.fn()} />)
    expect(screen.getByTestId('edge-r->s')).toHaveTextContent('Hosted on')
    expect(screen.getByTestId('edge-s->c')).toHaveTextContent('Installed on')
    expect(screen.getByText('Every link is required: an alternative is another chain.')).toBeInTheDocument()
    const [hosted, installed] = flow.props!.edges
    expect(hosted).toMatchObject({ source: 'r', target: 's', markerEnd: { type: 'arrowclosed' } })
    expect(hosted!.style).not.toHaveProperty('strokeDasharray')
    // The certificate is the relation's source: the arrow points up, to the server.
    expect(installed).toMatchObject({ source: 's', target: 'c', markerStart: { type: 'arrowclosed' } })
    expect(installed).not.toHaveProperty('markerEnd')
    expect(installed!.style).not.toHaveProperty('strokeDasharray')
    // The tree places the boxes: nothing to drag, nothing to connect by hand.
    expect(flow.props).toMatchObject({ nodesDraggable: false, nodesConnectable: false })
  })

  it('a click on a box chooses it; a click on the empty canvas lets it go', () => {
    const onChoose = vi.fn()
    renderWithProviders(<ChainCanvas nodes={NODES} chosenId={null} onChoose={onChoose} />)
    fireEvent.click(screen.getAllByTestId('chain-box')[2]!)
    expect(onChoose).toHaveBeenLastCalledWith('c')
    fireEvent.click(screen.getByTestId('pane'))
    expect(onChoose).toHaveBeenLastCalledWith(null)
  })

  it('the boxes sit where the tree puts them: the root above, its child below', () => {
    renderWithProviders(<ChainCanvas nodes={NODES} chosenId={null} onChoose={vi.fn()} />)
    const [root, server] = flow.props!.nodes
    expect(root!.position.y).toBeLessThan(server!.position.y)
  })
})
