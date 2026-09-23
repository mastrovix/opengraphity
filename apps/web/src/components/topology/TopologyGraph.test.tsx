/**
 * THE TOPOLOGY MAP (Topology page): the CIs around a root and how they relate.
 *
 * A person reads here, at a glance: which CI the map is about (cyan, in the
 * middle, full name), which CIs have open incidents (pulsing red ring) or open
 * changes (purple ring), which are in maintenance (dimmed), and — with «highlight
 * health» — which are down or degraded. Hovering a CI or a relation isolates it,
 * clicking a CI opens its panel, a dragged CI stays where it is dropped.
 *
 * The page polls the map every 30 seconds (F-06): the same CIs and relations
 * must update in place — rings, borders, names — without redrawing, so the zoom
 * and the CIs a person has placed survive the poll; only a new CI or relation
 * redraws the map.
 *
 * jsdom has no layout engine: the force simulation is the real d3 one, stopped
 * at creation; the test moves it on (`sim.tick()`) and repaints (the `tick`
 * listener) by hand. jsdom's <svg> also lacks `width.baseVal`, which d3-zoom
 * reads to know the viewport: it is given one.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { select, type Simulation, type SimulationNodeDatum } from 'd3'
import { colors, palette } from '@/lib/tokens'
import { BROKEN_ICON_COLOR } from '@/lib/ciIconPaths'
import { EDGE_COLOR, HEALTH_COLOR, NODE_COLOR } from './topologyStyle'
import type { CITypeMeta, TopologyEdge, TopologyNode } from './TopologyGraph'

type Datum = SimulationNodeDatum & TopologyNode
type Layout = Simulation<Datum, undefined>

const layouts = vi.hoisted(() => [] as unknown[])

vi.mock('d3', async (importOriginal) => {
  const d3 = await importOriginal<typeof import('d3')>()
  return {
    ...d3,
    forceSimulation: ((nodes?: SimulationNodeDatum[]) => {
      const sim = d3.forceSimulation(nodes)
      sim.stop() // the test moves the layout on, not a timer
      sim.restart = vi.fn(() => sim)
      layouts.push(sim)
      return sim
    }) as typeof d3.forceSimulation,
  }
})

const { default: TopologyGraph } = await import('./TopologyGraph')

// ── jsdom: an <svg> has a size for d3-zoom ───────────────────────────────────
// Left in place for the whole file (its jsdom goes with it): a zoom transition
// still running when the last test ends reads it too.
beforeAll(() => {
  for (const [dim, value] of [['width', 1000], ['height', 600]] as const) {
    Object.defineProperty(SVGSVGElement.prototype, dim, { configurable: true, get: () => ({ baseVal: { value } }) })
  }
})

// ── Fixtures ────────────────────────────────────────────────────────────────
const ci = (id: string, over: Partial<TopologyNode> = {}): TopologyNode => ({
  id, name: id, type: 'server', status: 'active', inMaintenance: false, environment: 'production', ownerGroup: 'Ops',
  incidentCount: 0, changeCount: 0, health: null, ...over,
})
const APP = ci('app', { name: 'Payments application', type: 'application', health: 'operational' })
const DB = ci('db', { name: 'Payments database', type: 'database', incidentCount: 2, health: 'down' })
const WEB = ci('web', { name: 'web-01', changeCount: 1 })
const LB = ci('lb', { name: 'Load balancer', inMaintenance: true, health: 'degraded' })
const LONE = ci('lone', { name: 'Isolated host' })
const NODES = [APP, DB, WEB, LB, LONE]
const EDGES: TopologyEdge[] = [
  { source: 'app', target: 'db', type: 'DEPENDS_ON' },
  { source: 'app', target: 'web', type: 'HOSTED_ON' },
  { source: 'lb', target: 'web', type: 'CONNECTS_TO' },
  // Towards a CI the map does not carry: no arrow into the void.
  { source: 'app', target: 'ghost', type: 'DEPENDS_ON' },
]
const CI_TYPES: CITypeMeta[] = [
  { name: 'application', label: 'Application', icon: 'globe', color: '#000' },
  { name: 'server', label: 'Server', icon: 'server', color: '#000' },
  { name: 'database', label: 'Database', icon: 'database', color: '#000' },
]
/** Fresh objects with the same content: what a poll of the page hands over. */
const polled = (nodes: TopologyNode[]) => nodes.map((n) => ({ ...n }))

