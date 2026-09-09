import { describe, it, expect } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { EventDetailPage } from './EventDetailPage'
import { GET_EVENT, GET_CI_ALIASES, GET_EVENT_POLICY } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'

const CI = { __typename: 'ConfigurationItemRef', id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: 'degraded' }
const INCIDENT = { __typename: 'Incident', id: 'inc1', number: 'INC-0042', title: 'CPU saturation', status: 'in_progress' }
const CHANGE = { __typename: 'Change', id: 'chg1', code: 'CHG-0007', title: 'Freeze DB' }

/** Fixture grezzo (come arriva dal mock): gli override dei singoli test possono annullare qualsiasi campo. */
const EVENT: Record<string, unknown> = {
  __typename: 'Event', id: 'e1', fingerprint: 'fp-abc', externalId: 'ext-1', status: 'firing', severity: 'critical',
  title: 'CPU high on web-01', description: 'CPU > 95% for 10m', resource: 'web-01', resourceKind: 'host',
  labels: JSON.stringify({ job: 'node', instance: 'web-01:9100', nested: { a: 1 } }),
  count: 5, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: '2026-09-09T08:30:00Z', resolvedAt: null,
  acknowledgedAt: '2026-09-09T08:10:00Z', acknowledgedBy: { __typename: 'User', id: 'u2', name: 'Anna Bianchi' },
  source: { __typename: 'InboundWebhook', id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: CI,
  incident: INCIDENT,
  suppressedBy: null, correlation: 'opened', correlationAt: '2026-09-09T08:00:05Z',
  flappingSince: null, transitions24h: 0,
}

const eventMock = (over: Record<string, unknown> = {}): GqlMock => ({
  request: { query: GET_EVENT, variables: { id: 'e1' } },
  result: { data: { event: { ...EVENT, ...over } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const aliasesMock = (): GqlMock => ({
  request: { query: GET_CI_ALIASES, variables: { ciId: 'ci1' } },
  result: { data: { ciAliases: [
    { __typename: 'CIAlias', id: 'al1', kind: 'hostname', value: 'web-01', source: 'Prometheus', createdAt: '2026-09-01T10:00:00Z', ci: CI },
    { __typename: 'CIAlias', id: 'al2', kind: 'ip', value: '10.0.0.7', source: 'manual', createdAt: '2026-09-02T10:00:00Z', ci: CI },
  ] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const policyMock = (): GqlMock => ({
  request: { query: GET_EVENT_POLICY },
  result: { data: { eventPolicy: {
    __typename: 'EventPolicy', openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
    suppressUpstreamHops: 1, flapThreshold: 5, flapWindowMinutes: 10, flapStableMinutes: 15,
    stormThresholdPerMinute: 50, stormCooldownMinutes: 5, retentionDays: 30, severityMap: '{}',
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

function renderPage(role: string, over: Record<string, unknown> = {}) {
  return renderWithProviders(<EventDetailPage />, { route: '/events/e1', path: '/events/:id', mocks: [meMock(role), eventMock(over), aliasesMock(), policyMock()] })
}

const sentence = () => screen.getByTestId('correlation-sentence')

describe('EventDetailPage', () => {
  it('admin: campi, etichette come tabella, contesto (CI, sorgente, incident) e alias con elimina', async () => {
    renderPage('admin')
    expect(await screen.findByRole('heading', { level: 1, name: 'CPU high on web-01' })).toBeInTheDocument()
    expect(screen.getByText('CPU > 95% for 10m')).toBeInTheDocument()
    expect(screen.getByText('fp-abc')).toBeInTheDocument()
    expect(screen.getByText(/Anna Bianchi ·/)).toBeInTheDocument()

    // etichette: JSON → righe chiave/valore (i valori non stringa vengono serializzati)
    const labelRow = screen.getByText('instance').closest('tr')!
    expect(within(labelRow).getByText('web-01:9100')).toBeInTheDocument()
    expect(within(screen.getByText('nested').closest('tr')!).getByText('{"a":1}')).toBeInTheDocument()

    // contesto
    expect(screen.getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(screen.getByText('active')).toBeInTheDocument()            // ciclo di vita
    expect(screen.getByText('Health: Degraded')).toBeInTheDocument()  // salute dal monitoraggio
    expect(screen.getByText('Prometheus (alertmanager)')).toBeInTheDocument()
    // l'incident è linkato sia nel contesto sia nella sezione Correlazione
    for (const link of screen.getAllByRole('link', { name: 'INC-0042 · CPU saturation' })) expect(link).toHaveAttribute('href', '/incidents/inc1')

    // alias del CI
    expect(await screen.findByText('10.0.0.7')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete alias web-01' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    // già preso in carico e con incident: restano solo "Resolve"
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open incident' })).not.toBeInTheDocument()
  })

  it('viewer: né azioni né gestione alias', async () => {
    renderPage('viewer')
    expect(await screen.findByText('10.0.0.7')).toBeInTheDocument()
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete alias web-01' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).not.toBeInTheDocument()
  })

  it('evento inesistente → stato "non trovato" con ritorno alla lista', async () => {
    const missing: GqlMock = { request: { query: GET_EVENT, variables: { id: 'e1' } }, result: { data: { event: null } } }
    renderWithProviders(<EventDetailPage />, { route: '/events/e1', path: '/events/:id', mocks: [meMock('admin'), missing] })
    expect(await screen.findByText('Event not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to events' })).toBeInTheDocument()
  })
})

describe('EventDetailPage — sezione Correlazione (ondata 3)', () => {
  it('opened: "incident aperto automaticamente il …", nessun "Rivaluta ora" (esito definitivo)', async () => {
    renderPage('operator')
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent(/^Incident INC-0042 opened automatically on .+\.$/)
    await new Promise((r) => setTimeout(r, 10))
    expect(screen.queryByRole('button', { name: 'Re-evaluate now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open incident' })).not.toBeInTheDocument()
  })

  it('attached: agganciato all\'incident esistente', async () => {
    renderPage('operator', { correlation: 'attached' })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent(/^Attached to the existing incident INC-0042 on .+\.$/)
  })

  it('suppressed: frase con la change, link alla change, "Rivaluta ora" sì e "Apri incident" no', async () => {
    renderPage('operator', { status: 'suppressed', correlation: 'suppressed', incident: null, suppressedBy: CHANGE })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('Suppressed by change CHG-0007 until the end of the release window')
    expect(screen.getByRole('link', { name: 'CHG-0007 · Freeze DB' })).toHaveAttribute('href', '/changes/chg1')
    expect(await screen.findByRole('button', { name: 'Re-evaluate now' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open incident' })).not.toBeInTheDocument()
  })

  it('skipped_orphan: invito a collegare un CI, con "Rivaluta ora" e "Apri incident"', async () => {
    renderPage('operator', { correlation: 'skipped_orphan', incident: null, ci: null, acknowledgedAt: null, acknowledgedBy: null })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('No CI recognised: link a CI to re-run the evaluation and open an incident.')
    expect(await screen.findByRole('button', { name: 'Re-evaluate now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open incident' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link to CI' })).toBeInTheDocument()
    // ogni azione compare una volta sola (testata vs sezione Correlazione)
    expect(screen.getAllByRole('button', { name: 'Open incident' })).toHaveLength(1)
  })

  it('delayed: la frase dice il ritardo di policy e il countdown', async () => {
    renderPage('operator', { correlation: 'delayed', incident: null, correlationAt: new Date(Date.now() - 30_000).toISOString() })
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(sentence()).toHaveTextContent(/after 120 seconds \(opens in (8\d|9\d) s/))
  })

  it('skipped_severity: soglia della policy in chiaro', async () => {
    renderPage('operator', { correlation: 'skipped_severity', incident: null, severity: 'warning' })
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(sentence()).toHaveTextContent('Severity Warning is below the policy threshold (opens from: Critical): no incident opened.'))
  })
})

describe('EventDetailPage — sfarfallio e tempeste (ondata 4)', () => {
  it('flapping: passaggi, da quando, minuti di stabilità dalla policy; campi "Instabile dal" e "Passaggi 24 h"', async () => {
    renderPage('operator', { status: 'flapping', correlation: 'flapping', incident: null, flappingSince: '2026-09-09T07:30:00Z', transitions24h: 12 })
    await screen.findByRole('heading', { level: 1 })
    await waitFor(() => expect(sentence()).toHaveTextContent(/^Flapping alarm: 12 transitions in the last 24 hours, since .+; no incident opened or closed, correlation resumes after 15 minutes of stability\.$/))
    expect(screen.getByText('Flapping since')).toBeInTheDocument()
    expect(screen.getByText('Transitions in the last 24 h')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('transitions24h = 0: il campo "Passaggi 24 h" non compare', async () => {
    renderPage('operator')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText('Transitions in the last 24 h')).not.toBeInTheDocument()
    expect(screen.queryByText('Flapping since')).not.toBeInTheDocument()
  })

  it('storm: sorgente e incident di tempesta nella frase, incident linkato', async () => {
    renderPage('operator', { correlation: 'storm', incident: { __typename: 'Incident', id: 'inc9', number: 'INC-0099', title: 'Storm from Prometheus', status: 'new' } })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent(/^Storm from source Prometheus: grouped into the storm incident INC-0099 on .+ instead of opening an incident for this CI\.$/)
    expect(screen.getAllByRole('link', { name: 'INC-0099 · Storm from Prometheus' })[0]).toHaveAttribute('href', '/incidents/inc9')
  })

  it('storm_no_ci: tempesta senza CI riconosciuto', async () => {
    renderPage('operator', { correlation: 'storm_no_ci', incident: null, ci: null })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('Storm from source Prometheus and no CI recognised: no incident opened; link a CI after the storm if needed.')
  })
})
