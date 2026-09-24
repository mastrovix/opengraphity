/**
 * Service detail page: the paths ServiceDetailPage.test.tsx does not walk.
 *
 * The page's own contract, separate from its boxes:
 * - an admin action whose answer does not carry the map (or that fails) is
 *   SAID, never a silent success: the header would keep showing a health the
 *   engine did not confirm;
 * - when a box inside (components, rules, live-map switch, scope dialog)
 *   saves something, the page reloads the map — otherwise the header, the
 *   «why» list and the map disagree with what was just saved;
 * - dialogs open from where the admin needs them (the «over the ceiling»
 *   banner leads to «Review components», the Service box to «Change scope»);
 * - values outside the vocabulary are said in clear, never an empty field.
 *
 * The boxes are replaced by stubs that expose their callbacks: their own
 * behaviour is pinned in their own test files, here only the page's reaction
 * to them matters. Apollo is the name-based fake (`apolloFinto`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { meFixture } from '@/test/mocks/gql'
import { mapDetail, node, ciRef, mapProbe } from '@/test/mocks/services'
import type { ServiceMapDetail } from '@/types/services'
import { ServiceDetailPage } from './ServiceDetailPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

type Reload = { onReload: () => void }
vi.mock('./ServiceMapCanvas', () => ({
  // One button per component: selecting it opens the component's panel.
  ServiceMapCanvas: ({ map, onSelect }: { map: ServiceMapDetail; onSelect: (id: string) => void }) => (
    <div>{map.nodes.map((n) => <button key={n.ci.id} type="button" onClick={() => onSelect(n.ci.id)}>{`select ${n.ci.id}`}</button>)}</div>
  ),
}))
vi.mock('./ServiceComponentsTable', () => ({
  ServiceComponentsTable: ({ onReload }: Reload) => <button type="button" onClick={onReload}>components saved</button>,
}))
vi.mock('./ServiceRulesCard', () => ({
  ServiceRulesCard: ({ onReload }: Reload) => <button type="button" onClick={onReload}>rules saved</button>,
}))
vi.mock('./ServiceAutoSyncToggle', () => ({
  ServiceAutoSyncToggle: ({ onReload }: Reload) => <button type="button" onClick={onReload}>live map switched</button>,
}))
vi.mock('./ServiceMapScopeDialog', () => ({
  ServiceMapScopeDialog: ({ onClose, onReload }: Reload & { onClose: () => void }) => (
    <div data-testid="scope-dialog">
      <button type="button" onClick={onReload}>scope saved</button>
      <button type="button" onClick={onClose}>close scope</button>
    </div>
  ),
}))
vi.mock('./UpdateServiceMapDialog', () => ({
  UpdateServiceMapDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <div data-testid="update-dialog"><button type="button" onClick={onClose}>close update</button></div> : null,
}))
vi.mock('./ServiceHistorySection', () => ({ ServiceHistorySection: () => null }))
vi.mock('./ServiceOpenIncidentCard', () => ({ ServiceOpenIncidentCard: () => null }))

function setMap(over: Record<string, unknown> = {}) {
  apolloFinto.risposte['GetServiceMap'] = { serviceMap: mapDetail(over) }
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.warning).mockClear()
  apolloFinto.risposte['GetMe'] = { me: meFixture('admin') }
  setMap()
})

function renderPage() {
  return renderWithProviders(<ServiceDetailPage />, { route: '/monitoring/services/map-1', path: '/monitoring/services/:id' })
}
const location = () => screen.getByTestId('location').textContent
const reloads = () => apolloFinto.refetch.mock.calls.length
/** The whole DetailField (label + value), found by its label. */
const fieldOf = (scope: HTMLElement, label: string) => within(scope).getByText(label).parentElement!.parentElement as HTMLElement
const fieldValue = (label: string) => fieldOf(document.body, label)