type Props = Parameters<typeof TopologyGraph>[0]
function show(over: Partial<Props> = {}) {
  const props: Props = { nodes: NODES, edges: EDGES, onNodeClick: vi.fn(), showLabels: false, rootNodeId: 'app', ciTypes: CI_TYPES, ...over }
  const view = render(<TopologyGraph {...props} />)
  return { ...view, props, redraw: (next: Partial<Props>) => view.rerender(<TopologyGraph {...props} {...next} />) }
}

const layout = () => layouts.at(-1) as Layout
const paint = () => layout().on('tick')!.call(layout() as never)
const jsdomWindow = () => (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window
const svgEl = () => document.querySelector('svg') as SVGSVGElement
const root = () => svgEl().querySelector('g.topo-root')!
const datum = (id: string) => layout().nodes().find((n) => n.id === id)!
/** The group of a CI on the map, by the CI it is bound to (the label is cut, the datum is not). */
const nodeOf = (id: string) => [...document.querySelectorAll<SVGGElement>('g.nodes > g')].find((g) => select<SVGGElement, Datum>(g).datum().id === id)!
const bg = (id: string) => nodeOf(id).querySelector('.node-bg')!
const label = (id: string) => nodeOf(id).querySelector('.node-label') as SVGTextElement
const icon = (id: string) => nodeOf(id).querySelector('.node-icon')!.firstElementChild!
const ring = (id: string, kind: 'incident' | 'change') => nodeOf(id).querySelector(`.topo-pulse-${kind}`)
const lines = () => [...document.querySelectorAll('g.links > line')]
const lineBetween = (s: string, t: string) => lines().find((l) => {
  const d = select<Element, { source: Datum; target: Datum }>(l).datum()
  return d.source.id === s && d.target.id === t
})!
const edgeLabels = () => [...document.querySelectorAll('g.edge-labels > text')]
const opacities = () => Object.fromEntries(NODES.map((n) => [n.id, nodeOf(n.id).style.opacity]))
const at = (x: number, y: number) => `translate(${x},${y})`

describe('TopologyGraph — what is on the map', () => {
  it('one node per CI and one arrow per relation between CIs on the map, each with its relation name', () => {
    show()
    expect(document.querySelectorAll('g.nodes > g')).toHaveLength(5)
    expect(lines()).toHaveLength(3)
    expect(lines().map((l) => l.getAttribute('marker-end'))).toEqual(['url(#arrow-DEPENDS_ON)', 'url(#arrow-HOSTED_ON)', 'url(#arrow-CONNECTS_TO)'])
    for (const type of ['DEPENDS_ON', 'HOSTED_ON', 'CONNECTS_TO']) expect(document.getElementById(`arrow-${type}`)).not.toBeNull()
    // The relation names are there, readable, and hidden until a relation is hovered.
    expect(edgeLabels().map((t) => t.textContent)).toEqual(['Depends on', 'Hosted on', 'Connects to'])
    for (const t of edgeLabels()) expect(t).toHaveStyle({ display: 'none' })
  })

  it('the root is cyan with a white icon and its full name in bold; the other CIs are white, slate icon, name cut at 12', () => {
    show()
    expect(bg('app')).toHaveAttribute('fill', EDGE_COLOR)
    expect(icon('app')).toHaveAttribute('stroke', colors.white)
    expect(label('app')).toHaveTextContent('Payments application')
    expect(label('app')).toHaveAttribute('font-weight', '700')
    expect(bg('lone')).toHaveAttribute('fill', colors.white)
    expect(icon('lone')).toHaveAttribute('stroke', NODE_COLOR)
    expect(label('lone')).toHaveTextContent('Isolated ho…')
    expect(label('lone')).toHaveAttribute('font-weight', '400')
    expect(label('web')).toHaveTextContent('web-01')
  })

  it('each CI carries the icon of its type in the metamodel', () => {
    show()
    // globe → circle, database → ellipse, server → rect: the first shape of each lucide icon.
    expect([icon('app').tagName, icon('db').tagName, icon('web').tagName]).toEqual(['circle', 'ellipse', 'rect'])
  })

  it('open incidents draw a red ring, open changes a purple one, and the border gives way; a CI in maintenance is dimmed', () => {
    show()
    expect(ring('db', 'incident')).toHaveAttribute('stroke', 'var(--color-trigger-sla-breach)')
    expect(ring('db', 'incident')).toHaveAttribute('r', '22')
    expect(ring('db', 'change')).toBeNull()
    expect(ring('web', 'change')).toHaveAttribute('stroke', palette.purple.light)
    expect(ring('web', 'change')).toHaveAttribute('r', '20')
    expect(bg('db')).toHaveAttribute('stroke', 'none')
    expect(bg('web')).toHaveAttribute('stroke', 'none')
    expect(bg('lone')).toHaveAttribute('stroke', NODE_COLOR)
    expect(bg('lb')).toHaveAttribute('opacity', '0.65')
    expect(bg('lone')).toHaveAttribute('opacity', '1')
    // The rings pulse: the animation is in the page once, however many maps are drawn.
    show()
    expect(document.querySelectorAll('#topo-pulse-style')).toHaveLength(1)
    expect(document.getElementById('topo-pulse-style')!.textContent).toContain('topo-pulse-incident')
  })

  it('an empty map draws nothing', () => {
    const { container } = show({ nodes: [], edges: [] })
    expect(container.querySelector('svg')).toBeNull()
  })

  it('without the metamodel\'s types every icon is the red «?», and the gap is reported', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    show({ ciTypes: undefined })
    expect(icon('web')).toHaveAttribute('stroke', BROKEN_ICON_COLOR)
    expect(error).toHaveBeenCalledWith('[CI_ICON] CI type with no icon in the metamodel: "server"')
  })

  it('a root that is not on the map is not drawn as one', () => {
    show({ rootNodeId: 'elsewhere' })
    expect(bg('app')).toHaveAttribute('fill', colors.white)
    expect(label('app')).toHaveTextContent('Payments ap…')
    expect(datum('app').fx).toBeUndefined()
  })
})

