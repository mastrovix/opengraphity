/**
 * SERVICE DETAIL PAGE: WHEN SOMETHING IS NOT THERE.
 *
 * A map that was never evaluated or synced, a service with no owner, a
 * component whose predecessor left the map or that does not count for a
 * reason nobody stated: in each case the page must SAY what is missing, in
 * words, and never make up a date, a name or a reason. The polling probe
 * must notice a map's first evaluation (it compares against «never») and
 * must not reload when nothing moved; a component that leaves the map must
 * close its panel instead of showing what it was.
 *
 * `ServiceDetailPage.test.tsx` and `.more.test.tsx` cover the rest. The
 * boxes inside are stubs here, as in `.more.test.tsx`: their own behaviour
 * has its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { mapDetail, node, ciRef, NODES, CAUSES, SERVICE } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { ServiceDetailPage } from './ServiceDetailPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('./ServiceMapCanvas', () => ({
  // One button per component: selecting it opens the component's panel.
  ServiceMapCanvas: ({ map, onSelect }: { map: ServiceMapDetail; onSelect: (id: string) => void }) => (
    <div>{map.nodes.map((n) => <button key={n.ci.id} type="button" onClick={() => onSelect(n.ci.id)}>{`select ${n.ci.id}`}</button>)}</div>
  ),
}))
vi.mock('./ServiceComponentsTable', () => ({ ServiceComponentsTable: () => null }))
vi.mock('./ServiceRulesCard', () => ({ ServiceRulesCard: () => null }))
vi.mock('./ServiceAutoSyncToggle', () => ({ ServiceAutoSyncToggle: () => null }))
vi.mock('./ServiceMapScopeDialog', () => ({ ServiceMapScopeDialog: () => null }))
vi.mock('./UpdateServiceMapDialog', () => ({ UpdateServiceMapDialog: () => null }))
vi.mock('./ServiceHistorySection', () => ({ ServiceHistorySection: () => null }))
vi.mock('./ServiceOpenIncidentCard', () => ({ ServiceOpenIncidentCard: () => null }))

const setMap = (over: Record<string, unknown> = {}) => { apolloFinto.risposte['GetServiceMap'] = { serviceMap: mapDetail(over) } }
const setProbe = (over: Record<string, unknown>) => {
  apolloFinto.risposte['GetServiceMapStatus'] = { serviceMap: { __typename: 'ServiceMap', id: 'map-1', version: 3, ...over } }
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  setMap()
})

const renderPage = () => renderWithProviders(<ServiceDetailPage />, { route: '/monitoring/services/map-1', path: '/monitoring/services/:id' })
/** The value of a detail field, found by its label. */
const fieldValue = (label: string) => screen.getByText(label, { selector: 'div' }).parentElement!.nextElementSibling!.textContent

describe('a map with nothing to report yet', () => {
  it('says it was never evaluated nor synced, without dates it does not have', () => {
    setMap({ evaluatedAt: null, syncedAt: null, updatedAt: null, healthSince: null })
    renderPage()
    expect(screen.getByTestId('evaluated-at')).toHaveTextContent('Never evaluated')
    expect(screen.getByTestId('evaluated-at')).not.toHaveAttribute('title')
    expect(screen.getByTestId('synced-at')).toHaveTextContent('Never synced')
    expect(screen.getByTestId('map-version')).toHaveTextContent('Version 3')
    expect(screen.getByTestId('map-version')).not.toHaveAttribute('title')
    // No «for 3 hours»: the page does not know since when.
    expect(screen.queryByText(/^for /)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Service$/ }))
    expect(fieldValue('Last change')).toBe('—')
  })

  it('a service with no criticality, no owner and no relationship followed shows dashes', () => {
    setMap({ service: { ...SERVICE, criticality: null, ownerGroup: null }, relationshipTypes: [] })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Service$/ }))
    expect(fieldValue('Criticality')).toBe('—')
    expect(fieldValue('Owner')).toBe('—')
    expect(fieldValue('Relationships followed')).toBe('—')
  })
})

describe('the polling probe', () => {
  it('the first evaluation of a map that had none makes the page read it again', () => {
    setMap({ evaluatedAt: null, syncedAt: null })
    setProbe({ evaluatedAt: '2026-09-23T10:00:00Z', syncedAt: null })
    renderPage()
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
  })

  it('a probe with nothing new — still never evaluated, never synced — reloads nothing', () => {
    setMap({ evaluatedAt: null, syncedAt: null })
    setProbe({ evaluatedAt: null, syncedAt: null })
    renderPage()
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
  })
})

describe('the panel of a component', () => {
  it('a component reached straight from the service says so', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select api-03' }))
    expect(screen.getByTestId('node-via')).toHaveTextContent('Straight from the service')
  })

  it('a component whose predecessor is no longer in the map says so, instead of naming a ghost', async () => {
    setMap({ nodes: [...NODES, node({ id: 'orphan-01', name: 'orphan-01', via: 'gone-01' })] })
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select orphan-01' }))
    expect(screen.getByTestId('node-via')).toHaveTextContent('The predecessor is no longer among the components of the map')
    expect(within(screen.getByTestId('node-via')).queryByRole('button')).toBeNull()
  })

  it('a component that does not count, with no reason given, says the reason was not stated', async () => {
    setMap({ nodes: [...NODES, node({ id: 'quiet-01', name: 'quiet-01', contributes: false, excludedReason: null })] })
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select quiet-01' }))
    expect(fieldValue('Counts in the computation')).toBe('No — reason not stated')
  })

  it('isolating a component closes its panel; from the panel again the whole map comes back', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select db-01' }))
    const isolate = screen.getByRole('button', { name: 'Isolate' })
    expect(isolate).toHaveAttribute('aria-pressed', 'false')
    await user.click(isolate)
    expect(screen.queryByTestId('node-via')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'select db-01' }))
    const whole = screen.getByRole('button', { name: 'Show the whole map' })
    expect(whole).toHaveAttribute('aria-pressed', 'true')
    await user.click(whole)
    await user.click(screen.getByRole('button', { name: 'select db-01' }))
    expect(screen.getByRole('button', { name: 'Isolate' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('a component that leaves the map (after a sync) closes its panel', async () => {
    const { user, rerender } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select db-01' }))
    expect(screen.getByTestId('node-via')).toBeInTheDocument()
    setMap({ nodes: NODES.filter((n) => (n['ci'] as { id: string }).id !== 'db-01') })
    rerender(<ServiceDetailPage />)
    expect(screen.queryByTestId('node-via')).toBeNull()
  })
})

describe('why the service is in this state', () => {
  it('a cause that is a critical component is marked critical', () => {
    setMap({ explanation: [{ ...CAUSES[0], critical: true, ci: ciRef('db-01', 'db-01', 'database') }] })
    renderPage()
    expect(screen.getByText('critical')).toBeInTheDocument()
  })
})
