/**
 * IntegrationsPage — webhook in ingresso (D·1.4): endpoint reale
 * (`/api/webhooks/inbound/:id`, assoluto) copiabile per incident/change/…;
 * per le sorgenti evento solo il link "Gestisci in Monitoraggio"; etichette
 * in i18n (D·6.4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { IntegrationsPage, GET_INBOUND_WEBHOOKS, GET_OUTBOUND_WEBHOOKS, GET_API_KEYS } from './IntegrationsPage'
import { renderWithProviders, type GqlMock } from '@/test/utils'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const INBOUND = [
  { __typename: 'InboundWebhook', id: 'wh1', name: 'Jira incidents', entityType: 'incident', connectorKind: null, fieldMapping: '{}', defaultValues: '{}', transformScript: null, enabled: true, lastReceivedAt: '2026-09-09T10:00:00Z', receiveCount: 7, createdAt: '2026-09-01T00:00:00Z' },
  { __typename: 'InboundWebhook', id: 'wh2', name: 'Prometheus prod', entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: '{}', transformScript: null, enabled: true, lastReceivedAt: null, receiveCount: 0, createdAt: '2026-09-02T00:00:00Z' },
]

const mocks: GqlMock[] = [
  { request: { query: GET_INBOUND_WEBHOOKS, variables: () => true }, result: { data: { inboundWebhooks: INBOUND } }, maxUsageCount: Number.POSITIVE_INFINITY },
  { request: { query: GET_OUTBOUND_WEBHOOKS, variables: () => true }, result: { data: { outboundWebhooks: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
  { request: { query: GET_API_KEYS, variables: () => true }, result: { data: { apiKeys: [] } }, maxUsageCount: Number.POSITIVE_INFINITY },
]

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('IntegrationsPage — webhook in ingresso', () => {
  it('mostra l\'endpoint reale e assoluto per un webhook incident e lo copia; per la sorgente evento solo il link a Monitoraggio', async () => {
    const { user } = renderWithProviders(<IntegrationsPage />, { route: '/admin/integrations', mocks })
    expect(await screen.findByText('Jira incidents')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Integrations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New inbound webhook' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Entity type/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Endpoint URL/ })).toBeInTheDocument()

    const [incident, event] = bodyRows()
    const url = `${window.location.origin}/api/webhooks/inbound/wh1`
    expect(within(incident!).getByText(url)).toBeInTheDocument()
    expect(incident).not.toHaveTextContent('/webhooks/in/')
    await user.click(within(incident!).getByRole('button', { name: 'Copy endpoint' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Copied!'))
    expect(await navigator.clipboard.readText()).toBe(url)
    expect(within(incident!).getByRole('button', { name: 'Regenerate token' })).toBeInTheDocument()

    // sorgente evento: niente URL copiabile né azioni, solo il rimando alle Sorgenti
    expect(within(event!).getByRole('link', { name: /Manage in Monitoring/ })).toHaveAttribute('href', '/monitoring/sources/wh2')
    expect(within(event!).queryByRole('button', { name: 'Copy endpoint' })).not.toBeInTheDocument()
    expect(within(event!).queryByRole('button', { name: 'Regenerate token' })).not.toBeInTheDocument()
    expect(event).not.toHaveTextContent('/api/webhooks/')
    // nota che rimanda alla procedura guidata
    expect(screen.getByRole('link', { name: 'Monitoring → Sources' })).toHaveAttribute('href', '/monitoring/sources')
  })

  it('le altre schede hanno etichette e stati vuoti in i18n', async () => {
    const { user } = renderWithProviders(<IntegrationsPage />, { route: '/admin/integrations', mocks })
    await screen.findByText('Jira incidents')
    await user.click(screen.getByRole('tab', { name: 'Webhook Out' }))
    expect(await screen.findByText('No outbound webhook configured')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New outbound webhook' })).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'API Keys' }))
    expect(await screen.findByText('No API key configured')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New API key' })).toBeInTheDocument()
  })
})