describe('TopologyGraph — labels and zoom', () => {
  it('names are hidden unless asked; zooming in past 0.8 shows them, zooming out hides them again', () => {
    show()
    expect(label('db')).toHaveStyle({ display: 'none' })
    fireEvent.wheel(svgEl(), { deltaY: -200 })
    expect(root().getAttribute('transform')).toMatch(/scale\(1\.3/)
    expect(label('db')).toHaveStyle({ display: 'block' })
    fireEvent.wheel(svgEl(), { deltaY: 600 })
    expect(root().getAttribute('transform')).toMatch(/scale\(0\.5/)
    expect(label('db')).toHaveStyle({ display: 'none' })
  })

  it('with «show labels» the names stay, however far one zooms out', () => {
    show({ showLabels: true })
    expect(label('db')).toHaveStyle({ display: 'block' })
    fireEvent.wheel(svgEl(), { deltaY: 600 })
    expect(label('db')).toHaveStyle({ display: 'block' })
  })

  it('once the layout settles the map is re-centred at 85%', async () => {
    show()
    layout().on('end')!.call(layout() as never)
    await waitFor(() => expect(root()).toHaveAttribute('transform', 'translate(75,45) scale(0.85)'), { timeout: 10_000 })
  })

  it('a double click on the background brings the map back to the same view after zooming around', async () => {
    show()
    fireEvent.wheel(svgEl(), { deltaY: 600 })
    expect(root().getAttribute('transform')).toMatch(/scale\(0\.4/)
    fireEvent.dblClick(svgEl())
    await waitFor(() => expect(root()).toHaveAttribute('transform', 'translate(75,45) scale(0.85)'), { timeout: 10_000 })
  })
})

describe('TopologyGraph — hovering and clicking', () => {
  it('hovering a relation names it and fades the CIs it does not join; leaving restores', () => {
    show()
    const hosted = lineBetween('app', 'web')
    fireEvent.mouseOver(hosted)
    expect(edgeLabels()[1]).toHaveStyle({ display: 'block' })
    expect(edgeLabels()[0]).toHaveStyle({ display: 'none' })
    expect(hosted).toHaveAttribute('stroke-opacity', '0.9')
    expect(opacities()).toEqual({ app: '1', db: '0.2', web: '1', lb: '0.2', lone: '0.2' })
    fireEvent.mouseOut(hosted)
    expect(edgeLabels()[1]).toHaveStyle({ display: 'none' })
    expect(hosted).toHaveAttribute('stroke-opacity', '0.5')
    expect(opacities()).toEqual({ app: '1', db: '1', web: '1', lb: '1', lone: '1' })
  })

  it('hovering a CI keeps it, its neighbours and their relations in view and fades the rest; leaving restores', async () => {
    show()
    fireEvent.mouseOver(nodeOf('web'))
    expect(opacities()).toEqual({ app: '1', db: '0.1', web: '1', lb: '1', lone: '0.1' })
    expect(lineBetween('app', 'web')).toHaveAttribute('stroke-opacity', '0.8')
    expect(lineBetween('lb', 'web')).toHaveAttribute('stroke-width', '2')
    expect(lineBetween('app', 'db')).toHaveAttribute('stroke-opacity', '0.05')
    // The hovered CI grows a little.
    await waitFor(() => expect(bg('web')).toHaveAttribute('r', '20.8'), { timeout: 10_000 })
    fireEvent.mouseOut(nodeOf('web'))
    expect(opacities()).toEqual({ app: '1', db: '1', web: '1', lb: '1', lone: '1' })
    expect(lineBetween('app', 'db')).toHaveAttribute('stroke-opacity', '0.5')
    await waitFor(() => expect(bg('web')).toHaveAttribute('r', '16'), { timeout: 10_000 })
    // The relations it starts count as much as the ones that reach it.
    fireEvent.mouseOver(nodeOf('lb'))
    expect(opacities()).toEqual({ app: '0.1', db: '0.1', web: '1', lb: '1', lone: '0.1' })
    expect(lineBetween('lb', 'web')).toHaveAttribute('stroke-opacity', '0.8')
  })

  it('clicking a CI hands it to the page', () => {
    const { props } = show()
    fireEvent.click(nodeOf('web'))
    expect(props.onNodeClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'web', name: 'web-01', changeCount: 1 }))
  })
})

describe('TopologyGraph — the layout', () => {
  it('the root is pinned at the centre of the map', () => {
    show()
    layout().tick()
    paint()
    // jsdom gives no size: the map assumes 1000 × 600.
    expect(nodeOf('app')).toHaveAttribute('transform', at(500, 300))
  })

  it('the centre and the re-centring follow the size of the container when it has one', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
    show()
    layout().tick()
    paint()
    expect(nodeOf('app')).toHaveAttribute('transform', at(400, 200))
    layout().on('end')!.call(layout() as never)
    await waitFor(() => expect(root()).toHaveAttribute('transform', 'translate(60,30) scale(0.85)'), { timeout: 10_000 })
  })

  it('an arrow leaves the outer ring of its CI and stops at the outer ring of the other: incident ring, change ring, or border', () => {
    show()
    Object.assign(datum('app'), { x: 0, y: 0 })
    Object.assign(datum('db'), { x: 100, y: 0 })   // incident ring: 16 + 6 + 3
    Object.assign(datum('web'), { x: 0, y: 100 })  // change ring: 16 + 4 + 3
    Object.assign(datum('lb'), { x: 200, y: 100 }) // plain: 16 + 2
    paint()
    const ends = (l: Element) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a)))
    expect(ends(lineBetween('app', 'db'))).toEqual([18, 0, 75, 0])
    expect(ends(lineBetween('app', 'web'))).toEqual([0, 18, 0, 77])
    expect(ends(lineBetween('lb', 'web'))).toEqual([182, 100, 23, 100])
    // The relation name sits in the middle of its arrow, just above it.
    expect([edgeLabels()[0]!.getAttribute('x'), edgeLabels()[0]!.getAttribute('y')]).toEqual(['50', '-4'])
    expect(nodeOf('db')).toHaveAttribute('transform', at(100, 0))
  })

  it('a dragged CI stays where it is dropped; a double click lets it go — but never the root', () => {
    show()
    const view = jsdomWindow()
    Object.assign(datum('web'), { x: 300, y: 200 })
    fireEvent.mouseDown(nodeOf('web'), { clientX: 0, clientY: 0, view })
    fireEvent.mouseMove(nodeOf('web'), { clientX: 50, clientY: -20, view })
    fireEvent.mouseUp(nodeOf('web'), { clientX: 50, clientY: -20, view })
    expect(layout().restart).toHaveBeenCalled()
    layout().tick(5)
    paint()
    expect(nodeOf('web')).toHaveAttribute('transform', at(350, 180))

    fireEvent.dblClick(nodeOf('web'))
    expect(datum('web')).toMatchObject({ fx: null, fy: null })
    fireEvent.dblClick(nodeOf('app'))
    expect(datum('app')).toMatchObject({ fx: 500, fy: 300 })
  })
})

