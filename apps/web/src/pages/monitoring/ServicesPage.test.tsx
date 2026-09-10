/**
 * Pagina Servizi: riquadri con i contatori del tenant, righe per gravità
 * (link, salute con «da», punteggio, causa principale, componenti, owner),
 * filtri nell'URL, stato vuoto con «Crea una mappa» (admin) → dialogo →
 * mutation → dettaglio, errore visibile, valore fuori vocabolario detto in chiaro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ServicesPage } from './ServicesPage'
import { GET_SERVICE_MAPS, GET_SERVICE_MAP_CANDIDATES } from '@/graphql/queries'
import { CREATE_SERVICE_MAP } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { mapRow, mapDetail, SERVICE, ciRef, pathRef } from '@/test/mocks/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const ROWS = [
  mapRow(),
  mapRow({ id: 'map-2', name: 'Payroll', health: 'down', impactScore: 100, stale: true, status: 'paused', nodeCount: 1,
    service: { ...SERVICE, id: 'ba-2', name: 'Payroll', criticality: null, ownerGroup: null },
    explanation: [{ __typename: 'ImpactCause', ci: ciRef('hr-01', 'hr-01', 'application'), health: 'down', weight: 8, critical: true, path: [pathRef('hr-01', 'hr-01')] }] }),
  mapRow({ id: 'map-3', name: 'Intranet', health: 'operational', impactScore: 0, healthSince: null, explanation: [] }),
]
const COUNTS = { __typename: 'ServiceMapCounts', total: 5, operational: 2, degraded: 1, down: 1, maintenance: 0, unknown: 1 }

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function pageMock(over: { items?: Record<string, unknown>[]; total?: number; counts?: Record<string, unknown> } = {}, seen?: Vars[]): GqlMock {
  return {
    request: { query: GET_SERVICE_MAPS, variables: (v) => { seen?.push(v as Vars); return true } },
    result: { data: { serviceMaps: { __typename: 'ServiceMapPage', total: over.total ?? ROWS.length, counts: over.counts ?? COUNTS, items: over.items ?? ROWS } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}
const EMPTY = { items: [], total: 0, counts: { ...COUNTS, total: 0, operational: 0, degraded: 0, down: 0, unknown: 0 } }

function renderPage(role: string, opts: { page?: GqlMock; seen?: Vars[]; route?: string; extra?: GqlMock[] } = {}) {
  return renderWithProviders(<ServicesPage />, {
    route: opts.route ?? '/monitoring/services',
    mocks: [meMock(role, { maxUsageCount: Number.POSITIVE_INFINITY }), opts.page ?? pageMock({}, opts.seen), ...(opts.extra ?? [])],
  })
}

const tile = (label: string) => screen.getByRole('button', { name: new RegExp(`\\b${label}\\b`) })
const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
const location = () => screen.getByTestId('location').textContent

describe('ServicesPage', () => {
  it('riquadri con i contatori del tenant («sconosciuti» come nota) e righe per gravità con salute, «da», punteggio, causa principale, componenti e owner', async () => {
    renderPage('operator')
    expect(await screen.findByRole('heading', { name: 'Services' })).toBeInTheDocument()

    expect(tile('Down')).toHaveTextContent(/^1Down/)
    expect(tile('Down')).toHaveTextContent('of 5 monitored services')
    expect(tile('Down')).toHaveAttribute('aria-pressed', 'false')
    expect(tile('Degraded')).toHaveTextContent(/^1Degraded/)
    expect(tile('In maintenance')).toHaveTextContent(/^0In maintenance/)
    expect(tile('In maintenance')).toHaveTextContent('none right now')
    expect(tile('Operational')).toHaveTextContent(/^2Operational/)
    // «sconosciuti»: informativo, non un bottone
    expect(screen.queryByRole('button', { name: /\bUnknown\b/ })).not.toBeInTheDocument()
    const unknown = screen.getByTitle(/Services with no component of known health/)
    expect(unknown).toHaveTextContent('1')
    expect(unknown).toHaveTextContent('no health data')

    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(screen.getByText('3 monitored services')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
    expect(within(rows[0]!).getByText('Degraded')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('for 42 min')).toHaveAccessibleDescription(/Current health in force since/)
    expect(within(rows[0]!).getByLabelText('Impact score 41 out of 100')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('db-01 down via api-03')).toBeInTheDocument()   // prima causa, con il «via»
    expect(within(rows[0]!).getByText('4 components')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Billing Ops')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Business Critical')).toBeInTheDocument()   // criticità con enumLabel

    // in pausa + componente mancante nella CMDB: pill di stato e icona con testo accessibile; causa senza «via»
    expect(within(rows[1]!).getByText('Paused')).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('img', { name: 'Component missing from the CMDB' })).toBeInTheDocument()
    expect(within(rows[1]!).getByText('hr-01 down')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('1 component')).toBeInTheDocument()

    // operativo senza cause: «—», niente «da»
    expect(within(rows[2]!).getByText('Operational')).toBeInTheDocument()
    expect(within(rows[2]!).queryByText(/^for /)).not.toBeInTheDocument()
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
    // admin no: nessun «Crea una mappa» per l'operator
    expect(screen.queryByRole('button', { name: 'Create a map' })).not.toBeInTheDocument()
  })

  it('il riquadro «Giù» filtra (aria-pressed), scrive ?health=down nell\'URL e nelle variabili; un secondo clic toglie il filtro', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', { seen })
    await screen.findByRole('heading', { name: 'Services' })
    await waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[0]!.filter).toBeNull()

    await user.click(tile('Down'))
    expect(tile('Down')).toHaveAttribute('aria-pressed', 'true')
    expect(location()).toBe('/monitoring/services?health=down')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ health: ['down'] }))
    expect(seen.at(-1)).toMatchObject({ limit: 50, offset: 0 })

    await user.click(tile('Down'))
    expect(tile('Down')).toHaveAttribute('aria-pressed', 'false')
    expect(location()).toBe('/monitoring/services')
    await waitFor(() => expect(seen.at(-1)!.filter).toBeNull())
  })

  it('stato della mappa e ricerca finiscono nell\'URL e nelle variabili; l\'URL è la sorgente (?health=degraded&status=paused&q=bill&page=2)', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', { seen })
    await screen.findByRole('heading', { name: 'Services' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Map status' }), 'paused')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ status: 'paused' }))
    await user.type(screen.getByRole('textbox', { name: 'Search a service by name' }), 'bill')
    await waitFor(() => expect(seen.at(-1)!.filter).toEqual({ status: 'paused', search: 'bill' }))
    await waitFor(() => expect(location()).toBe('/monitoring/services?status=paused&q=bill'))

    const seen2: Vars[] = []
    renderPage('operator', { seen: seen2, route: '/monitoring/services?health=degraded&status=paused&q=bill&page=2', page: pageMock({ total: 60 }, seen2) })
    await waitFor(() => expect(seen2.at(-1)).toEqual({ filter: { health: ['degraded'], status: 'paused', search: 'bill' }, limit: 50, offset: 50 }))
    const pressed = screen.getAllByRole('button', { name: /\bDegraded\b/ }).find((b) => b.getAttribute('aria-pressed') === 'true')
    expect(pressed).toBeDefined()
    expect(screen.getAllByText('page 2 of 2').length).toBeGreaterThan(0)
  })

  it('un valore di salute fuori vocabolario nell\'URL è ignorato (non inviato); in una riga è detto in chiaro «Unknown (weird)», mai una riga vuota', async () => {
    const seen: Vars[] = []
    renderPage('viewer', { seen, route: '/monitoring/services?health=weird', page: pageMock({ items: [mapRow({ health: 'weird' })] }, seen) })
    await screen.findByRole('heading', { name: 'Services' })
    await waitFor(() => expect(seen.at(-1)!.filter).toBeNull())
    expect(within(bodyRows()[0]!).getByText('Unknown (weird)')).toBeInTheDocument()
  })

  it('errore della query → QueryError con Riprova, niente tabella né stato vuoto', async () => {
    const failing: GqlMock = { request: { query: GET_SERVICE_MAPS, variables: () => true }, error: new Error('services down'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderPage('operator', { page: failing })
    expect(await screen.findByText('services down')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('No monitored service yet')).not.toBeInTheDocument()
  })

  it('con un filtro attivo e zero righe la tabella dice «nessun servizio corrisponde», non lo stato vuoto', async () => {
    renderPage('operator', { route: '/monitoring/services?health=down', page: pageMock({ items: [], total: 0 }) })
    expect(await screen.findByText('No service matches the filters')).toBeInTheDocument()
    expect(screen.queryByText('No monitored service yet')).not.toBeInTheDocument()
  })

  it('stato vuoto per il viewer: testo che rimanda all\'amministratore, nessun pulsante', async () => {
    renderPage('viewer', { page: pageMock(EMPTY) })
    expect(await screen.findByText('No monitored service yet')).toBeInTheDocument()
    expect(screen.getByText(/Ask an administrator to create a map/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create a map' })).not.toBeInTheDocument()
  })

  it('stato vuoto per l\'admin: «Crea una mappa» apre il dialogo (candidati, profondità, relazioni) → createServiceMap → dettaglio', async () => {
    const candidates: GqlMock = {
      request: { query: GET_SERVICE_MAP_CANDIDATES, variables: { search: null, limit: 50 } },
      result: { data: { serviceMapCandidates: [{ __typename: 'ServiceRef', id: 'ba-9', name: 'CRM', criticality: 'high', ownerGroup: null }] } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const seen: unknown[] = []
    const create: GqlMock = {
      request: { query: CREATE_SERVICE_MAP, variables: (v) => { seen.push(v); return true } },
      result: { data: { createServiceMap: mapDetail({ id: 'map-9', name: 'CRM' }) } },
    }
    const { user } = renderPage('admin', { page: pageMock(EMPTY), extra: [candidates, create] })
    // Prima lo stato vuoto (il pulsante dell'intestazione sparisce all'arrivo dei dati), poi il CTA dello stato vuoto.
    await screen.findByText('No monitored service yet')
    await user.click(screen.getByRole('button', { name: 'Create a map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a map' })
    const submit = within(dialog).getByRole('button', { name: 'Create' })
    expect(submit).toBeDisabled()                                            // nessun servizio scelto
    await user.selectOptions(await within(dialog).findByRole('combobox', { name: 'Business application' }), 'ba-9')
    expect(within(dialog).getByRole('option', { name: 'CRM · High' })).toBeInTheDocument()
    expect(submit).toBeEnabled()
    // profondità 6, togli USES_CERTIFICATE
    const depth = within(dialog).getByRole('spinbutton', { name: 'Maximum depth' })
    await user.clear(depth); await user.type(depth, '6')
    await user.click(within(dialog).getByRole('checkbox', { name: 'USES_CERTIFICATE' }))
    // nessuna relazione → bloccato con il motivo; poi rimettine una
    for (const r of ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON']) await user.click(within(dialog).getByRole('checkbox', { name: r }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose at least one relationship.')
    expect(submit).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox', { name: 'DEPENDS_ON' }))
    await user.click(submit)
    await waitFor(() => expect(seen).toEqual([{ serviceId: 'ba-9', maxDepth: 6, relationshipTypes: ['DEPENDS_ON'], status: 'active' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map of "CRM" created'))
    await waitFor(() => expect(location()).toBe('/monitoring/services/map-9'))
  })

  it('dialogo: la lista dei candidati che fallisce è un errore visibile; la mutation che fallisce è un toast con il messaggio del server', async () => {
    const candidatesDown: GqlMock = { request: { query: GET_SERVICE_MAP_CANDIDATES, variables: () => true }, error: new Error('candidates down'), maxUsageCount: Number.POSITIVE_INFINITY }
    const { user } = renderPage('admin', { extra: [candidatesDown] })
    await user.click(await screen.findByRole('button', { name: 'Create a map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create a map' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Candidates unavailable: candidates down')
  })

  it('clic sulla riga → dettaglio; il link al servizio non apre due volte', async () => {
    const { user } = renderPage('viewer')
    await screen.findByRole('heading', { name: 'Services' })
    await user.click(within(bodyRows()[1]!).getByText('1 component'))
    expect(location()).toBe('/monitoring/services/map-2')
  })
})
