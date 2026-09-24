/**
 * TOPOLOGY MAP: choosing the CI to start from, narrowing the map, and leaving it.
 *
 * The base file covers the health side (`?health=1`, `?ciId=`). This one covers
 * the rest of what a user does on the page, and what they lose if it regresses:
 *  - the CI search box: results come from the server, "showing N of M" says
 *    when more exist, a search error is shown (not an empty list), and
 *    choosing / clearing a CI moves `?ciId=`;
 *  - depth, environment and status filters must reach the topology query,
 *    otherwise the map silently ignores them;
 *  - "only with incidents" hides the quiet nodes and the totals follow;
 *  - the node panel's buttons must open the CI (where its tickets are listed),
 *    not a list of all the tenant's incidents;
 *  - a truncated graph and a failed load must say so.
 * The D3 graph is stubbed as a list of buttons: this is about the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within, fireEvent } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { renderWithProviders, attendiURL } from '@/test/utils'
import type { TopologyNode } from '@/components/topology/TopologyGraph'
import { TopologyPage } from './TopologyPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('@/components/topology/TopologyGraph', () => ({
  default: ({ nodes, onNodeClick, showLabels }: { nodes: TopologyNode[]; onNodeClick: (n: TopologyNode) => void; showLabels: boolean }) => (
    <div data-testid="graph" data-labels={String(showLabels)}>
      {nodes.map((n) => <button type="button" key={n.id} onClick={() => onNodeClick(n)}>{n.name}</button>)}
    </div>
  ),
  TopologyLegend: () => null,
  HEALTH_COLOR: {},
}))

const node = (over: Partial<TopologyNode> & { id: string; name: string }): TopologyNode => ({
  type: 'server', status: 'active', inMaintenance: false, environment: 'production', ownerGroup: null,
  incidentCount: 0, changeCount: 0, health: null, ...over,
})

const TOPOLOGY = {
  topology: {
    nodes: [
      node({ id: 'ci-1', name: 'db-01', incidentCount: 2, changeCount: 1, ownerGroup: 'DBA', health: 'down' }),
      node({ id: 'ci-2', name: 'cache-02', status: '', environment: null }),
      node({ id: 'ci-3', name: 'app-03', type: 'application', incidentCount: 1 }),
    ],
    edges: [{ source: 'ci-3', target: 'ci-1', type: 'DEPENDS_ON' }],
    truncated: false,
    nodeLimit: 500,
  },
}

const CIS = (n: number, total = n) => ({
  allCIs: {
    total,
    items: Array.from({ length: n }, (_, i) => ({ id: `ci-${i + 1}`, name: i === 0 ? 'db-01' : `srv-${i + 1}`, type: 'server', status: 'active', environment: i === 0 ? 'production' : null })),
  },
})

type TopoVars = { selectedCiId?: string; maxHops?: number; environment?: string; status?: string }
const lastTopo = () => apolloFinto.chiamata('GetTopology') as TopoVars | undefined

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCITypes'] = { ciTypes: [
    { name: '__base__', label: 'Base', icon: 'box', color: '#000' },
    { name: 'server', label: 'Server', icon: 'server', color: '#000' },
    { name: 'application', label: 'Application', icon: 'box', color: '#000' },
  ] }
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: {
    name: '__base__',
    fields: [
      { name: 'status', fieldType: 'enum', enumValues: ['active', 'inactive'] },
      { name: 'environment', fieldType: 'enum', enumValues: ['production', 'staging'] },
    ],
  } }
  apolloFinto.risposte['GetTopology'] = TOPOLOGY
  const oneCI = CIS(1)
  apolloFinto.risposte['GetAllCIs'] = oneCI
})

describe('TopologyPage — the CI search box', () => {
  // Tour of 24 Sep 2026: the empty map asked for a CI, and the box to pick it
  // appeared only after choosing a type — the owner could not find it.
  it('is there before any type is chosen: it searches every type, and each result says its type', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { total: 2, items: [
      { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production' },
      { id: 'app-7', name: 'CRM', type: 'application', status: 'active', environment: null },
    ] } }
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    expect(screen.getByLabelText('Type')).toHaveValue('')
    await user.click(screen.getByLabelText('Search CI...'))
    await waitFor(() => expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ type: undefined, search: undefined, limit: 80 }))
    expect(await screen.findByRole('button', { name: /CRM/ })).toHaveTextContent('Application')
    expect(screen.getByRole('button', { name: /db-01/ })).toHaveTextContent(/Server · /)
    await user.click(screen.getByRole('button', { name: /CRM/ }))
    await attendiURL('/topology', { ciId: 'app-7' })
    // Choosing the CI does not touch the type filter.
    expect(screen.getByLabelText('Type')).toHaveValue('')
  })

  it('with a type, the results do not repeat it: only the environment', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    await user.selectOptions(screen.getByLabelText('Type'), 'server')
    await user.click(screen.getByLabelText('Search CI...'))
    const row = await screen.findByRole('button', { name: /db-01/ })
    expect(row).not.toHaveTextContent('Server')
  })

  it('choosing a CI from the results starts the map from it; clearing it empties the map', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    // The internal base type is not a choice.
    expect(screen.queryByRole('option', { name: 'Base' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Type'), 'server')
    const box = screen.getByLabelText('Search CI...')
    await user.click(box)
    await user.click(screen.getByRole('button', { name: /db-01/ }))
    await attendiURL('/topology', { ciId: 'ci-1' })
    expect(lastTopo()).toMatchObject({ selectedCiId: 'ci-1', maxHops: 2 })
    expect(box).toHaveValue('db-01')

    // The ✕ in the box clears the CI.
    const clear = within(box.parentElement!).getByRole('button', { name: 'Close' })
    await user.click(clear)
    await attendiURL('/topology')
    expect(screen.queryByTestId('graph')).not.toBeInTheDocument()
  })

  it('"All" in the list clears the choice too', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    // The box names the CI at the centre once the map has loaded.
    expect(await screen.findByDisplayValue('db-01')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Search CI...'))
    await user.click(screen.getByRole('button', { name: '— All —' }))
    await attendiURL('/topology')
  })

  it('searches on the server after a pause, and says when more results exist', async () => {
    apolloFinto.risposte['GetAllCIs'] = (v?: Record<string, unknown>) => (v?.search === 'srv' ? SRV : ONE)
    const ONE = CIS(1)
    const SRV = CIS(3, 250)
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    await user.selectOptions(screen.getByLabelText('Type'), 'server')
    await user.type(screen.getByLabelText('Search CI...'), 'srv')
    // Debounced: the query with the text arrives after the pause.
    await waitFor(() => expect(apolloFinto.chiamata('GetAllCIs')).toEqual({ type: 'server', search: 'srv', limit: 80 }))
    expect(await screen.findByText('Showing 3 of 250 — refine the search to find the others')).toBeInTheDocument()
    // The environment of a result is shown next to its name.
    expect(screen.getByRole('button', { name: /db-01/ })).toHaveTextContent(/db-01.+/)

    // Hover highlights a row that is not the chosen one, and leaving restores it.
    const row = screen.getByRole('button', { name: 'srv-2' })
    fireEvent.mouseEnter(row)
    expect(row.style.background).toBe('var(--color-slate-bg)')
    fireEvent.mouseLeave(row)
    expect(row.style.background).toBe('transparent')
  })

  it('a search error is shown in the list, not as "no results"', async () => {
    apolloFinto.erroriQuery['GetAllCIs'] = new Error('search down')
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    await user.selectOptions(screen.getByLabelText('Type'), 'server')
    await user.click(screen.getByLabelText('Search CI...'))
    expect(screen.getByText('Search error: search down')).toBeInTheDocument()
    expect(screen.queryByText('No results')).not.toBeInTheDocument()
  })

  it('no match says so, and a click outside closes the list', async () => {
    apolloFinto.risposte['GetAllCIs'] = { allCIs: { total: 0, items: [] } }
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology' })
    await user.selectOptions(screen.getByLabelText('Type'), 'server')
    await user.click(screen.getByLabelText('Search CI...'))
    expect(screen.getByRole('button', { name: '— All —' })).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('button', { name: '— All —' })).not.toBeInTheDocument())
  })
})

describe('TopologyPage — filters reach the query', () => {
  it('depth, environment and status are sent; "All" depth sends no limit', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    const depth = screen.getByText('Depth').parentElement!.querySelector('select')!
    await user.selectOptions(depth, '4')
    expect(lastTopo()).toMatchObject({ selectedCiId: 'ci-1', maxHops: 4 })
    expect(screen.getByText(/depth: 4 hops/)).toBeInTheDocument()
    await user.selectOptions(depth, 'all')
    expect(lastTopo()?.maxHops).toBeUndefined()
    expect(screen.getByText(/depth: all/)).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Environment'), 'staging')
    await user.selectOptions(screen.getByLabelText('Status'), 'inactive')
    expect(lastTopo()).toMatchObject({ environment: 'staging', status: 'inactive' })
  })

  it('labels can be hidden', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    expect(screen.getByTestId('graph')).toHaveAttribute('data-labels', 'true')
    await user.click(screen.getByRole('checkbox', { name: 'Labels' }))
    expect(screen.getByTestId('graph')).toHaveAttribute('data-labels', 'false')
  })

  it('"only with incidents" hides quiet nodes and the totals follow', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    expect(screen.getByText(/3 nodes · 1 relationships/)).toBeInTheDocument()
    expect(screen.getByText('3 active incidents')).toBeInTheDocument()
    expect(screen.getByText('1 change in progress')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Only with incidents' }))
    const graph = screen.getByTestId('graph')
    expect(within(graph).queryByRole('button', { name: 'cache-02' })).not.toBeInTheDocument()
    expect(screen.getByText(/2 nodes · 1 relationships/)).toBeInTheDocument()
  })

  it('unreadable CI enums are flagged next to the filters', () => {
    apolloFinto.erroriQuery['GetBaseCIType'] = new Error('base down')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<TopologyPage />, { route: '/topology' })
    expect(screen.getByText('CI enums unavailable')).toBeInTheDocument()
    expect(screen.getByLabelText('Status')).toHaveAttribute('title', 'base down')
    vi.mocked(console.error).mockRestore()
  })
})

describe('TopologyPage — map states', () => {
  it('a truncated graph says so with the server limit', () => {
    apolloFinto.risposte['GetTopology'] = { topology: { ...TOPOLOGY.topology, truncated: true, nodeLimit: 500 } }
    renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    expect(screen.getByText(/Graph truncated to 500 nodes/)).toBeInTheDocument()
  })

  it('a failed load shows the error instead of the empty-state hint', () => {
    apolloFinto.erroriQuery['GetTopology'] = new Error('graph down')
    renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    expect(screen.getByText('Load error: graph down')).toBeInTheDocument()
    expect(screen.queryByText(/Choose/)).not.toBeInTheDocument()
  })

  it('a CI with no relationships says so', () => {
    apolloFinto.risposte['GetTopology'] = { topology: { nodes: [], edges: [], truncated: false, nodeLimit: 500 } }
    renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-9' })
    expect(screen.getByText('This CI has no relationship within the chosen depth.')).toBeInTheDocument()
  })
})

describe('TopologyPage — the node panel', () => {
  it('ticket counts open the CI, where its own tickets are listed', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    await user.click(within(screen.getByTestId('graph')).getByRole('button', { name: 'db-01' }))
    expect(screen.getByText('DBA')).toBeInTheDocument()
    const buttons = screen.getAllByTitle('Open the CI: its incidents and changes are listed there')
    expect(buttons.map((b) => b.textContent)).toEqual(['2', '1'])
    await user.click(buttons[0]!)
    await attendiURL('/cis/ci-1')
  })

  it('the change count opens the CI too', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    await user.click(within(screen.getByTestId('graph')).getByRole('button', { name: 'db-01' }))
    await user.click(screen.getAllByTitle('Open the CI: its incidents and changes are listed there')[1]!)
    await attendiURL('/cis/ci-1')
  })

  it('"Go to detail" opens the CI page of its type; a node without status shows a dash', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    await user.click(within(screen.getByTestId('graph')).getByRole('button', { name: 'cache-02' }))
    // No tickets: plain zeros, not links.
    expect(screen.queryByTitle('Open the CI: its incidents and changes are listed there')).not.toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Go to detail →' }))
    await attendiURL('/ci/server/ci-2')
  })

  it('the panel closes, and changing the CI in the box closes it too', async () => {
    const { user } = renderWithProviders(<TopologyPage />, { route: '/topology?ciId=ci-1' })
    // The box names the CI at the centre once the map has loaded.
    expect(await screen.findByDisplayValue('db-01')).toBeInTheDocument()
    const graph = screen.getByTestId('graph')
    await user.click(within(graph).getByRole('button', { name: 'app-03' }))
    expect(screen.getByRole('button', { name: 'Go to detail →' })).toBeInTheDocument()
    // The panel's own ✕ is the last "Close" button (the first clears the CI box).
    const closes = screen.getAllByRole('button', { name: 'Close' })
    await user.click(closes.at(-1)!)
    expect(screen.queryByRole('button', { name: 'Go to detail →' })).not.toBeInTheDocument()

    await user.click(within(graph).getByRole('button', { name: 'app-03' }))
    await user.click(screen.getByLabelText('Search CI...'))
    // The graph also has a "db-01" node: pick the one in the search list.
    const inList = screen.getAllByRole('button', { name: /db-01/ }).find((b) => !graph.contains(b))!
    await user.click(inList)
    expect(screen.queryByRole('button', { name: 'Go to detail →' })).not.toBeInTheDocument()
  })
})