describe('ServiceDetailPage — answers without the map are failures, not successes', () => {
  it('re-evaluation that returns no map → «did not return the map»', async () => {
    apolloFinto.esiti['ReevaluateServiceMap'] = { data: { reevaluateServiceMap: null } }
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Re-evaluate now' }))
    expect(toast.error).toHaveBeenCalledWith('Action failed: reevaluateServiceMap did not return the map')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('sync with no result, and a sync the server rejects, are both reported', async () => {
    apolloFinto.esiti['SyncServiceMap'] = { data: { syncServiceMap: null } }
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(toast.error).toHaveBeenLastCalledWith('Action failed: syncServiceMap did not return the map')

    apolloFinto.esiti['SyncServiceMap'] = { error: new Error('engine busy') }
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(toast.error).toHaveBeenLastCalledWith('Action failed: engine busy')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a status change with no map back, or refused, is reported and the button keeps its label', async () => {
    apolloFinto.esiti['SetServiceMapStatus'] = { data: { setServiceMapStatus: null } }
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(toast.error).toHaveBeenLastCalledWith('Action failed: setServiceMapStatus did not return the map')
    expect(apolloFinto.chiamata('SetServiceMapStatus')).toEqual({ id: 'map-1', expectedVersion: 3, status: 'paused' })

    apolloFinto.esiti['SetServiceMapStatus'] = { error: new Error('version conflict') }
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(toast.error).toHaveBeenLastCalledWith('Action failed: version conflict')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('a delete the server refuses is reported and the page stays', async () => {
    apolloFinto.esiti['DeleteServiceMap'] = { error: new Error('map is referenced') }
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete the map of "Enterprise Billing"?' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(toast.error).toHaveBeenCalledWith('Action failed: map is referenced')
    expect(toast.success).not.toHaveBeenCalledWith('Map deleted')
    expect(location()).toBe('/monitoring/services/map-1')
  })
})

describe('ServiceDetailPage — boxes that save make the page reload the map', () => {
  it('components, rules, the live-map switch and the scope dialog each trigger a reload', async () => {
    const { user } = renderPage()

    let before = reloads()
    await user.click(screen.getByRole('button', { name: 'rules saved' }))
    expect(reloads()).toBe(before + 1)

    fireEvent.click(screen.getByRole('button', { name: /^Components\b/ }))
    before = reloads()
    await user.click(screen.getByRole('button', { name: 'components saved' }))
    expect(reloads()).toBe(before + 1)

    fireEvent.click(screen.getByRole('button', { name: /^Service$/ }))
    before = reloads()
    await user.click(screen.getByRole('button', { name: 'live map switched' }))
    expect(reloads()).toBe(before + 1)

    await user.click(screen.getByRole('button', { name: 'Change scope' }))
    expect(screen.getByTestId('scope-dialog')).toBeInTheDocument()
    before = reloads()
    await user.click(screen.getByRole('button', { name: 'scope saved' }))
    expect(reloads()).toBe(before + 1)
    await user.click(screen.getByRole('button', { name: 'close scope' }))
    expect(screen.queryByTestId('scope-dialog')).not.toBeInTheDocument()
  })

  it('the «over the ceiling» banner opens «Review components», which can be closed', async () => {
    setMap({ stale: true, staleReason: 'over_limit' })
    const { user } = renderPage()
    const banner = screen.getByTestId('stale-banner')
    await user.click(within(banner).getByRole('button', { name: 'Review components' }))
    expect(screen.getByTestId('update-dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'close update' }))
    expect(screen.queryByTestId('update-dialog')).not.toBeInTheDocument()
  })
})

describe('ServiceDetailPage — navigation and plain words', () => {
  it('«Back to services» returns to the list', async () => {
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'Back to services' }))
    expect(location()).toBe('/monitoring/services')
  })

  /*
   * Review of 23 Sep 2026: the reload ran once, when the probe first got
   * ahead; if it failed, `behind` stayed true and nothing ran again — the page
   * stayed on the old evaluation without a word.
   */
  it('a reload that failed is tried again at the next poll, and the page says it is not current', () => {
    apolloFinto.risposte['GetServiceMapStatus'] = () => ({ serviceMap: mapProbe({ version: 4 }) })
    apolloFinto.erroriDiPolling['GetServiceMap'] = new Error('502 Bad Gateway')
    const { rerender } = renderPage()
    const first = reloads()
    expect(first).toBeGreaterThan(0)
    // The next poll: a new probe object, still ahead.
    rerender(<ServiceDetailPage />)
    expect(reloads()).toBeGreaterThan(first)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh: 502 Bad Gateway')
  })

  it('a load error offers a retry that reloads', async () => {
    apolloFinto.risposte['GetServiceMap'] = undefined
    apolloFinto.erroriQuery['GetServiceMap'] = new Error('map down')
    const { user } = renderPage()
    expect(screen.getByText('map down')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /retry/i }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a map built by hand, and one built by an unknown way, say so', () => {
    setMap({ builtFrom: 'manual' })
    const { unmount } = renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Service$/ }))
    expect(fieldValue('Built')).toHaveTextContent('Manually')
    unmount()

    setMap({ builtFrom: 'imported' })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /^Service$/ }))
    // Out of vocabulary: named in clear, not an empty field.
    expect(fieldValue('Built')).toHaveTextContent('Unknown (imported)')
  })

  it('the component panel says who added the component, in words, including an unknown source', async () => {
    setMap({ nodes: [
      node({ id: 'api-03', name: 'api-03', ci: ciRef('api-03', 'api-03', 'application'), level: 1, via: null, addedBy: 'manual' }),
      node({ id: 'db-01', name: 'db-01', ci: ciRef('db-01', 'db-01', 'database'), addedBy: 'discovery' }),
    ] })
    const { user } = renderPage()
    await user.click(screen.getByRole('button', { name: 'select api-03' }))
    let panel = screen.getByTestId('node-panel')
    expect(fieldOf(panel, 'Added')).toHaveTextContent('Manually')

    await user.click(screen.getByRole('button', { name: 'select db-01' }))
    panel = screen.getByTestId('node-panel')
    expect(fieldOf(panel, 'Added')).toHaveTextContent('Unknown (discovery)')
  })
})
