import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { EventDetailPage } from './EventDetailPage'
import { GET_EVENT, GET_CI_ALIASES } from '@/graphql/queries'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import { meMock } from '@/test/mocks/gql'

const CI = { __typename: 'ConfigurationItemRef', id: 'ci1', name: 'web-01', type: 'server', status: 'active', health: 'degraded' }

const EVENT = {
  __typename: 'Event', id: 'e1', fingerprint: 'fp-abc', externalId: 'ext-1', status: 'firing', severity: 'critical',
  title: 'CPU high on web-01', description: 'CPU > 95% for 10m', resource: 'web-01', resourceKind: 'host',
  labels: JSON.stringify({ job: 'node', instance: 'web-01:9100', nested: { a: 1 } }),
  count: 5, firstSeenAt: '2026-09-09T08:00:00Z', lastSeenAt: '2026-09-09T08:30:00Z', resolvedAt: null,
  acknowledgedAt: '2026-09-09T08:10:00Z', acknowledgedBy: { __typename: 'User', id: 'u2', name: 'Anna Bianchi' },
  source: { __typename: 'InboundWebhook', id: 'wh1', name: 'Prometheus', connectorKind: 'alertmanager' },
  ci: CI,
  incident: { __typename: 'Incident', id: 'inc1', number: 'INC-0042', title: 'CPU saturation', status: 'in_progress' },
}

const eventMock = (): GqlMock => ({
  request: { query: GET_EVENT, variables: { id: 'e1' } },
  result: { data: { event: EVENT } },
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

function renderPage(role: string) {
  return renderWithProviders(<EventDetailPage />, { route: '/events/e1', path: '/events/:id', mocks: [meMock(role), eventMock(), aliasesMock()] })
}

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
    expect(screen.getByRole('link', { name: 'INC-0042 · CPU saturation' })).toHaveAttribute('href', '/incidents/inc1')

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
  })

  it('evento inesistente → stato "non trovato" con ritorno alla lista', async () => {
    const missing: GqlMock = { request: { query: GET_EVENT, variables: { id: 'e1' } }, result: { data: { event: null } } }
    renderWithProviders(<EventDetailPage />, { route: '/events/e1', path: '/events/:id', mocks: [meMock('admin'), missing] })
    expect(await screen.findByText('Event not found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to events' })).toBeInTheDocument()
  })
})
