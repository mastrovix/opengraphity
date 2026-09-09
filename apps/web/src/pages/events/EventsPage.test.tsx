import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { EventsPage } from './EventsPage'
import { GET_EVENTS, GET_EVENT_STATS, GET_ENTITY_FILTER_FIELDS, GET_MONITORING_SOURCES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'
import type { MonitoringEvent, EventStats } from '@/types/events'

const STATS: EventStats = { firing: 4, critical: 2, warning: 1, orphan: 1, suppressed: 0, flapping: 1, resolved24h: 7 }

function eventFixture(over: Partial<MonitoringEvent> & { id: string }): MonitoringEvent {
  return {
    fingerprint: `fp-${over.id}`, externalId: null, status: 'firing', severity: 'critical',
    title: `Alert ${over.id}`, description: null, resource: 'web-01', resourceKind: 'host', labels: null,
    count: 3, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: new Date().toISOString(), resolvedAt: null,
    acknowledgedAt: null, acknowledgedBy: null,
    source: { id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
    ci: { id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: null },
    incident: null,
    ...over,
  }
}

/** Aggiunge `__typename` come farebbe la cache Apollo. */
function typed(ev: MonitoringEvent) {
  return {
    __typename: 'Event', ...ev,
    acknowledgedBy: ev.acknowledgedBy ? { __typename: 'User', ...ev.acknowledgedBy } : null,
    source:   ev.source   ? { __typename: 'InboundWebhook', ...ev.source } : null,
    ci:       ev.ci       ? { __typename: 'ConfigurationItemRef', ...ev.ci } : null,
    incident: ev.incident ? { __typename: 'Incident', ...ev.incident } : null,
  }
}

const EVENTS: MonitoringEvent[] = [
  eventFixture({ id: 'e1', title: 'CPU high on web-01' }),
  eventFixture({ id: 'e2', title: 'Disk full on unknown host', severity: 'warning', ci: null, resource: 'db-99', incident: { id: 'inc1', number: 'INC-0042', title: 'Disk', status: 'new' } }),
  eventFixture({ id: 'e3', title: 'Old alert', status: 'resolved', resolvedAt: '2026-09-09T09:00:00Z' }),
]

type Vars = { filter: Record<string, unknown> | null; limit: number; offset: number }

function eventsMock(items = EVENTS, seen?: Vars[]): GqlMock {
  return {
    request: { query: GET_EVENTS, variables: (v) => { seen?.push(v as Vars); return true } },
    result: { data: { events: { __typename: 'EventPage', total: items.length, items: items.map(typed) } } },
    maxUsageCount: Number.POSITIVE_INFINITY,
  }
}

const statsMock = (): GqlMock => ({
  request: { query: GET_EVENT_STATS },
  result: { data: { eventStats: { __typename: 'EventStats', ...STATS } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const fieldsMock = (): GqlMock => ({
  request: { query: GET_ENTITY_FILTER_FIELDS, variables: { typeName: 'Event' } },
  result: { data: { entityFilterFields: [{ __typename: 'EntityFilterField', name: 'title', kind: 'SCALAR', scalarName: 'String', enumValues: null }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const sourcesMock = (names: string[] = ['Prometheus', 'Zabbix']): GqlMock => ({
  request: { query: GET_MONITORING_SOURCES },
  result: { data: { monitoringSources: names.map((name, i) => ({
    __typename: 'InboundWebhook', id: `wh${i + 1}`, name, entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
    enabled: true, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0, createdAt: '2026-09-01T00:00:00Z',
  })) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, seen?: Vars[], opts: { route?: string; sources?: string[] } = {}) {
  return renderWithProviders(<EventsPage />, { route: opts.route ?? '/events', mocks: [meMock(role), statsMock(), eventsMock(EVENTS, seen), fieldsMock(), sourcesMock(opts.sources)] })
}

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

describe('EventsPage', () => {
  it('operator: contatori, righe con stato/CI/incident e azioni per riga', async () => {
    renderPage('operator')
    expect(await screen.findByText('CPU high on web-01')).toBeInTheDocument()
    expect(screen.getByText('3 events')).toBeInTheDocument()

    // contatori da eventStats
    expect(screen.getByRole('button', { name: /Active\s*4/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Resolved 24h\s*7/ })).toBeInTheDocument()

    const rows = bodyRows()
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(within(rows[1]!).getByText('orphan')).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: 'Orphans only' }))
    expect(tile).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(seen.at(-1)?.filter).toEqual({ status: ['firing'], severity: ['critical'], orphan: true }))
  })

  it('il click sulla riga apre il dettaglio', async () => {
    const { user } = renderPage('viewer')
    await user.click(await screen.findByText('CPU high on web-01'))
    expect(screen.getByTestId('location')).toHaveTextContent('/events/e1')
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
    expect(screen.getByRole('button', { name: /Orphans\s*1/ })).toHaveAttribute('aria-pressed', 'true')
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
