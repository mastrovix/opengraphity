import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { EventsPage } from './EventsPage'
import { GET_EVENTS, GET_EVENT_STATS, GET_ENTITY_FILTER_FIELDS, GET_MONITORING_SOURCE_REFS, GET_EVENT_POLICY } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import { serviceMapsMock, mapRow } from '@/test/mocks/services'
import { formatDateTime } from '@/lib/datetime'
import { FILTER_GROUP_PARAM, decodeFilterGroup, encodeFilterGroup } from '@/lib/filterGroupUrl'
import type { EventRow, EventStats, StormSource } from '@/types/events'

const STATS: EventStats = { firing: 4, critical: 2, warning: 1, orphan: 1, suppressed: 0, flapping: 1, resolved24h: 7, stormSources: [] }

/** La console legge la riga leggera (EventRowFields): niente descrizione, etichette, impronta. */
function eventFixture(over: Partial<EventRow> & { id: string }): EventRow {
  return {
    status: 'firing', severity: 'critical',
    title: `Alert ${over.id}`, resource: 'web-01', resourceKind: 'hostname',
    count: 3, lastSeenAt: new Date().toISOString(),
    acknowledgedAt: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: null },
    incident: null,
    suppressedBy: null, correlation: 'none', correlationAt: null,
    flappingSince: null, transitions24h: 0,
    matchReason: null,
    ...over,
  }
}

/** Aggiunge `__typename` come farebbe la cache Apollo. */
function typed(ev: EventRow) {
  return {
    __typename: 'Event', ...ev,
    source:   ev.source   ? { __typename: 'MonitoringSourceRef', ...ev.source } : null,
    ci:       ev.ci       ? { __typename: 'ConfigurationItemRef', ...ev.ci } : null,
    incident: ev.incident ? { __typename: 'Incident', ...ev.incident } : null,
    suppressedBy: ev.suppressedBy ? { __typename: 'Change', ...ev.suppressedBy } : null,
  }
}

