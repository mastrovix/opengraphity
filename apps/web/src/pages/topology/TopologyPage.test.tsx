/**
 * TopologyPage — lato "salute" (D·7): `?health=1` ↔ checkbox "Evidenzia
 * salute", `?ciId=` come CI di partenza (la pagina Salute CI manda qui),
 * contatori Giù/Degradati nella barra, CIHealthBadge nel pannello del nodo.
 *
 * Il grafo D3 (components/topology/TopologyGraph) è sostituito da uno stub
 * che elenca i nodi come pulsanti: qui si verifica la pagina, non il disegno.
 */
import { describe, it, expect, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { TopologyPage } from './TopologyPage'
import { GET_TOPOLOGY, GET_ALL_CIS, GET_CI_TYPES, GET_BASE_CI_TYPE } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import type { TopologyNode } from '@/components/topology/TopologyGraph'

vi.mock('@/components/topology/TopologyGraph', () => ({
  default: ({ nodes, onNodeClick, highlightHealth, rootNodeId }: { nodes: TopologyNode[]; onNodeClick: (n: TopologyNode) => void; highlightHealth: boolean; rootNodeId: string | null }) => (
    <div data-testid="graph" data-highlight-health={String(highlightHealth)} data-root={rootNodeId ?? ''}>
      {nodes.map((n) => <button type="button" key={n.id} onClick={() => onNodeClick(n)}>{n.name}</button>)}
    </div>
  ),
  TopologyLegend: () => null,
  HEALTH_COLOR: {},
}))

const node = (over: Partial<TopologyNode> & { id: string; name: string }): TopologyNode => ({
  type: 'server', status: 'active', environment: 'production', ownerGroup: null, incidentCount: 0, changeCount: 0, health: null, ...over,
})
const NODES: TopologyNode[] = [
  node({ id: 'ci-1', name: 'db-01', health: 'down', incidentCount: 1 }),
  node({ id: 'ci-2', name: 'cache-02', health: 'degraded' }),
  node({ id: 'ci-3', name: 'app-03', type: 'application', health: 'operational' }),
  node({ id: 'ci-4', name: 'lb-04', health: 'down' }),
]

type TopoVars = { selectedCiId?: string; maxHops?: number; environment?: string; status?: string }

function topologyMock(seen?: TopoVars[]): GqlMock {
  return {
    request: { query: GET_TOPOLOGY, variables: (v) => { seen?.push(v as TopoVars); return true } },
    result: { data: { topology: {
      __typename: 'Topology',
      nodes: NODES.map((n) => ({ __typename: 'TopologyNode', ...n })),
      edges: [{ __typename: 'TopologyEdge', source: 'ci-3', target: 'ci-1', type: 'DEPENDS_ON' }],
      truncated: false, nodeLimit: 500,
    } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const field = (name: string, fieldType: string, order: number, enumValues: string[] = []) => ({
  __typename: 'CIField', id: `f-${name}`, name, label: name, fieldType, required: false, enumValues, order, isSystem: true,
  validationScript: null, visibilityScript: null, defaultScript: null,
})
const ciTypesMock: GqlMock = {
  request: { query: GET_CI_TYPES },
  result: { data: { ciTypes: [
    { __typename: 'CIType', id: 'ct-server', name: 'server', label: 'Server', icon: 'server', color: '#0284c7', active: true, validationScript: null, chainFamilies: [], fields: [field('name', 'string', 1)], relations: [], systemRelations: [] },
    { __typename: 'CIType', id: 'ct-app', name: 'application', label: 'Application', icon: 'box', color: '#000', active: true, validationScript: null, chainFamilies: [], fields: [field('name', 'string', 1)], relations: [], systemRelations: [] },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
const baseTypeMock: GqlMock = {
  request: { query: GET_BASE_CI_TYPE },
  result: { data: { baseCIType: {
    __typename: 'CIType', id: 'base', name: '__base__', label: 'Base', icon: 'box', color: '#000', active: true, validationScript: null,
    fields: [field('status', 'enum', 1, ['active', 'inactive']), field('environment', 'enum', 2, ['production', 'staging'])],
    relations: [], systemRelations: [],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}
/** Combobox del CI (allCIs per tipo): compare quando il tipo è valorizzato. */
const allCIsMock: GqlMock = {
  request: { query: GET_ALL_CIS, variables: () => true },
  result: { data: { allCIs: { __typename: 'CIPage', total: 1, items: [{ __typename: 'CI', id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'production', description: null, createdAt: null, ownerGroup: null, supportGroup: null }] } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

function renderPage(route: string, seen?: TopoVars[]) {
  return renderWithProviders(<TopologyPage />, { route, mocks: [topologyMock(seen), ciTypesMock, baseTypeMock, allCIsMock] })
}
const location = () => screen.getByTestId('location').textContent
const healthToggle = () => screen.getByRole('checkbox', { name: 'Highlight health' })

describe('TopologyPage — salute', () => {
  it('senza ?ciId la query non parte: tela vuota con l\'invito, nessun contatore', async () => {
    const seen: TopoVars[] = []
    renderPage('/topology', seen)
    expect(await screen.findByText('Explore the relationships between infrastructure CIs')).toBeInTheDocument()
    expect(screen.queryByTestId('graph')).not.toBeInTheDocument()
    expect(seen).toHaveLength(0)
    expect(healthToggle()).not.toBeChecked()
  })

  it('D·1.3 — ?ciId= è il CI di partenza: la query parte con selectedCiId, il grafo ha quel nodo come radice, il tipo del CI popola il filtro e il combobox mostra il nome', async () => {
    const seen: TopoVars[] = []
    renderPage('/topology?health=1&ciId=ci-1', seen)
    expect(await screen.findByTestId('graph')).toHaveAttribute('data-root', 'ci-1')
    expect(seen[0]).toMatchObject({ selectedCiId: 'ci-1', maxHops: 2 })
    expect(screen.getByTestId('graph')).toHaveAttribute('data-highlight-health', 'true')
    expect(healthToggle()).toBeChecked()
    // tipo derivato dal nodo radice → combobox visibile con il nome del CI
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('server'))
    expect(await screen.findByDisplayValue('db-01')).toBeInTheDocument()
    expect(screen.getByText('4 nodes · 1 relationships')).toBeInTheDocument()
  })

  it('?health=1 ↔ checkbox: togliere l\'evidenziazione cancella il parametro, rimetterla lo riscrive (replace), il CI resta', async () => {
    const { user } = renderPage('/topology?health=1&ciId=ci-1')
    await screen.findByTestId('graph')
    await user.click(healthToggle())
    expect(healthToggle()).not.toBeChecked()
    expect(location()).toBe('/topology?ciId=ci-1')
    expect(screen.getByTestId('graph')).toHaveAttribute('data-highlight-health', 'false')
    await user.click(healthToggle())
    expect(location()).toBe('/topology?ciId=ci-1&health=1')
  })

  it('contatori Giù/Degradati nella barra solo con la salute evidenziata', async () => {
    const { user } = renderPage('/topology?health=1&ciId=ci-1')
    await screen.findByTestId('graph')
    expect(screen.getByText('Down: 2')).toBeInTheDocument()
    expect(screen.getByText('Degraded: 1')).toBeInTheDocument()
    expect(screen.getByText('1 active incident')).toBeInTheDocument()
    await user.click(healthToggle())
    expect(screen.queryByText('Down: 2')).not.toBeInTheDocument()
    expect(screen.queryByText('Degraded: 1')).not.toBeInTheDocument()
  })

  it('pannello del nodo: CIHealthBadge con la salute del CI; assente per un CI senza salute', async () => {
    const { user } = renderPage('/topology?ciId=ci-1')
    const graph = await screen.findByTestId('graph')
    await user.click(within(graph).getByRole('button', { name: 'cache-02' }))
    expect(screen.getByText('cache-02', { selector: 'div' })).toBeInTheDocument()
    expect(screen.getByText('Health')).toBeInTheDocument()
    expect(screen.getByText('Health: Degraded')).toBeInTheDocument()
    // due "Chiudi": quello del combobox (svuota il CI) e quello del pannello; il pannello è l'ultimo nel DOM
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(screen.queryByText('Health: Degraded')).not.toBeInTheDocument()
  })

  it('cambiare tipo azzera il CI di partenza (?ciId sparisce, tela vuota); il montaggio invece non lo cancella', async () => {
    const { user } = renderPage('/topology?health=1&ciId=ci-1')
    await screen.findByTestId('graph')
    expect(location()).toBe('/topology?health=1&ciId=ci-1')   // nessun effetto al montaggio lo ha tolto
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'application')
    expect(location()).toBe('/topology?health=1')
    expect(await screen.findByText('Explore the relationships between infrastructure CIs')).toBeInTheDocument()
  })
})