describe('TopologyGraph — the page polls (F-06)', () => {
  it('the same CIs with new counters are updated in place: rings, border, name — the drawing, zoom and layout stay', () => {
    const { redraw } = show()
    fireEvent.wheel(svgEl(), { deltaY: -200 })
    const drawing = svgEl()
    const zoomed = root().getAttribute('transform')
    const layoutsBefore = layouts.length
    redraw({ nodes: polled(NODES).map((n) =>
      n.id === 'db' ? { ...n, incidentCount: 0 }
      : n.id === 'web' ? { ...n, changeCount: 0, name: 'web-01-renamed' }
      : n.id === 'lone' ? { ...n, incidentCount: 1 } : n) })
    expect(svgEl()).toBe(drawing)
    expect(layouts).toHaveLength(layoutsBefore)
    expect(root()).toHaveAttribute('transform', zoomed)
    expect(ring('db', 'incident')).toBeNull()
    expect(bg('db')).toHaveAttribute('stroke', NODE_COLOR)
    expect(ring('web', 'change')).toBeNull()
    expect(label('web')).toHaveTextContent('web-01-rena…')
    expect(ring('lone', 'incident')).not.toBeNull()
    expect(bg('lone')).toHaveAttribute('stroke', 'none')
  })

  it('a poll where only the health changed still reaches the map', () => {
    const { redraw } = show({ highlightHealth: true })
    redraw({ highlightHealth: true, nodes: polled(NODES).map((n) => (n.id === 'lone' ? { ...n, health: 'down' } : n)) })
    expect(bg('lone')).toHaveAttribute('fill', HEALTH_COLOR['down']!.fill)
    expect(bg('lone')).toHaveAttribute('stroke', HEALTH_COLOR['down']!.stroke)
  })

  it('an identical poll touches nothing', () => {
    const { redraw } = show()
    const pulse = ring('db', 'incident')
    redraw({ nodes: polled(NODES) })
    expect(ring('db', 'incident')).toBe(pulse)
  })

  it('a new CI redraws the map with it', () => {
    const { redraw } = show()
    const drawing = svgEl()
    redraw({ nodes: [...polled(NODES), ci('new', { name: 'New host' })], edges: [...EDGES, { source: 'new', target: 'web', type: 'CONNECTS_TO' }] })
    expect(svgEl()).not.toBe(drawing)
    expect(document.querySelectorAll('svg')).toHaveLength(1)
    expect(label('new')).toHaveTextContent('New host')
    expect(lines()).toHaveLength(4)
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: the in-place update
   * neither compared nor copied `inMaintenance`, so a CI entering maintenance
   * while the map was open was not dimmed (nor one leaving it undimmed) until
   * a CI or a relation was added or removed.
   */
  it('a CI entering maintenance during a poll is dimmed', () => {
    const { redraw } = show()
    redraw({ nodes: polled(NODES).map((n) => (n.id === 'lone' ? { ...n, inMaintenance: true } : n)) })
    expect(bg('lone')).toHaveAttribute('opacity', '0.65')
  })
})

describe('TopologyGraph — health', () => {
  it('«highlight health» paints a CI down in red and one degraded in amber, over its rings; switching it off restores', () => {
    const { redraw } = show()
    expect(bg('db')).toHaveAttribute('fill', colors.white)
    redraw({ highlightHealth: true })
    expect(bg('db')).toHaveAttribute('fill', HEALTH_COLOR['down']!.fill)
    expect(bg('db')).toHaveAttribute('stroke', HEALTH_COLOR['down']!.stroke)
    expect(bg('lb')).toHaveAttribute('fill', HEALTH_COLOR['degraded']!.fill)
    // «operational» has no colour of its own: the root stays cyan, a plain CI white.
    expect(bg('app')).toHaveAttribute('fill', EDGE_COLOR)
    expect(bg('web')).toHaveAttribute('fill', colors.white)
    redraw({ highlightHealth: false })
    expect(bg('db')).toHaveAttribute('fill', colors.white)
    expect(bg('db')).toHaveAttribute('stroke', 'none')
    expect(bg('lb')).toHaveAttribute('stroke', NODE_COLOR)
  })

  it('a root that is down, drawn with health highlighted, gets a slate icon that shows on the red', () => {
    show({ highlightHealth: true, nodes: [{ ...APP, health: 'down' }, WEB], edges: [] })
    expect(bg('app')).toHaveAttribute('fill', HEALTH_COLOR['down']!.fill)
    expect(icon('app')).toHaveAttribute('stroke', NODE_COLOR)
  })

  it('a root with no health known keeps its white icon on cyan, even with health highlighted', () => {
    show({ highlightHealth: true, nodes: [{ ...APP, health: null }, WEB], edges: [] })
    expect(bg('app')).toHaveAttribute('fill', EDGE_COLOR)
    expect(icon('app')).toHaveAttribute('stroke', colors.white)
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: the root's icon colour was
   * decided only when the map was drawn, so switching «highlight health» on
   * afterwards turned a down root pale red and left its icon white, nearly
   * invisible.
   */
  it('switching «highlight health» on after drawing gives a down root the same slate icon', () => {
    const { redraw } = show({ nodes: [{ ...APP, health: 'down' }, WEB], edges: [] })
    redraw({ nodes: [{ ...APP, health: 'down' }, WEB], edges: [], highlightHealth: true })
    expect(bg('app')).toHaveAttribute('fill', HEALTH_COLOR['down']!.fill)
    expect(icon('app')).toHaveAttribute('stroke', NODE_COLOR)
  })

  it('a root that goes down during a poll, with health highlighted, turns red with a slate icon', () => {
    const { redraw } = show({ highlightHealth: true })
    expect(icon('app')).toHaveAttribute('stroke', colors.white)
    redraw({ highlightHealth: true, nodes: polled(NODES).map((n) => (n.id === 'app' ? { ...n, health: 'down' } : n)) })
    expect(bg('app')).toHaveAttribute('fill', HEALTH_COLOR['down']!.fill)
    expect(icon('app')).toHaveAttribute('stroke', NODE_COLOR)
  })
})

describe('TopologyGraph — the selected CI', () => {
  it('is outlined in orange and enlarged, with its neighbours in view and the rest faded; clearing it restores the map', () => {
    const { redraw } = show()
    redraw({ highlightNodeId: 'web' })
    expect(bg('web')).toHaveAttribute('stroke', palette.orange.base)
    expect(bg('web')).toHaveAttribute('stroke-width', '4')
    expect(bg('web')).toHaveAttribute('r', '24')
    expect(opacities()).toEqual({ app: '1', db: '0.08', web: '1', lb: '1', lone: '0.08' })
    expect(lineBetween('lb', 'web')).toHaveAttribute('stroke-opacity', '0.85')
    expect(lineBetween('lb', 'web')).toHaveAttribute('stroke-width', '2.5')
    expect(lineBetween('app', 'db')).toHaveAttribute('stroke-opacity', '0.06')
    expect(bg('db')).toHaveAttribute('r', '16')

    // A CI selected at the start of a relation keeps the CI at its end in view.
    redraw({ highlightNodeId: 'lb' })
    expect(opacities()).toEqual({ app: '0.08', db: '0.08', web: '1', lb: '1', lone: '0.08' })
    expect(bg('lb')).toHaveAttribute('stroke', palette.orange.base)
    expect(bg('web')).toHaveAttribute('r', '16')

    redraw({ highlightNodeId: null })
    expect(bg('web')).toHaveAttribute('stroke', 'none')
    expect(bg('web')).toHaveAttribute('stroke-width', '2.5')
    expect(bg('web')).toHaveAttribute('r', '16')
    expect(opacities()).toEqual({ app: '1', db: '1', web: '1', lb: '1', lone: '1' })
    expect(lineBetween('app', 'db')).toHaveAttribute('stroke-opacity', '0.5')
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: the in-place update of a
   * poll repainted every border with `nodeStroke`, the selected CI's included,
   * so a poll changing any counter took the orange outline off the selected CI
   * (latent: the Topology page always selects the root).
   */
  it('a poll keeps the orange outline of the selected CI', () => {
    const { redraw } = show({ highlightNodeId: 'web' })
    redraw({ highlightNodeId: 'web', nodes: polled(NODES).map((n) => (n.id === 'db' ? { ...n, incidentCount: 5 } : n)) })
    expect(bg('web')).toHaveAttribute('stroke', palette.orange.base)
  })

  it('selecting the root fades nothing: the whole map is about it', () => {
    const { redraw } = show({ highlightNodeId: 'web' })
    redraw({ highlightNodeId: 'app' })
    expect(opacities()).toEqual({ app: '1', db: '1', web: '1', lb: '1', lone: '1' })
    expect(lineBetween('app', 'db')).toHaveAttribute('stroke-opacity', '0.5')
    expect(bg('app')).not.toHaveAttribute('stroke', palette.orange.base)
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: when the root was selected,
   * the highlight only undid the fading, so the CI selected before stayed
   * enlarged and with a thick border.
   */
  it('selecting the root after another CI gives that CI its size and border back', () => {
    const { redraw } = show({ highlightNodeId: 'web' })
    expect(bg('web')).toHaveAttribute('r', '24')
    redraw({ highlightNodeId: 'app' })
    expect(bg('web')).toHaveAttribute('r', '16')
    expect(bg('web')).toHaveAttribute('stroke-width', '2.5')
    // Its change ring is its border again.
    expect(bg('web')).toHaveAttribute('stroke', 'none')
  })

  /**
   * Found by this test (tour of 23 Sep 2026), fixed: the highlight ran only when
   * the selection changed, so a redraw (a new CI or relation) showed the map
   * plain — the selected CI no longer outlined, the rest no longer faded.
   */
  it('a redraw for a new CI and relation keeps the selected CI outlined and the rest faded', () => {
    const { redraw } = show({ highlightNodeId: 'web' })
    const drawing = svgEl()
    redraw({
      highlightNodeId: 'web',
      nodes: [...polled(NODES), ci('new', { name: 'New host' })],
      edges: [...EDGES, { source: 'new', target: 'web', type: 'CONNECTS_TO' }],
    })
    expect(svgEl()).not.toBe(drawing)
    expect(bg('web')).toHaveAttribute('stroke', palette.orange.base)
    expect(bg('web')).toHaveAttribute('stroke-width', '4')
    expect(bg('web')).toHaveAttribute('r', '24')
    // The new CI is a neighbour of the selected one: it stays in view with its relation.
    expect(nodeOf('new').style.opacity).toBe('1')
    expect(lineBetween('new', 'web')).toHaveAttribute('stroke-opacity', '0.85')
    expect(opacities()).toEqual({ app: '1', db: '0.08', web: '1', lb: '1', lone: '0.08' })
  })
})
