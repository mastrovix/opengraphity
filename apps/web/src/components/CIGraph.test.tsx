/**
 * THE DEPENDENCY GRAPH OF A CI (CI detail page).
 *
 * Around the CI being read, the graph draws what it depends on (blue), what
 * depends on it (green) and — on request — its blast radius (amber, dashed),
 * each CI with its metamodel icon, its name, its type and the relation that
 * ties it. A person uses it to answer «what breaks if this breaks»: so a CI
 * that is both a dependency and a dependent is drawn once, the blast radius
 * leaves out the direct neighbours and the CI itself and stops at the depth
 * chosen, clicking a neighbour opens that CI, and hovering one tells its type,
 * status and environment. Once the layout settles, the view fits every node.
 *
 * jsdom has no layout engine: the force simulation is created by the real d3
 * but stopped at once, and the test moves it on by hand (`sim.tick()`) and
 * repaints it (the `tick` listener), so what is asserted is what the component
 * decides — nodes, roles, arrows, where they end — never a timing. jsdom's
 * <svg> has no `width.baseVal` either, which d3-zoom reads: it is given one.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { select, type Simulation, type SimulationNodeDatum } from 'd3'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { MetamodelContext, type CITypeDef } from '@/contexts/MetamodelContext'
import { BROKEN_ICON_COLOR } from '@/lib/ciIconPaths'
import { fitTransform } from '@/lib/d3/graphPrimitives'

type Datum = SimulationNodeDatum & { id: string; role: string }
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

const { CIGraph } = await import('./CIGraph')

// ── jsdom: an <svg> has a size for d3-zoom ───────────────────────────────────
// Left in place for the whole file (its jsdom goes with it): a zoom transition
// still running when the last test ends reads it too.
beforeAll(() => {
  for (const [dim, value] of [['width', 800], ['height', 600]] as const) {
    Object.defineProperty(SVGSVGElement.prototype, dim, { configurable: true, get: () => ({ baseVal: { value } }) })
  }
})

// ── Fixtures ────────────────────────────────────────────────────────────────
const ci = (id: string, name: string, type: string, over: Record<string, unknown> = {}) => ({ id, name, type, status: 'active', ...over })

const CENTER = ci('app-1', 'Payments application', 'application', { environment: 'production' })
const SERVER = ci('srv-1', 'web-server-01-frankfurt', 'server', { environment: 'production' })
const DB = ci('db-1', 'Payments DB', 'database', { status: 'maintenance' })
const PORTAL = ci('portal', 'Web portal', 'business_application')

const DEPENDENCIES = [{ relationType: 'HOSTED_ON', ci: SERVER }, { relationType: 'DEPENDS_ON', ci: DB }]
// The database depends on the application AND the application on it: a cycle, drawn once.
const DEPENDENTS = [{ relationType: 'USED_BY', ci: PORTAL }, { relationType: 'REPLICATES_TO', ci: DB }]
const BLAST = [
  { ...ci('rep', 'Reporting', 'application'), parentId: 'portal', distance: 2 },
  { ...ci('lake', 'Data lake', 'database'), parentId: null, distance: 4 },
  { ...ci('arch', 'Archive', 'server') },
  // Already a direct dependency, and the CI itself: never repeated in the blast radius.
  { ...SERVER, parentId: 'app-1', distance: 1 },
  { ...CENTER, distance: 0 },
]

const typeDef = (name: string, icon: string) => ({ id: name, name, label: name, icon, color: '#000', active: true, scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null, fields: [], relations: [], systemRelations: [] }) as CITypeDef
const TYPES = [typeDef('application', 'globe'), typeDef('server', 'server'), typeDef('database', 'database'), typeDef('business_application', 'briefcase')]

function show(props: Partial<Parameters<typeof CIGraph>[0]> = {}) {
  const view = renderWithProviders(
    <MetamodelContext.Provider value={{ ciTypes: TYPES, loading: false, error: null, getCIType: (n) => TYPES.find((t) => t.name === n) }}>
      <CIGraph centerCI={CENTER} dependencies={DEPENDENCIES} dependents={DEPENDENTS} blastRadius={BLAST} {...props} />
    </MetamodelContext.Provider>,
    { route: '/ci/application/app-1' },
  )
  const svg = view.container.querySelector('svg:not(.lucide)') as SVGSVGElement
  return { ...view, svg }
}

const layout = () => layouts.at(-1) as Layout
/** The window jsdom accepts as the `view` of a mouse event (d3-drag listens on it for the moves). */
const jsdomWindow = () => (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window
const paint = () => layout().on('tick')!.call(layout() as never)
/** The node group of a CI, by the name it shows. */
const nodeOf = (label: string) => [...document.querySelectorAll('g.nodes > g')].find((g) => g.querySelector('text')?.textContent === label) as SVGGElement
const nodes = () => [...document.querySelectorAll('g.nodes > g')].map((g) => {
  const texts = [...g.querySelectorAll('text')].map((t) => t.textContent)
  const circle = g.querySelector('circle')!
  return { name: texts[0], type: texts[1], relation: texts[2] ?? null, r: circle.getAttribute('r'), ring: circle.getAttribute('stroke'), fill: circle.getAttribute('fill') }
})
const links = () => [...document.querySelectorAll('g.links > line')].map((l) => ({
  stroke: l.getAttribute('stroke'), dash: l.getAttribute('stroke-dasharray'), head: l.getAttribute('marker-end'),
}))

describe('CIGraph — what is drawn', () => {
  it('the CI in the middle, its dependencies and its dependents, a CI in a cycle drawn once', () => {
    show()
    expect(nodes()).toEqual([
      { name: 'Payments appl…', type: 'application', relation: null, r: '28', ring: 'var(--color-white)', fill: 'var(--color-brand)' },
      // Long names are cut at 14 characters; the relation reads without underscores.
      { name: 'web-server-01…', type: 'server', relation: 'HOSTED ON', r: '22', ring: 'var(--color-brand)', fill: 'var(--color-white)' },
      { name: 'Payments DB', type: 'database', relation: 'DEPENDS ON', r: '22', ring: 'var(--color-brand)', fill: 'var(--color-white)' },
      { name: 'Web portal', type: 'business application', relation: 'USED BY', r: '22', ring: 'var(--color-trigger-automatic)', fill: 'var(--color-white)' },
    ])
    // Two arrows out to the dependencies, two in from the dependents (the cycle has both).
    expect(links()).toEqual([
      { stroke: 'var(--color-brand)', dash: null, head: 'url(#arrow-dependency)' },
      { stroke: 'var(--color-brand)', dash: null, head: 'url(#arrow-dependency)' },
      { stroke: 'var(--color-trigger-automatic)', dash: null, head: 'url(#arrow-dependent)' },
      { stroke: 'var(--color-trigger-automatic)', dash: null, head: 'url(#arrow-dependent)' },
    ])
    for (const role of ['dependency', 'dependent', 'blast']) expect(document.getElementById(`arrow-${role}`)).not.toBeNull()
  })

  it('each CI carries its metamodel icon, white on the CI in the middle; an unknown type gets the red «?»', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    show({ dependents: [{ relationType: 'PROTECTS', ci: ci('fw', 'Edge firewall', 'firewall') }] })
    const icon = (label: string) => nodeOf(label).querySelector('.node-icon')!.firstElementChild!
    expect(icon('Payments appl…').tagName).toBe('circle') // globe
    expect(icon('Payments appl…')).toHaveAttribute('stroke', 'var(--color-white)')
    expect(icon('web-server-01…').tagName).toBe('rect') // server
    expect(icon('web-server-01…')).toHaveAttribute('stroke', 'var(--color-brand)')
    expect(icon('Edge firewall')).toHaveAttribute('stroke', BROKEN_ICON_COLOR)
    expect(error).toHaveBeenCalledWith('[CI_ICON] CI type with no icon in the metamodel: "firewall"')
  })

  it('the legend names the three kinds of neighbour', () => {
    show()
    for (const label of ['Dependencies (this CI depends on)', 'Dependents (depend on this CI)', 'Blast radius (indirect impact)']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })
})

describe('CIGraph — the blast radius', () => {
  it('is off until asked; then it adds the indirect CIs, dashed, without the direct neighbours or the CI itself', async () => {
    const { user } = show()
    expect(screen.queryByLabelText('Max depth')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'Show blast radius' }))
    expect(nodes().map((n) => n.name)).toEqual(['Payments appl…', 'web-server-01…', 'Payments DB', 'Web portal', 'Reporting', 'Data lake', 'Archive'])
    const blast = nodes().filter((n) => ['Reporting', 'Data lake', 'Archive'].includes(n.name!))
    for (const n of blast) expect(n).toMatchObject({ r: '18', ring: 'var(--color-trigger-timer)', relation: null })
    expect(nodeOf('Reporting').querySelector('circle')).toHaveAttribute('opacity', '0.7')
    expect(links().slice(4)).toEqual(Array(3).fill({ stroke: 'var(--color-trigger-timer)', dash: '4', head: 'url(#arrow-blast)' }))
  })

  it('an indirect CI hangs from the CI it is reached through, or from the CI in the middle', async () => {
    const { user } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Show blast radius' }))
    const drawn = [...document.querySelectorAll('g.links > line')].slice(4).map((l) => select<Element, { source: Datum; target: Datum }>(l).datum())
    expect(drawn.map((l) => [l.source.id, l.target.id])).toEqual([['portal', 'rep'], ['app-1', 'lake'], ['app-1', 'arch']])
  })

  it('the depth chosen cuts the CIs further away', async () => {
    const { user } = show()
    await user.click(screen.getByRole('checkbox', { name: 'Show blast radius' }))
    expect(screen.getByLabelText('Max depth')).toHaveValue('5')
    await user.selectOptions(screen.getByLabelText('Max depth'), '2')
    expect(nodes().map((n) => n.name)).toEqual(['Payments appl…', 'web-server-01…', 'Payments DB', 'Web portal', 'Reporting', 'Archive'])
    await user.selectOptions(screen.getByLabelText('Max depth'), '1')
    expect(nodes().map((n) => n.name)).not.toContain('Reporting')
  })
})

