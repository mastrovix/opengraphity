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
  __typename: 'Event', id: 'e1', fingerprint: 'fp-abc', externalId: 'ext-1', resourceExternalId: null, status: 'firing', severity: 'critical', maxSeverity: 'critical',
  title: 'CPU high on web-01', description: 'CPU > 95% for 10m', resource: 'web-01', resourceKind: 'hostname', matchReason: 'name',
  labels: JSON.stringify({ job: 'node', instance: 'web-01:9100', nested: { a: 1 } }),
  count: 5, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: '2026-09-09T08:30:00Z', resolvedAt: null,
  acknowledgedAt: '2026-09-09T08:10:00Z', acknowledgedBy: { __typename: 'User', id: 'u2', name: 'Anna Bianchi' },
  source: { __typename: 'MonitoringSourceRef', id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: CI,
  incident: INCIDENT,
  suppressedBy: null, correlation: 'opened', correlationAt: '2026-09-09T08:00:05Z',
  flappingSince: null, transitions24h: 0,
  // cronologia: la voce di correlazione (con l'incident) e il primo avvistamento, dalla più recente
  history: [
    { __typename: 'EventHistoryEntry', id: 'h2', at: '2026-09-09T08:00:05Z', kind: 'correlated', outcome: 'opened', actorId: 'monitoring', actor: null,
      incident: { __typename: 'Incident', id: 'inc1', number: 'INC-0042', title: 'CPU saturation' }, change: null, ci: null, severity: null, note: null },
    { __typename: 'EventHistoryEntry', id: 'h1', at: '2026-09-09T08:00:00Z', kind: 'first_seen', outcome: null, actorId: 'monitoring', actor: null,
      incident: null, change: null, ci: null, severity: 'critical', note: null },
  ],
  historyCount: 2,
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
    __typename: 'EventPolicy', version: 1, updatedAt: null, openIncidentFrom: 'critical', groupBy: 'ci', openDelaySeconds: 120, autoResolve: true,
    suppressUpstreamHops: 1, flapThreshold: 5, flapWindowMinutes: 10, flapStableMinutes: 15,
    stormThresholdPerMinute: 50, stormCooldownMinutes: 5, retentionDays: 30, severityMap: '{}',
    ignoreLifecycleStatuses: ['decommissioned'],
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
    // tipo di risorsa con l'etichetta del mappatore, non il valore grezzo
    expect(screen.getByText('Hostname · web-01')).toBeInTheDocument()
    expect(screen.getByText('web-01 (Hostname)')).toBeInTheDocument()

    // etichette: JSON → righe chiave/valore (i valori non stringa vengono serializzati)
    const labelRow = screen.getByText('instance').closest('tr')!
    expect(within(labelRow).getByText('web-01:9100')).toBeInTheDocument()
    expect(within(screen.getByText('nested').closest('tr')!).getByText('{"a":1}')).toBeInTheDocument()

    // contesto: tipo e stato del CI con le etichette dell'app, salute dal monitoraggio, strumento come badge
    expect(screen.getByRole('link', { name: 'web-01' })).toHaveAttribute('href', '/ci/server/ci1')
    expect(screen.getByText('Server')).toBeInTheDocument()            // tipo (sidebar.server)
    expect(screen.getByText('Active')).toBeInTheDocument()            // ciclo di vita (enumLabel)
    expect(screen.getByText('Health: Degraded')).toBeInTheDocument()  // salute dal monitoraggio
    expect(screen.getAllByText('Prometheus').length).toBeGreaterThan(0)   // anche come origine di un alias
    expect(screen.getByText('Prometheus Alertmanager')).toBeInTheDocument()   // ToolBadge, non "(alertmanager)"
    // riconoscimento del CI
    expect(screen.getByText('CI name')).toBeInTheDocument()
    // l'incident è linkato una volta sola (Contesto); la frase di correlazione lo cita
    expect(screen.getAllByRole('link', { name: 'INC-0042 · CPU saturation' })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'INC-0042 · CPU saturation' })).toHaveAttribute('href', '/incidents/inc1')
    // cronologia: conteggio nel titolo, voci dalla più recente, link all'incident nella voce di correlazione
    expect(screen.getByRole('button', { name: /History/ })).toHaveTextContent('2')
    const history = screen.getAllByTestId('history-entry')
    expect(history).toHaveLength(2)
    expect(history[0]).toHaveTextContent('Correlation: incident opened — incident INC-0042.')
    expect(within(history[0]!).getByRole('link', { name: 'INC-0042' })).toHaveAttribute('href', '/incidents/inc1')
    expect(history[1]).toHaveTextContent('First seen by monitoring with severity Critical.')
    // severità massima = attuale: il campo non compare; ID esterno della risorsa assente: idem
    expect(screen.queryByText('Peak severity of the cycle')).not.toBeInTheDocument()
    expect(screen.queryByText('Resource external ID')).not.toBeInTheDocument()

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
    expect(await screen.findByText('Alarm not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to alarms' })).toBeInTheDocument()
  })

  it('etichette non JSON → errore in chiaro (tradotto), mai una tabella vuota silenziosa', async () => {
    renderPage('viewer', { labels: '[1,2]' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByRole('alert')).toHaveTextContent('Labels unreadable: Labels: a JSON object was expected')
  })
})