const policyMock = (): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: {
    __typename: 'EventPolicy', version: 1, updatedAt: null, openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
    suppressUpstreamHops: 1, flapThreshold: 5, flapWindowMinutes: 10, flapStableMinutes: 15,
    stormThresholdPerMinute: 50, stormCooldownMinutes: 5, retentionDays: 30, severityMap: '{}',
    ignoreLifecycleStatuses: ['decommissioned'],
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const EVENTS: EventRow[] = [
  eventFixture({ id: 'e1', title: 'CPU high on web-01' }),
  eventFixture({ id: 'e2', title: 'Disk full on unknown host', severity: 'warning', ci: null, resource: 'db-99', incident: { id: 'inc1', number: 'INC-0042', title: 'Disk', status: 'new' } }),
  eventFixture({ id: 'e3', title: 'Old alert', status: 'resolved' }),
]

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function eventsMock(items = EVENTS, seen?: Vars[], opts: { match?: (v: Vars) => boolean; delay?: number } = {}): GqlMock {
  return {
    request: { query: GET_EVENTS, variables: (v) => { const ok = opts.match ? opts.match(v as Vars) : true; if (ok) seen?.push(v as Vars); return ok } },
    result: { data: { events: { __typename: 'EventPage', total: items.length, items: items.map(typed) } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
    ...(opts.delay !== undefined ? { delay: opts.delay } : {}),
  }
}

const statsMock = (stormSources: StormSource[] = []): GqlMock => ({
  request: { query: GET_EVENT_STATS },
  result: { data: { eventStats: { __typename: 'EventStats', ...STATS, stormSources: stormSources.map((s) => ({ __typename: 'StormSource', ...s })) } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

// Lo schema offre anche `description` e `labels`: la console non li propone,
// perché la riga leggera non li porta e il FilterBuilder è applicato lato client.
const fieldsMock = (): GqlMock => ({
  request: { query: GET_ENTITY_FILTER_FIELDS, variables: { typeName: 'Event' } },
  result: { data: { entityFilterFields: [
    { __typename: 'EntityFilterField', name: 'title',       kind: 'SCALAR', scalarName: 'String', enumValues: null },
    { __typename: 'EntityFilterField', name: 'description', kind: 'SCALAR', scalarName: 'String', enumValues: null },
    { __typename: 'EntityFilterField', name: 'labels',      kind: 'SCALAR', scalarName: 'String', enumValues: null },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

// La console legge i riferimenti leggeri (monitoringSourceRefs), non la configurazione completa (admin).
const sourcesMock = (names: string[] = ['Prometheus', 'Zabbix']): GqlMock => ({
  request: { query: GET_MONITORING_SOURCE_REFS },
  result: { data: { monitoringSourceRefs: names.map((name, i) => ({
    __typename: 'MonitoringSourceRef', id: `wh${i + 1}`, name, connectorKind: 'alertmanager', enabled: true,
  })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, seen?: Vars[], opts: { route?: string; sources?: string[]; events?: EventRow[]; storms?: StormSource[]; eventsMocks?: GqlMock[]; downServices?: Record<string, unknown>[] } = {}) {
  return renderWithProviders(<EventsPage />, { route: opts.route ?? '/events', mocks: [meMock(role), statsMock(opts.storms), ...(opts.eventsMocks ?? [eventsMock(opts.events ?? EVENTS, seen)]), fieldsMock(), sourcesMock(opts.sources), policyMock(), serviceMapsMock(opts.downServices)] })
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

describe('EventsPage', () => {
  it('operator: contatori, righe con stato/CI/incident e azioni per riga', async () => {
    renderPage('operator')
    expect(await screen.findByText('CPU high on web-01')).toBeInTheDocument()
    expect(screen.getByText('3 alarms')).toBeInTheDocument()

    // contatori da eventStats
    expect(screen.getByRole('button', { name: /Active\s*4/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Resolved 24h\s*7/ })).toBeInTheDocument()

    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(within(rows[1]!).getByText('No CI')).toBeInTheDocument()
    expect(within(rows[1]!).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc1')
    expect(within(rows[2]!).getByText('Resolved')).toBeInTheDocument()

    // azioni: la riga orfana offre "Link to CI", l'evento risolto non offre presa in carico
    await waitFor(() => expect(within(rows[0]!).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument())
    expect(within(rows[1]!).getByRole('button', { name: 'Link to CI' })).toBeInTheDocument()
    expect(within(rows[0]!).queryByRole('button', { name: 'Link to CI' })).not.toBeInTheDocument()
    expect(within(rows[2]!).queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
  })

  it('viewer: nessuna azione di mutation nelle righe', async () => {
    renderPage('viewer')
    expect(await screen.findByText('CPU high on web-01')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 10)) // `me` risolto
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link to CI' })).not.toBeInTheDocument()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument()
  })

  it('il click su un contatore imposta il filtro della query', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', seen)
    await screen.findByText('CPU high on web-01')
    expect(seen[0]).toEqual({ filter: null, limit: 50, offset: 0 })

    const tile = screen.getByRole('button', { name: /Critical\s*2/ })
    await user.click(tile)
    expect(tile).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(seen.at(-1)).toEqual({ filter: { status: ['firing'], severity: ['critical'] }, limit: 50, offset: 0 }))

    // "Orphans only" raffina il filtro corrente: il contatore non è più "il" filtro attivo
    await user.click(screen.getByRole('button', { name: 'No CI only' }))
    expect(tile).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['firing'], severity: ['critical'], orphan: true }))
  })

  it('il click sulla riga apre il dettaglio', async () => {
    const { user } = renderPage('viewer')
    await user.click(await screen.findByText('CPU high on web-01'))
    expect(screen.getByTestId('location')).toHaveTextContent('/events/e1')
  })
})

describe('EventsPage — prestazioni (ondata 3)', () => {
  it('al cambio di filtro la tabella tiene le righe precedenti con "Updating…", senza skeleton', async () => {
    const FILTERED = [eventFixture({ id: 'x1', title: 'Only critical one' })]
    const { user } = renderPage('viewer', undefined, {
      eventsMocks: [
        eventsMock(EVENTS,   undefined, { match: (v) => v.filter === null }),
        eventsMock(FILTERED, undefined, { match: (v) => v.filter !== null, delay: 150 }),
      ],
    })
    expect(await screen.findByText('CPU high on web-01')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Critical\s*2/ }))
    // in attesa della nuova pagina: righe vecchie ancora visibili + indicatore discreto
    expect(await screen.findByRole('status')).toHaveTextContent('Updating…')
    expect(screen.getByText('CPU high on web-01')).toBeInTheDocument()
    expect(screen.getByText('3 alarms')).toBeInTheDocument()

    expect(await screen.findByText('Only critical one')).toBeInTheDocument()
    expect(screen.queryByText('CPU high on web-01')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByText('1 alarm')).toBeInTheDocument()   // plurale _one (D·6.1)
  })

  it('il FilterBuilder offre solo i campi della riga leggera (niente description/labels)', async () => {
    const { user } = renderPage('viewer')
    await screen.findByText('CPU high on web-01')
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: '+ Add filter' }))
    // l'ultimo combobox è il campo della regola appena aggiunta (il primo è il filtro Sorgente)
    const fieldSelect = screen.getAllByRole('combobox').at(-1) as HTMLSelectElement
    const values = Array.from(fieldSelect.options).map((o) => o.value)
    expect(values).toContain('title')
    expect(values).not.toContain('description')
    expect(values).not.toContain('labels')
  })
})

describe('EventsPage — correlazione automatica (ondata 3)', () => {
  const CHG = { id: 'chg1', code: 'CHG-0007', title: 'Freeze DB' }
  const CORRELATED: EventRow[] = [
    eventFixture({ id: 'c1', title: 'Opened by policy', correlation: 'opened', correlationAt: '2026-09-09T08:00:00Z', incident: { id: 'inc1', number: 'INC-0042', title: 'CPU', status: 'new' } }),
    eventFixture({ id: 'c2', title: 'Silenced by change', status: 'suppressed', correlation: 'suppressed', correlationAt: '2026-09-09T08:00:00Z', suppressedBy: CHG }),
    eventFixture({ id: 'c3', title: 'Waiting for delay', correlation: 'delayed', correlationAt: new Date(Date.now() - 30_000).toISOString() }),
    eventFixture({ id: 'c4', title: 'Orphan alarm', ci: null, correlation: 'skipped_orphan', correlationAt: '2026-09-09T08:00:00Z' }),
    eventFixture({ id: 'c5', title: 'Below threshold', severity: 'warning', correlation: 'skipped_severity', correlationAt: '2026-09-09T08:00:00Z' }),
  ]

  it('colonna Incident: link con icona "automatico", chip silenziato/in attesa/collega un CI, trattino sotto soglia', async () => {
    renderPage('operator', undefined, { events: CORRELATED })
    expect(await screen.findByText('Opened by policy')).toBeInTheDocument()
    const rows = bodyRows()

    // aperto dalla policy: link all'incident + icona con tooltip
    expect(within(rows[0]!).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc1')
    expect(within(rows[0]!).getByRole('img', { name: 'Incident opened automatically by monitoring' })).toBeInTheDocument()

    // silenziato: chip grigio con il codice della change, link al suo dettaglio
    expect(within(rows[1]!).getByRole('link', { name: 'Suppressed · CHG-0007' })).toHaveAttribute('href', '/changes/chg1')

    // in attesa: chip con countdown dal ritardo di policy (120 s − 30 s trascorsi)
    const waiting = within(rows[2]!).getByText('Waiting')
    expect(waiting).toHaveAttribute('title', expect.stringMatching(/^Opens in (8\d|9\d) s$/))

    // orfano: chip ambra "Collega un CI"
    expect(within(rows[3]!).getByText('Link a CI')).toBeInTheDocument()

    // sotto soglia: nessun incident, nessun chip
    expect(within(rows[4]!).getByText('—')).toBeInTheDocument()
  })

  it('"Rivaluta ora" solo per silenziati / in attesa / orfani; un evento silenziato non offre "Apri incident"', async () => {
    renderPage('operator', undefined, { events: CORRELATED })
    expect(await screen.findByText('Opened by policy')).toBeInTheDocument()
    const rows = bodyRows()
    await waitFor(() => expect(within(rows[1]!).getByRole('button', { name: 'Re-evaluate now' })).toBeInTheDocument())
    expect(within(rows[2]!).getByRole('button', { name: 'Re-evaluate now' })).toBeInTheDocument()
    expect(within(rows[3]!).getByRole('button', { name: 'Re-evaluate now' })).toBeInTheDocument()
    expect(within(rows[0]!).queryByRole('button', { name: 'Re-evaluate now' })).not.toBeInTheDocument()
    expect(within(rows[4]!).queryByRole('button', { name: 'Re-evaluate now' })).not.toBeInTheDocument()

    expect(within(rows[1]!).queryByRole('button', { name: 'Open incident' })).not.toBeInTheDocument()
    expect(within(rows[4]!).getByRole('button', { name: 'Open incident' })).toBeInTheDocument()
  })

  it('D6.3: chip grigio «Ciclo di vita · <stato>» per l\'allarme su un CI dismesso, con il motivo per esteso', async () => {
    const events = [
      eventFixture({ id: 'l1', title: 'Alarm on a retired CI', correlation: 'skipped_lifecycle', correlationAt: '2026-09-09T08:00:00Z', ci: { id: 'ci9', name: 'old-vm', type: 'server', status: 'decommissioned', health: null } }),
      // stesso esito ma senza stato registrato sul CI: l'etichetta non inventa il valore
      eventFixture({ id: 'l2', title: 'Alarm without status', correlation: 'skipped_lifecycle', correlationAt: '2026-09-09T08:00:00Z', ci: { id: 'ci8', name: 'ghost', type: 'server', status: null, health: null } }),
    ]
    renderPage('operator', undefined, { events })
    expect(await screen.findByText('Alarm on a retired CI')).toBeInTheDocument()
    const rows = bodyRows()
    const chip = within(rows[0]!).getByText('Lifecycle · Decommissioned')
    expect(chip).toHaveAttribute('title', expect.stringContaining('CI old-vm is in status “Decommissioned”'))
    expect(within(rows[0]!).getByText(/no incident opened and CI health unchanged/)).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Lifecycle ignored')).toBeInTheDocument()
  })

  it('viewer: i chip restano, "Rivaluta ora" no', async () => {
    renderPage('viewer', undefined, { events: CORRELATED })
    expect(await screen.findByRole('link', { name: 'Suppressed · CHG-0007' })).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).not.toBeInTheDocument()
  })
})

describe('EventsPage — sfarfallio e tempeste (ondata 4)', () => {
  const STORM_INC = { id: 'inc9', number: 'INC-0099', title: 'Storm from Prometheus', status: 'new' }
  const WAVE4: EventRow[] = [
    eventFixture({ id: 'f1', title: 'Flapping alarm', status: 'flapping', correlation: 'flapping', correlationAt: '2026-09-09T08:00:00Z', flappingSince: '2026-09-09T07:30:00Z', transitions24h: 12 }),
    eventFixture({ id: 's1', title: 'Storm alarm', correlation: 'storm', correlationAt: '2026-09-09T08:00:00Z', incident: STORM_INC }),
    eventFixture({ id: 's2', title: 'Storm orphan', ci: null, correlation: 'storm_no_ci', correlationAt: '2026-09-09T08:00:00Z' }),
  ]
  const STORMS: StormSource[] = [
    { sourceId: 'wh1', sourceName: 'Prometheus', ratePerMinute: 73, since: '2026-09-09T08:00:00Z', incidentId: 'inc9', incidentNumber: 'INC-0099' },
    { sourceId: 'wh2', sourceName: 'Zabbix', ratePerMinute: 41, since: '2026-09-09T08:10:00Z', incidentId: null, incidentNumber: null },
  ]

  it('chip "Instabile · N passaggi/24h" con tooltip dai minuti di stabilità; "Tempesta · INC" linkato; "Tempesta, nessun CI"', async () => {
    renderPage('viewer', undefined, { events: WAVE4 })
    expect(await screen.findByText('Flapping alarm')).toBeInTheDocument()
    const rows = bodyRows()

    const flap = within(rows[0]!).getByText('Flapping · 12 transitions/24h')
    await waitFor(() => expect(flap).toHaveAttribute('title', 'Waiting for it to stay stable for 15 minutes'))

    expect(within(rows[1]!).getByRole('link', { name: 'Storm · INC-0099' })).toHaveAttribute('href', '/incidents/inc9')
    expect(within(rows[2]!).getByText('Storm, no CI')).toBeInTheDocument()
    // niente banner: nessuna sorgente in tempesta nei contatori
    expect(screen.queryByTestId('storm-banner')).not.toBeInTheDocument()
  })

  it('banner di tempesta (admin): una riga per sorgente, link all\'incident di tempesta e alle Sorgenti', async () => {
    renderPage('admin', undefined, { storms: STORMS })
    const banner = await screen.findByTestId('storm-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveTextContent('Storms in progress (2 sources)')
    const lines = within(banner).getAllByRole('listitem')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent(/^Storm in progress from Prometheus: 73 alarms per minute since \d{2}:\d{2}, grouped into INC-0099\. View the source's alarms$/)
    expect(within(lines[0]!).getByRole('link', { name: 'INC-0099' })).toHaveAttribute('href', '/incidents/inc9')
    expect(lines[1]).toHaveTextContent(/^Storm in progress from Zabbix: 41 alarms per minute since \d{2}:\d{2}; no storm incident\. View the source's alarms$/)
    // azione per l'operatore: console filtrata per sorgente
    expect(within(lines[0]!).getByRole('link', { name: "View the source's alarms" })).toHaveAttribute('href', '/events?sourceId=wh1')
    await waitFor(() => expect(within(banner).getByRole('link', { name: /Sources/ })).toHaveAttribute('href', '/monitoring/sources'))
  })

  it('banner dei servizi critici: compare in console quando un servizio critico è giù, non quando nessuno lo è', async () => {
    renderPage('operator', undefined, { downServices: [mapRow({ health: 'down', impactScore: 100 })] })
    const banner = await screen.findByTestId('critical-services-banner')
    expect(banner).toHaveTextContent('A critical service is down')
    expect(within(banner).getByRole('link', { name: 'Enterprise Billing' })).toHaveAttribute('href', '/monitoring/services/map-1')
  })

  it('nessun servizio critico giù: in console non compare nessun banner dei servizi', async () => {
    renderPage('operator')
    await screen.findByText('CPU high on web-01')
    expect(screen.queryByTestId('critical-services-banner')).not.toBeInTheDocument()
  })

  it('banner di tempesta (operator): il link alle Sorgenti (pagina admin) non c\'è', async () => {
    renderPage('operator', undefined, { storms: STORMS })
    const banner = await screen.findByTestId('storm-banner')
    await new Promise((r) => setTimeout(r, 10))
    expect(within(banner).queryByRole('link', { name: /Sources/ })).not.toBeInTheDocument()
    expect(within(banner).getByRole('link', { name: 'INC-0099' })).toBeInTheDocument()
  })
})

describe('EventsPage — sorgenti di monitoraggio', () => {
  it('il filtro per sorgente elenca le sorgenti e imposta sourceId nella query', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('operator', seen)
    await screen.findByText('CPU high on web-01')
    const select = await screen.findByLabelText('Source')
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Zabbix' })).toBeInTheDocument())
    await user.selectOptions(select, 'wh2')
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ sourceId: 'wh2' }))
    // il contatore conserva la sorgente scelta
    await user.click(screen.getByRole('button', { name: /Critical\s*2/ }))
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['firing'], severity: ['critical'], sourceId: 'wh2' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('?sourceId= e ?stat= dalla query string sono applicati al primo caricamento', async () => {
    const seen: Vars[] = []
    renderPage('operator', seen, { route: '/events?sourceId=wh1&stat=orphan' })
    await screen.findByText('CPU high on web-01')
    expect(seen[0]?.filter).toEqual({ orphan: true, sourceId: 'wh1' })
    expect(screen.getByRole('button', { name: /No CI\s*1/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('nessuna sorgente (admin): banner con link alla procedura guidata', async () => {
    renderPage('admin', undefined, { sources: [] })
    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('No monitoring source is connected yet')
    expect(within(banner).getByRole('link', { name: /Add the first source/ })).toHaveAttribute('href', '/monitoring/sources/new')
  })

  it('nessuna sorgente (viewer): invito a chiedere a un amministratore, nessun link', async () => {
    renderPage('viewer', undefined, { sources: [] })
    const banner = await screen.findByRole('status')
    await waitFor(() => expect(banner).toHaveTextContent('Ask an administrator to connect a monitoring tool.'))
    expect(within(banner).queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('EventsPage — filtri nell\'URL (ondata 5)', () => {
  const location = () => screen.getByTestId('location').textContent

  it('?ciId=: chip "Solo questo CI" attivo, la rimozione toglie il filtro dalla query e dall\'URL', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('viewer', seen, { route: '/events?ciId=ci1&status=firing' })
    await screen.findByText('CPU high on web-01')
    expect(seen[0]?.filter).toEqual({ status: ['firing'], ciId: 'ci1' })
    const chip = screen.getByRole('button', { name: 'Only this CI' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')

    await user.click(chip)
    expect(screen.queryByRole('button', { name: 'Only this CI' })).not.toBeInTheDocument()
    expect(location()).toBe('/events?status=firing')
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['firing'] }))
  })

  it('un chip di stato e la ricerca finiscono nell\'URL; il contatore usa ?stat= e sostituisce i filtri espliciti', async () => {
    const seen: Vars[] = []
    const { user } = renderPage('viewer', seen)
    await screen.findByText('CPU high on web-01')
    await user.click(screen.getByRole('button', { name: 'Resolved' }))
    expect(location()).toBe('/events?status=resolved')
    await user.type(screen.getByLabelText('Search'), 'cpu')
    await waitFor(() => expect(location()).toBe('/events?status=resolved&q=cpu'))
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['resolved'], search: 'cpu' }))

    await user.click(screen.getByRole('button', { name: /Critical\s*2/ }))
    expect(location()).toBe('/events?q=cpu&stat=critical')
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['firing'], severity: ['critical'], search: 'cpu' }))
  })

  it('?stat=resolved24h: since = adesso − 24 h', async () => {
    const seen: Vars[] = []
    renderPage('viewer', seen, { route: '/events?stat=resolved24h' })
    await screen.findByText('CPU high on web-01')
    const f = seen[0]?.filter as { status: string[]; since: string }
    expect(f.status).toEqual(['resolved'])
    const ageMs = Date.now() - Date.parse(f.since)
    expect(ageMs).toBeGreaterThan(24 * 3_600_000 - 5_000)
    expect(ageMs).toBeLessThan(24 * 3_600_000 + 5_000)
    expect(screen.getByRole('button', { name: /Resolved 24h\s*7/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('?incidentId= e ?changeId=: chip di contesto e variabili incidentId / suppressedByChangeId', async () => {
    const seen: Vars[] = []
    renderPage('viewer', seen, { route: '/events?incidentId=inc1&changeId=chg1' })
    await screen.findByText('CPU high on web-01')
    expect(seen[0]?.filter).toEqual({ incidentId: 'inc1', suppressedByChangeId: 'chg1' })
    expect(screen.getByRole('button', { name: 'This incident only' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'This change only' })).toBeInTheDocument()
  })

  it('filtro avanzato: "N di M in questa pagina" sotto la tabella, conteggio globale nascosto', async () => {
    const { user } = renderPage('viewer')
    await screen.findByText('CPU high on web-01')
    await user.click(screen.getByRole('button', { name: /Advanced filters/ }))
    await user.click(screen.getByRole('button', { name: '+ Add filter' }))
    // l'ultimo combobox è il campo della regola appena aggiunta (il primo è il filtro Sorgente)
    await user.selectOptions(screen.getAllByRole('combobox').at(-1)!, 'title')
    await user.type(screen.getByPlaceholderText('Valore…'), 'Disk')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    expect(await screen.findByText('1 of 3 on this page matches the advanced filter')).toBeInTheDocument()
    expect(screen.queryByText('3 alarms')).not.toBeInTheDocument()
    expect(screen.getByText(/Advanced filter active/)).toBeInTheDocument()
    // C-15: il gruppo finisce nell'URL (`?f=`), così un collegamento condiviso lo porta con sé.
    const f = new URLSearchParams(location().split('?')[1] ?? '').get(FILTER_GROUP_PARAM)
    expect(f).not.toBeNull()
    expect(decodeFilterGroup(f)).toMatchObject({ rules: [{ field: 'title', operator: 'contains', value: 'Disk' }] })
  })

  // C-15 / residuo D·1.7: il gruppo del costruttore di filtri viaggia nell'URL.
  it('?f= applica il gruppo all\'apertura e lo mostra nel pannello già aperto', async () => {
    const encoded = encodeFilterGroup({ rules: [{ id: 'r1', field: 'title', operator: 'contains', value: 'Disk', logic: 'AND' }] })
    renderPage('viewer', undefined, { route: `/events?${FILTER_GROUP_PARAM}=${encoded}` })
    expect(await screen.findByText('1 of 3 on this page matches the advanced filter')).toBeInTheDocument()
    expect(screen.getByText(/Advanced filter active/)).toBeInTheDocument()
    // il pannello parte aperto sulle regole dell'URL, non vuoto
    expect(screen.getByDisplayValue('Disk')).toBeInTheDocument()
  })

  it('?f= illeggibile: lo dice invece di mostrare in silenzio tutte le righe', async () => {
    renderPage('viewer', undefined, { route: `/events?${FILTER_GROUP_PARAM}=non-e-base64-valido!!` })
    expect(await screen.findByText('CPU high on web-01')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/advanced filter in this link cannot be read/i)
    // nessun filtro applicato: tutte e tre le righe, e il conteggio globale torna visibile
    expect(bodyRows()).toHaveLength(3)
    expect(screen.getByText('3 alarms')).toBeInTheDocument()
  })

  // C-15 / residuo D·2.8: l'ordinamento sta nell'URL e riguarda la sola pagina caricata.
  it('l\'ordinamento finisce in ?sort=/?dir= e l\'intestazione dice che vale per la pagina corrente', async () => {
    const { user } = renderPage('viewer')
    await screen.findByText('CPU high on web-01')
    const titleHeader = screen.getByRole('columnheader', { name: /^Alarm/ }).querySelector('button')!
    expect(titleHeader).toHaveAttribute('title', expect.stringContaining('current page'))

    await user.click(titleHeader)
    await waitFor(() => expect(location()).toContain('sort=title'))
    expect(location()).toContain('dir=asc')
    expect(within(bodyRows()[0]!).getByText('CPU high on web-01')).toBeInTheDocument()

    await user.click(titleHeader)
    await waitFor(() => expect(location()).toContain('dir=desc'))
    expect(within(bodyRows()[0]!).getByText('Old alert')).toBeInTheDocument()
  })

  it('?sort= all\'apertura ordina la pagina caricata', async () => {
    renderPage('viewer', undefined, { route: '/events?sort=title&dir=desc' })
    await screen.findByText('CPU high on web-01')
    expect(within(bodyRows()[0]!).getByText('Old alert')).toBeInTheDocument()
  })

  it('un ?sort= fuori dalle colonne ordinabili è ignorato: l\'ordine del server resta', async () => {
    renderPage('viewer', undefined, { route: '/events?sort=inventato&dir=desc' })
    await screen.findByText('CPU high on web-01')
    expect(within(bodyRows()[0]!).getByText('CPU high on web-01')).toBeInTheDocument()
  })

  it('errore della query delle sorgenti → messaggio accanto al filtro', async () => {
    const failing: GqlMock = { request: { query: GET_MONITORING_SOURCE_REFS }, error: new Error('sources down'), maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<EventsPage />, { route: '/events', mocks: [meMock('viewer'), statsMock(), eventsMock(), fieldsMock(), failing, policyMock(), serviceMapsMock()] })
    await screen.findByText('CPU high on web-01')
    expect(await screen.findByRole('alert')).toHaveTextContent('Sources not loaded: sources down')
  })

  it('il titolo della riga è un link al dettaglio (tastiera), la riga non è focalizzabile', async () => {
    renderPage('viewer')
    await screen.findByText('CPU high on web-01')
    const rows = bodyRows()
    expect(rows[0]).not.toHaveAttribute('tabindex')
    expect(within(rows[0]!).getByRole('link', { name: 'CPU high on web-01' })).toHaveAttribute('href', '/events/e1')
    // colonna "Ricorrenze" e data completa nel title di "Ultimo visto"
    expect(screen.getByRole('columnheader', { name: 'Occurrences' })).toBeInTheDocument()
    expect(within(rows[0]!).getByText('just now')).toHaveAttribute('title', formatDateTime(EVENTS[0]!.lastSeenAt))
  })

  it('chip "In attesa": countdown visibile sotto il chip e descrizione accessibile; riga ambigua → badge "Ambiguous"', async () => {
    const rows = [
      eventFixture({ id: 'w1', title: 'Waiting one', correlation: 'delayed', correlationAt: new Date(Date.now() - 30_000).toISOString() }),
      eventFixture({ id: 'a1', title: 'Ambiguous one', ci: null, correlation: 'skipped_orphan', matchReason: 'ambiguous' }),
    ]
    renderPage('viewer', undefined, { events: rows })
    await screen.findByText('Waiting one')
    const chip = screen.getByText('Waiting')
    await waitFor(() => expect(chip).toHaveAttribute('title', expect.stringMatching(/^Opens in (8\d|9\d) s$/)))
    expect(chip).toHaveAccessibleDescription(expect.stringMatching(/^Opens in (8\d|9\d) s$/))
    expect(screen.getByText(/^in (8\d|9\d) s$/)).toBeInTheDocument()
    expect(screen.getByText('Ambiguous')).toBeInTheDocument()
  })

  it('i filtri rapidi sono gruppi con nome: etichetta sopra i chip, i chip sciolti hanno il loro gruppo', async () => {
    renderPage('viewer')
    await screen.findByRole('heading', { level: 1 })
    const groups = screen.getAllByRole('group').filter((g) => g.tagName === 'FIELDSET')
    expect(groups.map((g) => g.querySelector('legend')!.textContent)).toEqual(['Status', 'Severity', 'Other'])
    // ogni chip sta dentro il suo gruppo, non sciolto nella riga
    const inGroup = (name: string) => groups.find((g) => within(g).queryByRole('button', { name }) !== null)
    expect(inGroup('Firing')!.querySelector('legend')!.textContent).toBe('Status')
    expect(inGroup('Critical')!.querySelector('legend')!.textContent).toBe('Severity')
    expect(inGroup('No CI only')!.querySelector('legend')!.textContent).toBe('Other')
  })
})