describe('CIGraph — reading and opening a neighbour', () => {
  it('clicking a neighbour opens that CI; the CI in the middle is the page already open', async () => {
    show()
    expect(nodeOf('Payments appl…')).toHaveAttribute('cursor', 'default')
    fireEvent.click(nodeOf('Payments appl…'))
    await attendiURL('/ci/application/app-1')
    expect(nodeOf('web-server-01…')).toHaveAttribute('cursor', 'pointer')
    fireEvent.click(nodeOf('web-server-01…'))
    await attendiURL('/ci/server/srv-1')
  })

  it('hovering tells the full name, type, status and environment, follows the pointer, and goes away', () => {
    show()
    fireEvent.mouseOver(nodeOf('web-server-01…'), { clientX: 100, clientY: 50 })
    const tip = screen.getByText('web-server-01-frankfurt').parentElement!
    expect(tip).toHaveTextContent('Type: server')
    expect(tip).toHaveTextContent('Status: active')
    expect(tip).toHaveTextContent('Environment: production')
    expect(tip).toHaveStyle({ left: '112px', top: '40px' })
    fireEvent.mouseMove(nodeOf('web-server-01…'), { clientX: 150, clientY: 80 })
    expect(tip).toHaveStyle({ left: '162px', top: '70px' })
    fireEvent.mouseOut(nodeOf('web-server-01…'))
    expect(screen.queryByText('web-server-01-frankfurt')).toBeNull()
  })

  it('a CI without an environment has no environment line; moving without hovering first shows nothing', () => {
    show()
    fireEvent.mouseMove(nodeOf('Payments DB'), { clientX: 10, clientY: 10 })
    expect(screen.queryByText(/Status:/)).toBeNull()
    fireEvent.mouseOver(nodeOf('Payments DB'), { clientX: 10, clientY: 10 })
    expect(screen.getByText(/Status:/).parentElement).toHaveTextContent('Status: maintenance')
    expect(screen.queryByText(/Environment:/)).toBeNull()
  })

  it('zooming hides the tooltip, which would otherwise point at the wrong place', () => {
    const { svg } = show()
    fireEvent.mouseOver(nodeOf('Web portal'), { clientX: 10, clientY: 10 })
    expect(screen.getByText('Web portal', { selector: 'div' })).toBeInTheDocument()
    fireEvent.wheel(svg, { deltaY: -200, clientX: 0, clientY: 0 })
    expect(svg.querySelector(':scope > g')!.getAttribute('transform')).toMatch(/scale\(1\.3/)
    expect(screen.queryByText('Web portal', { selector: 'div' })).toBeNull()
  })
})

describe('CIGraph — the layout', () => {
  it('the CI in the middle is pinned at the centre of the drawing', () => {
    show()
    layout().tick()
    paint()
    // jsdom gives no width: the drawing assumes 800 × 600.
    expect(nodeOf('Payments appl…')).toHaveAttribute('transform', 'translate(400,300)')
  })

  it('the centre follows the width of the drawing when it has one', () => {
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    show()
    layout().tick()
    paint()
    expect(nodeOf('Payments appl…')).toHaveAttribute('transform', 'translate(500,300)')
  })

  it('an arrow leaves the border of its source and stops short of its target, where the head fits', () => {
    show({ dependents: [], dependencies: [{ relationType: 'HOSTED_ON', ci: SERVER }] })
    const [center, server] = layout().nodes()
    Object.assign(center!, { x: 400, y: 300 })
    Object.assign(server!, { x: 500, y: 300 })
    paint()
    const line = document.querySelector('g.links > line')!
    // Center radius 28; target radius 22 plus 8 for the head.
    expect([line.getAttribute('x1'), line.getAttribute('x2'), line.getAttribute('y1'), line.getAttribute('y2')]).toEqual(['428', '470', '300', '300'])
    expect(nodeOf('web-server-01…')).toHaveAttribute('transform', 'translate(500,300)')
  })

  it('«Spacing» pushes the neighbours further from the CI in the middle', () => {
    const distance = () => {
      layout().tick(300)
      paint()
      const at = (label: string) => nodeOf(label).getAttribute('transform')!.match(/translate\(([-\d.e]+),([-\d.e]+)\)/)!.slice(1).map(Number)
      const [cx, cy] = at('Payments appl…'), [sx, sy] = at('web-server-01…')
      return Math.hypot(sx! - cx!, sy! - cy!)
    }
    show()
    const tight = distance()
    fireEvent.change(screen.getByLabelText('Spacing'), { target: { value: '2.5' } })
    const loose = distance()
    expect(loose).toBeGreaterThan(tight * 1.8)
  })

  it('once the layout settles, the view is fitted to every node', async () => {
    const { svg } = show()
    const all = layout().nodes()
    all.forEach((n, i) => Object.assign(n, { x: -400 + i * 500, y: 300 }))
    layout().on('end')!.call(layout() as never)
    const expected = fitTransform(all, 800, 600)!.toString()
    await waitFor(() => expect(svg.querySelector(':scope > g')).toHaveAttribute('transform', expected), { timeout: 10_000 })
    expect(expected).toMatch(/scale\(0\.\d+\)/)
  })

  it('a neighbour follows the pointer while dragged and goes back to the layout when released; the CI in the middle cannot be moved', () => {
    show()
    const view = jsdomWindow()
    const sim = layout()
    const [center, server] = sim.nodes()
    Object.assign(server!, { x: 500, y: 300 })

    fireEvent.mouseDown(nodeOf('web-server-01…'), { clientX: 0, clientY: 0, view })
    fireEvent.mouseMove(nodeOf('web-server-01…'), { clientX: 40, clientY: 30, view })
    sim.tick()
    paint()
    expect(nodeOf('web-server-01…')).toHaveAttribute('transform', 'translate(540,330)')
    // The layout is woken up while a node moves, and let rest after.
    expect(sim.restart).toHaveBeenCalled()
    expect(sim.alphaTarget()).toBe(0.3)
    fireEvent.mouseUp(nodeOf('web-server-01…'), { clientX: 40, clientY: 30, view })
    expect(sim.alphaTarget()).toBe(0)
    expect(server).toMatchObject({ fx: null, fy: null })

    fireEvent.mouseDown(nodeOf('Payments appl…'), { clientX: 0, clientY: 0, view })
    fireEvent.mouseMove(nodeOf('Payments appl…'), { clientX: 100, clientY: 100, view })
    fireEvent.mouseUp(nodeOf('Payments appl…'), { clientX: 100, clientY: 100, view })
    sim.tick()
    paint()
    expect(center).toMatchObject({ fx: 400, fy: 300 })
    expect(nodeOf('Payments appl…')).toHaveAttribute('transform', 'translate(400,300)')
  })
})

// Review of 23 Sep 2026: the graph printed the raw type and relation, next to a CMDB list with the customer's names.
describe('CIGraph — the customer\'s names', () => {
  it('a type reads with its label in the reader\'s language, a relation with its metamodel label', () => {
    const types = TYPES.map((t) => t.name === 'server'
      ? { ...t, labels: [{ language: 'en', label: 'Physical server' }] }
      : t.name === 'application'
        ? { ...t, relations: [{ id: 'r1', name: 'hostedOn', label: 'runs on', relationshipType: 'HOSTED_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 1 }] }
        : t) as CITypeDef[]
    renderWithProviders(
      <MetamodelContext.Provider value={{ ciTypes: types, loading: false, error: null, getCIType: (n) => types.find((t) => t.name === n) }}>
        <CIGraph centerCI={CENTER} dependencies={DEPENDENCIES} dependents={DEPENDENTS} blastRadius={BLAST} />
      </MetamodelContext.Provider>,
      { route: '/ci/application/app-1' },
    )
    // The node reached through HOSTED_ON is the server (names are cut at 14 characters).
    expect(nodes().find((n) => n.relation === 'runs on')).toMatchObject({ type: 'Physical server' })
  })
})