describe('EventDetailPage — campi del riconoscimento (ondata 5)', () => {
  it('ambiguo senza CI: badge "Ambiguous", motivo e aiuto "collega a mano o aggiungi un alias"', async () => {
    renderPage('operator', { ci: null, matchReason: 'ambiguous', incident: null, correlation: 'skipped_orphan' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Ambiguous')).toBeInTheDocument()
    expect(screen.getByText('Ambiguous: several CIs share this name')).toBeInTheDocument()
    expect(screen.getByText(/link the CI manually or add an alias/)).toBeInTheDocument()
  })

  it('collegato a mano, severità massima diversa dall\'attuale e ID esterno della risorsa', async () => {
    renderPage('operator', { matchReason: 'manual', severity: 'warning', maxSeverity: 'critical', resourceExternalId: 'HOST-9F2A' })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Linked manually')).toBeInTheDocument()
    expect(screen.getByText('Peak severity of the cycle')).toBeInTheDocument()
    expect(screen.getByText('Resource external ID')).toBeInTheDocument()
    expect(screen.getByText('HOST-9F2A')).toBeInTheDocument()
  })

  it('matchReason null (evento precedente al campo) → "Not recorded"', async () => {
    renderPage('operator', { matchReason: null })
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getByText('Not recorded')).toBeInTheDocument()
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

describe('EventDetailPage — ciclo di vita ignorato (revisione 2, D6.3)', () => {
  const RETIRED = { ...CI, id: 'ci9', name: 'old-vm', status: 'decommissioned', health: null }

  it('skipped_lifecycle: la frase dice il CI, lo stato e come far ripartire la valutazione', async () => {
    renderPage('operator', { correlation: 'skipped_lifecycle', incident: null, ci: RETIRED })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('CI old-vm is in status “Decommissioned”, one of those the policy ignores: no incident opened and CI health unchanged.')
    expect(sentence()).toHaveTextContent('remove the status from “Lifecycle statuses to ignore” in the event policy')
  })

  it('skipped_lifecycle senza stato sul CI (o senza CI): lo si dice, non si inventa un valore', async () => {
    const { unmount } = renderPage('operator', { correlation: 'skipped_lifecycle', incident: null, ci: { ...RETIRED, status: null } })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('CI old-vm is in a lifecycle status the policy ignores, but the status is not recorded on the CI')
    unmount()

    renderPage('operator', { correlation: 'skipped_lifecycle', incident: null, ci: null, acknowledgedAt: null, acknowledgedBy: null })
    await screen.findByRole('heading', { level: 1 })
    expect(sentence()).toHaveTextContent('The alarm\'s CI is in a lifecycle status the policy ignores: no incident opened and no health change.')
  })
})
