/**
 * EditSourcePage — limite di richieste al minuto per sorgente (M7): letto da
 * GET_MONITORING_SOURCE_SETTINGS, modificabile e inviato in
 * updateInboundWebhook; fuori da 1..10000 il salvataggio è bloccato con il
 * motivo in chiaro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { EditSourcePage } from './EditSourcePage'
import { GET_MONITORING_SOURCE_SETTINGS } from '@/graphql/queries'
import { UPDATE_MONITORING_SOURCE } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import type { MonitoringSource } from '@/types/events'
import type { SourceRateLimit } from './sourceConfig'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

const SOURCE: MonitoringSource & SourceRateLimit = {
  id: 's1', name: 'Prometheus prod', entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
  enabled: true, rateLimitPerMinute: 100, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0, createdAt: '2026-09-01T00:00:00Z',
}

const settingsMock: GqlMock = {
  request: { query: GET_MONITORING_SOURCE_SETTINGS },
  result: { data: { monitoringSources: [{ __typename: 'InboundWebhook', ...SOURCE }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
}

type UpdateInput = Record<string, unknown>
/** Il risultato della mutation (MonitoringSourceResult) non contiene rateLimitPerMinute. */
const { rateLimitPerMinute: _omitted, ...UPDATE_RESULT } = SOURCE
function updateMock(updates: UpdateInput[]): GqlMock {
  return {
    request: { query: UPDATE_MONITORING_SOURCE, variables: (v) => { updates.push((v as { input: UpdateInput }).input); return true } },
    result: { data: { updateInboundWebhook: { __typename: 'InboundWebhook', ...UPDATE_RESULT } } },
  }
}

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('EditSourcePage — richieste al minuto', () => {
  it('mostra il limite corrente e lo invia con il salvataggio insieme a nome e stato', async () => {
    const updates: UpdateInput[] = []
    const { user } = renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id', mocks: [settingsMock, updateMock(updates)] })
    const field = await screen.findByLabelText('Requests per minute accepted')
    expect(field).toHaveValue(100)
    expect(screen.getByText(/Above this number the source gets 429 with Retry-After/)).toBeInTheDocument()

    await user.clear(field)
    await user.type(field, '250')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // preset senza regole: i JSON delle regole viaggiano vuoti (fieldMapping sempre '{}')
    await waitFor(() => expect(updates).toEqual([{ name: 'Prometheus prod', enabled: true, rateLimitPerMinute: 250, fieldMapping: '{}', defaultValues: '{}', valueMapping: '{}' }]))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source updated'))
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources')
  })

  it('A1 — regole di un preset già salvate (value_mapping, default_values.resource) vengono rilette, modificate e rinviate', async () => {
    const saved = { ...SOURCE, valueMapping: JSON.stringify({ severity: { page: 'critical' }, status: { silenced: 'resolved' } }), defaultValues: JSON.stringify({ resource: 'prometheus-prod', resourceKind: 'name' }) }
    const mock: GqlMock = { request: { query: GET_MONITORING_SOURCE_SETTINGS }, result: { data: { monitoringSources: [{ __typename: 'InboundWebhook', ...saved }] } }, maxUsageCount: Number.POSITIVE_INFINITY }
    const updates: UpdateInput[] = []
    const { user } = renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id', mocks: [mock, updateMock(updates)] })
    expect(await screen.findByLabelText('"page" becomes')).toHaveValue('critical')
    expect(screen.getByLabelText('"silenced" becomes')).toHaveValue('resolved')
    expect(screen.getByLabelText('Resource to use when missing')).toHaveValue('prometheus-prod')
    expect(screen.getByLabelText('The resource is a…')).toHaveValue('name')
    await user.selectOptions(screen.getByLabelText('"page" becomes'), 'warning')
    await user.click(screen.getByRole('button', { name: 'Remove value silenced' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updates).toEqual([{
      name: 'Prometheus prod', enabled: true, rateLimitPerMinute: 100,
      fieldMapping: '{}', defaultValues: JSON.stringify({ resource: 'prometheus-prod', resourceKind: 'name' }), valueMapping: JSON.stringify({ severity: { page: 'warning' } }),
    }]))
  })

  it('A1 — configurazione salvata che l\'editor non sa rappresentare (default_values.severity via API) → errore in chiaro e Salva disabilitato: nessuna regola persa in silenzio', async () => {
    const saved = { ...SOURCE, defaultValues: JSON.stringify({ severity: 'warning' }) }
    const mock: GqlMock = { request: { query: GET_MONITORING_SOURCE_SETTINGS }, result: { data: { monitoringSources: [{ __typename: 'InboundWebhook', ...saved }] } }, maxUsageCount: Number.POSITIVE_INFINITY }
    renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id', mocks: [mock] })
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be edited from this page.*defaultValues\.severity/)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it.each(['0', '10001', ''])('valore "%s" fuori da 1..10000 → Salva disabilitato e motivo in chiaro, nessuna mutation', async (bad) => {
    const updates: UpdateInput[] = []
    const { user } = renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id', mocks: [settingsMock, updateMock(updates)] })
    const field = await screen.findByLabelText('Requests per minute accepted')
    await user.clear(field)
    if (bad) await user.type(field, bad)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a whole number between 1 and 10000.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(updates).toEqual([])
  })
})
