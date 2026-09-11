/**
 * Dettaglio servizio: testata con badge, punteggio, «da», frase in parole;
 * mappa a livelli (un nodo per componente sul livello giusto, percorso
 * d'impatto evidenziato fino al servizio); pannello «Perché»; pannello del
 * componente al clic; tabella componenti; cronologia; azioni admin
 * (rivaluta, pausa con expectedVersion, elimina con conferma); viewer senza
 * azioni; non trovato; errore; avviso «stale».
 * Revisione 2: esito della sincronizzazione dal motore (C-3, compreso il
 * rifiuto per il tetto), avviso «da rivedere» col motivo, i tre stati della
 * mappa (C-4), esclusione di un componente incluso (C-1) e la salute «senza
 * la finestra di change» (R1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { ServiceDetailPage } from './ServiceDetailPage'
import { GET_SERVICE_MAP, GET_SERVICE_IMPACT_PREVIEW, GET_SERVICE_MAP_PROPOSAL, GET_SERVICE_MAP_STATUS, GET_SERVICE_MAP_HISTORY } from '@/graphql/queries'
import { REEVALUATE_SERVICE_MAP, SET_SERVICE_MAP_STATUS, DELETE_SERVICE_MAP, SYNC_SERVICE_MAP, APPLY_SERVICE_MAP_PROPOSAL } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock, workflowDefinitionMock } from '@/test/mocks/gql'
import { mapDetail, mapProbe, preview, proposal, openIncident, node, syncResult, NODES } from '@/test/mocks/services'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear(); vi.mocked(toast.warning).mockClear() })

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

/**
 * La sonda del polling (C-8): per default dice gli stessi tre marcatori del
 * dettaglio, cioè «non c'è niente di nuovo». `over` serve ai test che la
 * portano avanti (versione o valutazione) per far rileggere il documento.
 */
const probeMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_SERVICE_MAP_STATUS, variables: { id: 'map-1' } },
  result: { data: { serviceMap: mapProbe(over) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, opts: { detail?: GqlMock; probe?: GqlMock; extra?: GqlMock[] } = {}) {
  return renderWithProviders(<ServiceDetailPage />, {
    route: '/monitoring/services/map-1', path: '/monitoring/services/:id',
    mocks: [meMock(role, { maxUsageCount: Number.POSITIVE_INFINITY }), opts.detail ?? detailMock(), opts.probe ?? probeMock(), previewMock, ...(opts.extra ?? [])],
  })
}

const nodes = () => screen.getAllByTestId('service-map-node')
const nodeOf = (ciId: string) => nodes().find((n) => n.getAttribute('data-ci-id') === ciId)!
const edges = () => Array.from(document.querySelectorAll('[data-testid="service-map-edge"]'))
const edgeOf = (source: string, target: string) => edges().find((e) => e.getAttribute('data-source') === source && e.getAttribute('data-target') === target)!
const location = () => screen.getByTestId('location').textContent

/**
 * Nella pagina solo incident, «Perché» e la mappa si aprono da soli: gli altri
 * riquadri sono chiusi e si aprono cliccando l'intestazione.
 */
/** L'intestazione porta anche il contatore («Components 4»); «Service» dev'essere esatto, altrimenti prende «Service map». */
const BOX_NAME = {
  Components: /^Components\b/,
  History: /^History\b/,
  'How it is computed': /^How it is computed$/,
  Service: /^Service$/,
} as const

function openBox(name: keyof typeof BOX_NAME) {
  fireEvent.click(screen.getByRole('button', { name: BOX_NAME[name] }))
}

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
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('node-panel')).not.toBeInTheDocument()
  })

  it('«Isola» dal pannello del componente: la mappa mostra solo la catena e si torna indietro dal pulsante o dall\'avviso', async () => {
    const { user } = renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    await user.click(nodeOf('db-01'))
    const panel = screen.getByTestId('node-panel')

    await user.click(within(panel).getByRole('button', { name: 'Isolate' }))
    const shown = () => screen.getAllByTestId('service-map-node').map((el) => el.getAttribute('data-ci-id'))
    expect(shown()).toContain('db-01')
    expect(shown()).not.toContain('cert-billing')                        // fuori dalla catena
    // la finestra si chiude: la catena si guarda sulla mappa, che la finestra copre
    expect(screen.queryByTestId('node-panel')).not.toBeInTheDocument()
    const banner = screen.getByTestId('map-isolated-banner')
    expect(banner).toHaveTextContent('Chain of db-01')

    // si torna alla mappa intera dall'avviso
    await user.click(within(banner).getByRole('button', { name: 'Show the whole map' }))
    expect(screen.queryByTestId('map-isolated-banner')).not.toBeInTheDocument()
    expect(shown()).toContain('cert-billing')

    // riaprendo lo stesso componente mentre la catena è isolata, il pulsante propone di tornare indietro
    await user.click(nodeOf('db-01'))
    await user.click(within(screen.getByTestId('node-panel')).getByRole('button', { name: 'Isolate' }))
    await user.click(nodeOf('db-01'))
    expect(within(screen.getByTestId('node-panel')).getByRole('button', { name: 'Show the whole map' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('tabella componenti (sola lettura) e cronologia dalla più recente con badge di salute', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    openBox('Components'); openBox('History')
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
    renderPage('viewer', { detail: detailMock({ openIncident: openIncident() }), extra: [workflowDefinitionMock()] })
    await screen.findByRole('heading', { level: 1 })
    const card = screen.getByTestId('service-open-incident')
    expect(within(card).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc-1')
    // C-12: l'etichetta del passo è quella del workflow del tenant
    await waitFor(() => expect(card).toHaveTextContent('Step: In lavorazione'))
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
    openBox('How it is computed')
    await new Promise((r) => setTimeout(r, 10))
    for (const name of ['Re-evaluate now', 'Update map', 'Review components', 'Sync now', 'Pause', 'Delete']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    // l'interruttore della mappa viva è un controllo da amministratore: il viewer vede solo il badge
    expect(screen.queryByTestId('service-auto-sync')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByTestId('sync-mode-badge')).toBeInTheDocument()
    expect(screen.queryByTestId('service-rules-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('components-dirty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('rules-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('components-preview')).not.toBeInTheDocument()
    // Le regole restano la lettura in parole, con la versione
    expect(screen.getByText('Rules version 1')).toBeInTheDocument()
    expect(screen.getByText('Components without health: ignored')).toBeInTheDocument()
  })

  it('admin: «Aggiorna mappa» (mappa congelata) apre il dialogo del diff col grafo; il riepilogo parte da zero', async () => {
    const { user } = renderPage('admin', { detail: detailMock({ autoSync: false }), extra: [proposalMock()] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Update map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Update the map of "Enterprise Billing"' })
    expect(within(dialog).getByTestId('proposal-summary')).toHaveTextContent('+0 −0 excluded 0')
    expect(await within(dialog).findAllByTestId('proposal-added')).toHaveLength(2)
  })

  it('ondata 5: badge «viva» accanto al nome e «ultima sincronizzazione» accanto a «ultima valutazione»', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    const badge = screen.getByTestId('sync-mode-badge')
    expect(badge).toHaveAttribute('data-mode', 'live')
    expect(badge).toHaveTextContent('live')
    expect(badge.parentElement).toHaveAttribute('title', 'Live map: new components come in on their own and gone ones go out, no questions asked.')
    expect(screen.getByTestId('synced-at')).toHaveTextContent('Synced 5 min ago')
  })

  it('ondata 5: mappa congelata → badge «congelata»; mai sincronizzata → «mai», non una riga vuota', async () => {
    renderPage('viewer', { detail: detailMock({ autoSync: false, syncedAt: null }) })
    await screen.findByRole('heading', { level: 1 })
    const badge = screen.getByTestId('sync-mode-badge')
    expect(badge).toHaveAttribute('data-mode', 'frozen')
    expect(badge).toHaveTextContent('frozen')
    // C-12: «ultima sincronizzazione» sta una volta sola, in testata: la scheda tiene la sola configurazione.
    expect(screen.getByTestId('synced-at')).toHaveTextContent('Never synced')
    expect(screen.queryByText('Last sync')).not.toBeInTheDocument()
  })

  it('ondata 5, admin con mappa viva: «Sincronizza ora» col resoconto del motore e «Rivedi componenti» per il diff', async () => {
    const seen: unknown[] = []
    const sync: GqlMock = {
      request: { query: SYNC_SERVICE_MAP, variables: (v) => { seen.push(v); return true } },
      // i conteggi li dà il motore, non il diff dei nodi in pagina
      result: { data: { syncServiceMap: syncResult({ map: mapDetail({ version: 4, nodes: [NODES[0], NODES[1], node({ id: 'lb-09', name: 'lb-09' })] }), added: 1, removed: 2, moved: 3 }) } },
    }
    const { user } = renderPage('admin', { extra: [sync, proposalMock()] })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Update map' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map synced: +1 −2 ~3'))
    // il dialogo del diff resta raggiungibile: sola revisione ed esclusioni
    await user.click(screen.getByRole('button', { name: 'Review components' }))
    expect(await screen.findByRole('dialog', { name: 'Update the map of "Enterprise Billing"' })).toBeInTheDocument()
  })

  it('ondata 5, admin: sincronizzazione senza cambiamenti → «già allineata», mai un successo muto', async () => {
    const sync: GqlMock = { request: { query: SYNC_SERVICE_MAP, variables: () => true }, result: { data: { syncServiceMap: syncResult() } } }
    const { user } = renderPage('admin', { extra: [sync] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map already aligned with the graph: nothing to add or remove'))
  })

  it('C-3: sincronizzazione RIFIUTATA dal motore → avviso col motivo, mai «già allineata»', async () => {
    const sync: GqlMock = {
      request: { query: SYNC_SERVICE_MAP, variables: () => true },
      // il tetto: nessuna scrittura, gli stessi nodi di prima
      result: { data: { syncServiceMap: syncResult({ skipped: true, reason: 'the proposal has 612 components, over the ceiling of 500' }) } },
    }
    const { user } = renderPage('admin', { extra: [sync] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Sync refused: the proposal has 612 components, over the ceiling of 500. Nothing was changed.'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('C-3: rifiuto senza motivo → lo si dice comunque, non lo si inventa', async () => {
    const sync: GqlMock = {
      request: { query: SYNC_SERVICE_MAP, variables: () => true },
      result: { data: { syncServiceMap: syncResult({ skipped: true, reason: null }) } },
    }
    const { user } = renderPage('admin', { extra: [sync] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Sync refused: the engine gave no reason. Nothing was changed.'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('C-3: una sincronizzazione che ha solo spostato livelli non è «già allineata»', async () => {
    const sync: GqlMock = {
      request: { query: SYNC_SERVICE_MAP, variables: () => true },
      result: { data: { syncServiceMap: syncResult({ map: mapDetail({ version: 4 }), moved: 2 }) } },
    }
    const { user } = renderPage('admin', { extra: [sync] })
    await screen.findByRole('heading', { level: 1 })
    await user.click(screen.getByRole('button', { name: 'Sync now' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map synced: +0 −0 ~2'))
  })

  it('C-3: l\'avviso «da rivedere» dice il motivo vero, e col tetto superato manda a «Rivedi componenti» invece che a sincronizzare', async () => {
    renderPage('admin', { detail: detailMock({ stale: true, staleReason: 'over_limit' }), extra: [proposalMock()] })
    await screen.findByRole('heading', { level: 1 })
    const banner = screen.getByTestId('stale-banner')
    expect(banner).toHaveAttribute('data-reason', 'over_limit')
    expect(banner).toHaveTextContent('The map goes over the ceiling of 500 components: reduce the depth or exclude something.')
    expect(within(banner).getByRole('button', { name: 'Review components' })).toBeInTheDocument()
  })

  it('C-3: motivo «componente sparito» → il testo della CMDB; motivo assente → il testo generico', async () => {
    const { unmount } = renderPage('viewer', { detail: detailMock({ stale: true, staleReason: 'missing_ci' }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByTestId('stale-banner')).toHaveTextContent('A component of the map no longer exists in the CMDB: review the components.')
    unmount()

    renderPage('viewer', { detail: detailMock({ stale: true, staleReason: null }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByTestId('stale-banner')).toHaveTextContent('A component of the map no longer exists in the CMDB: the map needs updating.')
  })

  it('C-4: una bozza si attiva con un pulsante «Attiva» (non con il giro pausa/riattiva)', async () => {
    const seen: unknown[] = []
    const activate: GqlMock = {
      request: { query: SET_SERVICE_MAP_STATUS, variables: (v) => { seen.push(v); return true } },
      result: { data: { setServiceMapStatus: mapDetail({ status: 'active', version: 4 }) } },
    }
    const { user } = renderPage('admin', { detail: detailMock({ status: 'draft' }), extra: [activate] })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Activate' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, status: 'active' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Map Active'))
  })

  it('C-4: una mappa in pausa si riattiva; una attiva si mette in pausa', async () => {
    const seen: unknown[] = []
    const resume: GqlMock = {
      request: { query: SET_SERVICE_MAP_STATUS, variables: (v) => { seen.push(v); return true } },
      result: { data: { setServiceMapStatus: mapDetail({ status: 'active', version: 4 }) } },
    }
    const { user, unmount } = renderPage('admin', { detail: detailMock({ status: 'paused' }), extra: [resume] })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, status: 'active' }]))
    unmount()

    renderPage('admin', { detail: detailMock({ status: 'active' }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('C-1: escludere un componente incluso dalla tabella lo fa sparire dalla pagina', async () => {
    const seen: unknown[] = []
    const withoutDb = (mapDetail().nodes as Record<string, unknown>[]).filter((n) => (n.ci as { id: string }).id !== 'db-01')
    const exclude: GqlMock = {
      request: { query: APPLY_SERVICE_MAP_PROPOSAL, variables: (v) => { seen.push(v); return true } },
      result: { data: { applyServiceMapProposal: mapDetail({ version: 4, nodes: withoutDb, nodeCount: 3, edges: [], explanation: [] }) } },
    }
    const { user } = renderPage('admin', { extra: [exclude] })
    await screen.findByRole('heading', { level: 1 })
    openBox('Components')
    expect(screen.getAllByTestId('component-row').map((r) => r.getAttribute('data-ci-id'))).toContain('db-01')
    await user.click(screen.getByRole('button', { name: 'Exclude db-01 from the map' }))
    const dialog = await screen.findByRole('dialog', { name: 'Exclude db-01 from the map?' })
    await user.click(within(dialog).getByRole('button', { name: 'Exclude' }))
    await waitFor(() => expect(seen).toEqual([{ id: 'map-1', expectedVersion: 3, add: [], exclude: ['db-01'], remove: [] }]))
    await waitFor(() => expect(screen.getAllByTestId('component-row').map((r) => r.getAttribute('data-ci-id'))).not.toContain('db-01'))
  })

  it('R1: con la salute «in manutenzione» la testata dice anche come starebbe senza la finestra di change', async () => {
    renderPage('viewer', { detail: detailMock({ health: 'maintenance', healthIfActive: 'down' }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByTestId('health-if-active')).toHaveTextContent('in maintenance, would be: Down')
  })

  it('R1: il pannello del componente dice perché il nodo non ha contato', async () => {
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) =>
      (n.ci as { id: string }).id === 'db-01' ? { ...n, contributes: false, excludedReason: 'lifecycle_maintenance' } : n)
    const { user } = renderPage('viewer', { detail: detailMock({ nodes }) })
    await screen.findByRole('heading', { level: 1 })
    await user.click(nodeOf('db-01'))
    expect(within(screen.getByTestId('node-panel')).getByText('No — in maintenance (lifecycle)')).toBeInTheDocument()
  })

  it('R2 (D6.4): la nota della valutazione compare sotto la salute quando c\'è, e non c\'è quando è nulla', async () => {
    const note = 'Source Prometheus in storm since 08:12: evaluation held, health left as it was.'
    const { unmount } = renderPage('viewer', { detail: detailMock({ healthNote: note }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByTestId('health-note')).toHaveTextContent(note)
    unmount()

    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('health-note')).not.toBeInTheDocument()
  })

  it('R2 (D6.2/D6.3): i due motivi nuovi per nodo nel pannello del componente', async () => {
    const nodes = (mapDetail().nodes as Record<string, unknown>[]).map((n) => {
      const id = (n.ci as { id: string }).id
      if (id === 'db-01')   return { ...n, contributes: false, excludedReason: 'lifecycle_decommissioned' }
      if (id === 'cache-02') return { ...n, contributes: false, inMaintenance: true, excludedReason: 'upstream_change_window' }
      return n
    })
    const { user } = renderPage('viewer', { detail: detailMock({ nodes, healthNote: 'CHG-0007 on api-03 covers cache-02.' }) })
    await screen.findByRole('heading', { level: 1 })
    await user.click(nodeOf('db-01'))
    expect(within(screen.getByTestId('node-panel')).getByText('No — CI decommissioned (out of the calculation)')).toBeInTheDocument()
    await user.click(nodeOf('cache-02'))
    expect(within(screen.getByTestId('node-panel')).getByText('No — in a change window on an upstream CI')).toBeInTheDocument()
    // la mappa dice anche quale change copre il componente a monte
    expect(screen.getByTestId('health-note')).toHaveTextContent('CHG-0007 on api-03 covers cache-02.')
  })

  it('R1: fuori dalla manutenzione (o senza il dato) non si aggiunge nulla alla testata', async () => {
    const { unmount } = renderPage('viewer', { detail: detailMock({ health: 'maintenance', healthIfActive: null }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('health-if-active')).not.toBeInTheDocument()
    unmount()

    renderPage('viewer', { detail: detailMock({ health: 'degraded', healthIfActive: 'down' }) })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByTestId('health-if-active')).not.toBeInTheDocument()
  })

  it('ondata 5, admin con mappa congelata: il pulsante torna «Aggiorna mappa» e non c\'è «Sincronizza ora»', async () => {
    renderPage('admin', { detail: detailMock({ autoSync: false }), extra: [proposalMock()] })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('button', { name: 'Update map' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review components' })).not.toBeInTheDocument()
  })

  it('ondata 5, admin: l\'interruttore per congelare la mappa è nel riquadro del servizio', async () => {
    renderPage('admin')
    await screen.findByRole('heading', { level: 1 })
    openBox('Service')
    expect(screen.getByTestId('service-auto-sync')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Update components automatically' })).toHaveAttribute('aria-checked', 'true')
  })

  it('admin: la scheda del servizio dice quanti componenti sono esclusi', async () => {
    renderPage('admin', { detail: detailMock({ excluded: [{ __typename: 'ConfigurationItemRef', id: 'old-vm', name: 'old-vm', type: 'server' }] }) })
    await screen.findByRole('heading', { level: 1 })
    openBox('Service')
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
    openBox('Components'); openBox('History')
    expect(screen.getAllByText('Unknown (strange)').length).toBeGreaterThan(0)
    const row = screen.getAllByTestId('component-row')[0]!
    expect(within(row).getByText('Unknown (exotic)')).toBeInTheDocument()
    expect(within(row).getByText('Unknown (maybe)')).toBeInTheDocument()
    expect(within(row).getByText('Unknown (weird)')).toBeInTheDocument()
    expect(screen.getByTestId('service-history-entry')).toHaveTextContent('Unknown entry: cosmic.')
  })

  it('C-8: con la sonda allineata il documento pesante si legge una volta sola', async () => {
    let reads = 0
    const detail: GqlMock = {
      request: { query: GET_SERVICE_MAP, variables: () => { reads += 1; return true } },
      result: { data: { serviceMap: mapDetail() } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    renderPage('viewer', { detail })
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(screen.getAllByTestId('service-map-node')).toHaveLength(4))
    expect(reads).toBe(1)
  })

  it('C-8: quando la sonda va avanti (valutazione nuova) il dettaglio si rilegge tutto', async () => {
    const first: GqlMock = {
      request: { query: GET_SERVICE_MAP, variables: { id: 'map-1' } },
      result: { data: { serviceMap: mapDetail() } },
      maxUsageCount: 1,
    }
    const afterSync: GqlMock = {
      request: { query: GET_SERVICE_MAP, variables: { id: 'map-1' } },
      result: { data: { serviceMap: mapDetail({ version: 9, nodes: [NODES[0]], nodeCount: 1, edges: [], explanation: [] }) } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    renderPage('viewer', { detail: first, probe: probeMock({ version: 9 }), extra: [afterSync] })
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(screen.getAllByTestId('service-map-node')).toHaveLength(1))
    expect(screen.getByTestId('map-version')).toHaveTextContent('Version 9')
  })

  it('C-8: la cronologia parte dalle ultime voci e «Mostra tutte» le chiede a parte', async () => {
    const older = Array.from({ length: 3 }, (_, i) => ({
      __typename: 'ServiceHealthEntry', id: `old-${i}`, at: '2026-09-09T08:00:00Z', health: 'operational',
      previousHealth: 'degraded', impactScore: 0, trigger: 'periodic', causes: [], note: null,
    }))
    const all: GqlMock = {
      request: { query: GET_SERVICE_MAP_HISTORY, variables: { id: 'map-1', limit: 500 } },
      result: { data: { serviceMap: { __typename: 'ServiceMap', id: 'map-1', historyCount: 5, history: [...(mapDetail().history as Record<string, unknown>[]), ...older] } } },
      maxUsageCount: Number.POSITIVE_INFINITY,
    }
    const { user } = renderPage('viewer', { detail: detailMock({ historyCount: 5 }), extra: [all] })
    await screen.findByRole('heading', { level: 1 })
    openBox('History')
    expect(screen.getAllByTestId('service-history-entry')).toHaveLength(2)
    expect(screen.getByText('Showing the latest 2 of 5 entries.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all' }))
    await waitFor(() => expect(screen.getAllByTestId('service-history-entry')).toHaveLength(5))
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument()
  })

  it('C-11: con la mappa in pausa «Sincronizza ora» è disabilitato e dice perché; «Rivaluta ora» resta (l\'API lo accetta)', async () => {
    renderPage('admin', { detail: detailMock({ status: 'paused' }) })
    await screen.findByRole('heading', { level: 1 })
    const sync = screen.getByRole('button', { name: 'Sync now' })
    expect(sync).toBeDisabled()
    expect(sync).toHaveAttribute('title', 'Resume the map to synchronize it: while it is paused the engine refuses to synchronize.')
    expect(screen.getByRole('button', { name: 'Re-evaluate now' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Review components' })).toBeEnabled()
  })

  it('C-12: i metadati stanno una volta sola in testata (versione compresa), la scheda tiene la configurazione', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    openBox('Service')
    expect(screen.getByTestId('map-version')).toHaveTextContent('Version 3')
    expect(screen.getByTestId('evaluated-at')).toHaveTextContent('Evaluated 2 min ago')
    expect(screen.queryByText('Last evaluation')).not.toBeInTheDocument()
    expect(screen.queryByText('Map status')).not.toBeInTheDocument()
    expect(screen.queryByText('Version')).not.toBeInTheDocument()       // la riga della scheda non c'è più
    expect(screen.getByText('Maximum depth')).toBeInTheDocument()       // la configurazione sì
  })

  it('C-12: nel pannello del nodo «da dove si arriva» seleziona il predecessore', async () => {
    const { user } = renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    await user.click(nodeOf('db-01'))
    const panel = screen.getByTestId('node-panel')
    await user.click(within(panel).getByTestId('node-via'))
    expect(screen.getByTestId('node-panel')).toHaveAttribute('data-ci-id', 'api-03')
    // un nodo di livello 1 arriva dal servizio: si dice, non resta vuoto
    expect(within(screen.getByTestId('node-panel')).getByTestId('node-via')).toHaveTextContent('Straight from the service')
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
