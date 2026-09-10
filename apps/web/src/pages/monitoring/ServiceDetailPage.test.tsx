/**
 * Dettaglio servizio: testata con badge, punteggio, «da», frase in parole;
 * mappa a livelli (un nodo per componente sul livello giusto, percorso
 * d'impatto evidenziato fino al servizio); pannello «Perché»; pannello del
 * componente al clic; tabella componenti; cronologia; azioni admin
 * (rivaluta, pausa con expectedVersion, elimina con conferma); viewer senza
 * azioni; non trovato; errore; avviso «stale».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ServiceDetailPage } from './ServiceDetailPage'
import { GET_SERVICE_MAP, GET_SERVICE_IMPACT_PREVIEW, GET_SERVICE_MAP_PROPOSAL } from '@/graphql/queries'
import { REEVALUATE_SERVICE_MAP, SET_SERVICE_MAP_STATUS, DELETE_SERVICE_MAP } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { mapDetail, preview, proposal, openIncident } from '@/test/mocks/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

const detailMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_SERVICE_MAP, variables: { id: 'map-1' } },
  result: { data: { serviceMap: mapDetail(over) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** Le anteprime dell'ondata 2 partono da sole per gli admin (regole e componenti). */
const previewMock: GqlMock = {
  request: { query: GET_SERVICE_IMPACT_PREVIEW, variables: () => true },
  result: { data: { serviceImpactPreview: preview() } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

const proposalMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_SERVICE_MAP_PROPOSAL, variables: { id: 'map-1' } },
  result: { data: { serviceMapProposal: proposal(over) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, opts: { detail?: GqlMock; extra?: GqlMock[] } = {}) {
  return renderWithProviders(<ServiceDetailPage />, {
    route: '/monitoring/services/map-1', path: '/monitoring/services/:id',
    mocks: [meMock(role, { maxUsageCount: Number.POSITIVE_INFINITY }), opts.detail ?? detailMock(), previewMock, ...(opts.extra ?? [])],
  })
}

const nodes = () => screen.getAllByTestId('service-map-node')
const nodeOf = (ciId: string) => nodes().find((n) => n.getAttribute('data-ci-id') === ciId)!
const edges = () => Array.from(document.querySelectorAll('[data-testid="service-map-edge"]'))
const edgeOf = (source: string, target: string) => edges().find((e) => e.getAttribute('data-source') === source && e.getAttribute('data-target') === target)!
const location = () => screen.getByTestId('location').textContent

describe('ServiceDetailPage', () => {
  it('testata: nome, badge salute e stato, punteggio, «da», frase di spiegazione in parole', async () => {
    renderPage('viewer')
    expect(await screen.findByRole('heading', { level: 1, name: 'Enterprise Billing' })).toBeInTheDocument()
    expect(screen.getAllByText('Degraded').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Impact score 41 out of 100')).toBeInTheDocument()
    expect(screen.getByText('for 42 min')).toBeInTheDocument()
    expect(screen.getByText('Evaluated 2 min ago')).toBeInTheDocument()
    expect(screen.getByTestId('explanation-sentence')).toHaveTextContent('Degraded: db-01 is down (via api-03), cache-02 is degraded (via api-03)')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()       // nessun avviso «stale»
  })

  it('mappa a livelli: il servizio in cima, un nodo per componente sul livello giusto, tipo e salute nel nome accessibile', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    const root = screen.getByTestId('service-map-root')
    expect(root).toHaveAttribute('data-level', '0')
    expect(root).toHaveAttribute('aria-label', 'Enterprise Billing · Service · Degraded')
    expect(nodes()).toHaveLength(4)
    expect(nodeOf('api-03')).toHaveAttribute('data-level', '1')
    expect(nodeOf('db-01')).toHaveAttribute('data-level', '2')
    expect(nodeOf('cache-02')).toHaveAttribute('data-level', '2')
    expect(nodeOf('cert-billing')).toHaveAttribute('data-level', '2')
    expect(nodeOf('db-01')).toHaveAttribute('aria-label', 'db-01 · Database · Down')
    expect(nodeOf('cert-billing')).toHaveAttribute('aria-label', 'cert-billing · Certificate · Unknown')   // salute null = sconosciuta, mai vuota
    expect(nodeOf('cert-billing')).toHaveAttribute('data-health', 'unknown')
    // il servizio è collegato al livello 1, gli archi vivi ci sono tutti
    expect(edgeOf('ba-1', 'api-03')).toHaveAttribute('data-rel', 'REALIZES')
    expect(edgeOf('api-03', 'cert-billing')).toHaveAttribute('data-rel', 'USES_CERTIFICATE')
    expect(screen.getByLabelText('Legend')).toHaveTextContent('Impact path (down)')
  })

  it('percorso d\'impatto evidenziato: nodi e archi dal nodo malato fino al servizio, con la severità peggiore', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    expect(nodeOf('db-01')).toHaveAttribute('data-on-path', 'down')
    expect(nodeOf('db-01')).toHaveAttribute('data-cause', 'true')
    expect(nodeOf('cache-02')).toHaveAttribute('data-on-path', 'degraded')
    expect(nodeOf('api-03')).toHaveAttribute('data-on-path', 'down')            // attraversato da entrambi: vince giù
    expect(nodeOf('cert-billing')).not.toHaveAttribute('data-on-path')
    expect(screen.getByTestId('service-map-root')).toHaveAttribute('data-on-path', 'down')
    expect(edgeOf('api-03', 'db-01')).toHaveAttribute('data-highlight', 'down')
    expect(edgeOf('api-03', 'cache-02')).toHaveAttribute('data-highlight', 'degraded')
    expect(edgeOf('ba-1', 'api-03')).toHaveAttribute('data-highlight', 'down')
    expect(edgeOf('api-03', 'cert-billing')).not.toHaveAttribute('data-highlight')
    expect(edges().every((e) => e.getAttribute('data-live') === 'true')).toBe(true)
  })

  it('pannello «Perché»: le cause con salute, peso, critico e percorso fino al servizio', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    const causes = within(screen.getByTestId('why-list')).getAllByTestId('why-cause')
    expect(causes).toHaveLength(2)
    expect(causes[0]).toHaveAttribute('data-ci-id', 'db-01')
    expect(causes[0]).toHaveTextContent('weight 5')
    expect(causes[0]).toHaveTextContent('Path: db-01 → api-03 → Enterprise Billing')
    expect(within(causes[0]!).getByText('Down')).toBeInTheDocument()
    expect(causes[1]).toHaveTextContent('Path: cache-02 → api-03 → Enterprise Billing')  // il nodo stesso nel path non è ripetuto
    expect(within(causes[1]!).queryByText('critical')).not.toBeInTheDocument()
  })

  it('clic su un nodo → pannello laterale con ruolo, livello, pesa/peso/critico, salute, link agli allarmi e al CI; «Perché» seleziona il nodo', async () => {
    const { user } = renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('node-panel')).not.toBeInTheDocument()
    await user.click(nodeOf('api-03'))
    expect(nodeOf('api-03')).toHaveAttribute('aria-pressed', 'true')
    const panel = screen.getByTestId('node-panel')
    expect(panel).toHaveAttribute('data-ci-id', 'api-03')
    expect(within(panel).getByRole('link', { name: 'api-03' })).toHaveAttribute('href', '/ci/application/api-03')
    expect(within(panel).getByText('Entry')).toBeInTheDocument()          // ruolo
    expect(within(panel).getByText('Weighted')).toBeInTheDocument()       // pesa
    expect(within(panel).getByText('8')).toBeInTheDocument()              // peso
    expect(within(panel).getByText('Operational')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /View active alarms/ })).toHaveAttribute('href', '/events?ciId=api-03')
    expect(within(panel).getByRole('link', { name: /Open the CI/ })).toHaveAttribute('href', '/ci/application/api-03')
    // secondo clic sullo stesso nodo → deselezione
    await user.click(nodeOf('api-03'))
    expect(screen.queryByTestId('node-panel')).not.toBeInTheDocument()
    // dal «Perché»
    await user.click(screen.getByRole('button', { name: 'Highlight db-01 on the map' }))
    expect(screen.getByTestId('node-panel')).toHaveAttribute('data-ci-id', 'db-01')
    await user.click(screen.getByRole('button', { name: 'Close the component panel' }))
    expect(screen.queryByTestId('node-panel')).not.toBeInTheDocument()
  })

  it('tabella componenti (sola lettura) e cronologia dalla più recente con badge di salute', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    const rows = screen.getAllByTestId('component-row')
    expect(rows.map((r) => r.getAttribute('data-ci-id'))).toEqual(['api-03', 'cache-02', 'cert-billing', 'db-01'])  // per livello, poi nome
    expect(within(rows[0]!).getByRole('link', { name: 'api-03' })).toHaveAttribute('href', '/ci/application/api-03')
    expect(within(rows[0]!).getByText('critical')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('Never')).toBeInTheDocument()       // non pesa
    expect(within(rows[2]!).getByText('Unknown')).toBeInTheDocument()     // salute null
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()

    const history = screen.getAllByTestId('service-history-entry')
    expect(history).toHaveLength(2)
    expect(history[0]).toHaveAttribute('data-trigger', 'ci_health')
    expect(history[0]).toHaveTextContent('Health changed from Operational to Degraded after a component health change (score 41).')
    expect(history[0]).toHaveTextContent('db-01 down via api-03, cache-02 degraded via api-03')
    expect(history[1]).toHaveTextContent('Map created: initial health Operational (score 0).')
  })

  it('riquadro «Incident aperto» (ondata 3): con un incident il link al ticket, senza incident la nota giusta secondo le regole', async () => {
    renderPage('viewer', { detail: detailMock({ openIncident: openIncident() }) })
    await screen.findByRole('heading', { level: 1 })
    const card = screen.getByTestId('service-open-incident')
    expect(within(card).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc-1')
    expect(card).toHaveTextContent('Step: in progress')
  })

  it('senza incident e con «openIncidentFrom: never» il riquadro dice che gli incident sono disattivati', async () => {
    renderPage('viewer', { detail: detailMock({ rules: { ...mapDetail().rules as Record<string, unknown>, openIncidentFrom: 'never' } }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Incidents are turned off for this service.')).toBeInTheDocument()
    expect(screen.queryByTestId('service-open-incident')).not.toBeInTheDocument()
  })

  it('admin: «Rivaluta ora» chiama la mutation; «Metti in pausa» manda expectedVersion = versione letta e il pulsante diventa «Riattiva»', async () => {
    const seenRe: unknown[] = []
    const reeval: GqlMock = {
      request: { query: REEVALUATE_SERVICE_MAP, variables: (v) => { seenRe.push(v); return true } },
      result: { data: { reevaluateServiceMap: mapDetail({ health: 'down', impactScore: 100 }) } },
    }
    const seenSt: unknown[] = []
    const pause: GqlMock = {
      request: { query: SET_SERVICE_MAP_STATUS, variables: (v) => { seenSt.push(v); return true } },
      result: { data: { setServiceMapStatus: mapDetail({ status: 'paused', version: 4 }) } },
    }
    const { user } = renderPage('admin', { extra: [reeval, pause] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Re-evaluate now' }))
    await waitFor(() => expect(seenRe).toEqual([{ id: 'map-1' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Service re-evaluated: Down'))

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(seenSt).toEqual([{ id: 'map-1', expectedVersion: 3, status: 'paused' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map Paused'))
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('admin: «Elimina» chiede conferma; annulla non chiama nulla, conferma elimina e torna alla lista', async () => {
    const seen: unknown[] = []
    const del: GqlMock = { request: { query: DELETE_SERVICE_MAP, variables: (v) => { seen.push(v); return true } }, result: { data: { deleteServiceMap: true } } }
    const { user } = renderPage('admin', { extra: [del] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('dialog', { name: 'Delete the map of "Enterprise Billing"?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(seen).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('dialog', { name: 'Delete the map of "Enterprise Billing"?' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1' }]))
    await waitFor(() => expect(location()).toBe('/monitoring/services'))
    expect(toast.success).toHaveBeenCalledWith('Map deleted')
  })

  it('mutation che fallisce → toast con il messaggio del server', async () => {
    const failing: GqlMock = { request: { query: REEVALUATE_SERVICE_MAP, variables: () => true }, error: new Error('engine busy') }
    const { user } = renderPage('admin', { extra: [failing] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Re-evaluate now' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: engine busy'))
  })

  it('viewer: nessuna azione admin, nessun controllo di configurazione, nessuna anteprima', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    await new Promise((r) => setTimeout(r, 10))
    for (const name of ['Re-evaluate now', 'Update map', 'Pause', 'Delete']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByTestId('service-rules-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('components-dirty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rules-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('components-preview')).not.toBeInTheDocument()
    // Le regole restano la lettura in parole, con la versione
    expect(screen.getByText('Rules version 1')).toBeInTheDocument()
    expect(screen.getByText('Components without health: ignored')).toBeInTheDocument()
  })

  it('admin: «Aggiorna mappa» apre il dialogo del diff col grafo; il riepilogo parte da zero', async () => {
    const { user } = renderPage('admin', { extra: [proposalMock()] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Update map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update the map of "Enterprise Billing"' })
    expect(within(dialog).getByTestId('proposal-summary')).toHaveTextContent('+0 −0 excluded 0')
    expect(await within(dialog).findAllByTestId('proposal-added')).toHaveLength(2)
  })

  it('admin: la scheda del servizio dice quanti componenti sono esclusi', async () => {
    renderPage('admin', { detail: detailMock({ excluded: [{ __typename: 'ConfigurationItemRef', id: 'old-vm', name: 'old-vm', type: 'server' }] }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Excluded components')).toBeInTheDocument()
    expect(screen.getByText('1 component')).toBeInTheDocument()
  })

  it('stale: avviso «un componente non esiste più nella CMDB»; mappa vuota: nota esplicita e solo il servizio', async () => {
    renderPage('viewer', { detail: detailMock({ stale: true, nodes: [], edges: [], explanation: [], health: 'unknown', impactScore: 0, nodeCount: 0 }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('alert')).toHaveTextContent('A component of the map no longer exists in the CMDB')
    expect(screen.getByRole('status')).toHaveTextContent('The map has no components')
    expect(screen.queryAllByTestId('service-map-node')).toHaveLength(0)
    expect(screen.getByTestId('service-map-root')).toBeInTheDocument()
    expect(screen.getByTestId('explanation-sentence')).toHaveTextContent('Unknown: no component has a known health.')
    expect(screen.getByText('No component weighed on the last evaluation.')).toBeInTheDocument()
  })

  it('valori fuori vocabolario (salute, ruolo, pesa, trigger) sono detti in chiaro, mai righe vuote', async () => {
    const weirdNode = { ...(mapDetail().nodes as Record<string, unknown>[])[3]!, role: 'exotic', propagate: 'maybe', health: 'weird' }
    const weirdEntry = { ...(mapDetail().history as Record<string, unknown>[])[1]!, id: 'h9', trigger: 'cosmic' }
    renderPage('viewer', { detail: detailMock({ health: 'strange', nodes: [weirdNode], edges: [], explanation: [], history: [weirdEntry], historyCount: 1 }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getAllByText('Unknown (strange)').length).toBeGreaterThan(0)
    const row = screen.getAllByTestId('component-row')[0]!
    expect(within(row).getByText('Unknown (exotic)')).toBeInTheDocument()
    expect(within(row).getByText('Unknown (maybe)')).toBeInTheDocument()
    expect(within(row).getByText('Unknown (weird)')).toBeInTheDocument()
    expect(screen.getByTestId('service-history-entry')).toHaveTextContent('Unknown entry: cosmic.')
  })

  it('servizio inesistente → «non trovato» con ritorno alla lista; errore della query → QueryError', async () => {
    const missing: GqlMock = { request: { query: GET_SERVICE_MAP, variables: { id: 'map-1' } }, result: { data: { serviceMap: null } } }
    const { user } = renderPage('viewer', { detail: missing })
    expect(await screen.findByText('Service not found')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to services' }))
    expect(location()).toBe('/monitoring/services')

    const failing: GqlMock = { request: { query: GET_SERVICE_MAP, variables: { id: 'map-1' } }, error: new Error('map down') }
    renderPage('viewer', { detail: failing })
    expect(await screen.findByText('map down')).toBeInTheDocument()
  })
})
