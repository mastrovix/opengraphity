/**
 * EditSourcePage — limite di richieste al minuto per sorgente (M7), regole
 * dei preset (A1) e round-trip completo della configurazione generic (D·1.2):
 * severità/stato predefiniti riletti e riscritti, chiavi che l'editor non
 * rappresenta elencate prima del salvataggio che le perderebbe.
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

const settingsMock = (src: MonitoringSource & SourceRateLimit = SOURCE): GqlMock => ({
  request: { query: GET_MONITORING_SOURCE_SETTINGS },
  result: { data: { monitoringSources: [{ __typename: 'InboundWebhook', ...src }] } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

type UpdateInput = Record<string, unknown>
/** Il risultato della mutation (MonitoringSourceResult) non contiene rateLimitPerMinute. */
function updateMock(updates: UpdateInput[], src: MonitoringSource & SourceRateLimit = SOURCE): GqlMock {
  const { rateLimitPerMinute: _omitted, ...result } = src
  return {
    request: { query: UPDATE_MONITORING_SOURCE, variables: (v) => { updates.push((v as { input: UpdateInput }).input); return true } },
    result: { data: { updateInboundWebhook: { __typename: 'InboundWebhook', ...result } } },
  }
}

const render = (src: MonitoringSource & SourceRateLimit, updates: UpdateInput[] = []) =>
  renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id', mocks: [settingsMock(src), updateMock(updates, src)] })

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('EditSourcePage — richieste al minuto', () => {
  it('mostra il limite corrente e lo invia con il salvataggio insieme a nome e stato', async () => {
    const updates: UpdateInput[] = []
    const { user } = render(SOURCE, updates)
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

  it.each(['0', '10001', ''])('valore "%s" fuori da 1..10000 → Salva disabilitato e motivo in chiaro, nessuna mutation', async (bad) => {
    const updates: UpdateInput[] = []
    const { user } = render(SOURCE, updates)
    const field = await screen.findByLabelText('Requests per minute accepted')
    await user.clear(field)
    if (bad) await user.type(field, bad)
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a whole number between 1 and 10000.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(updates).toEqual([])
  })
})

describe('EditSourcePage — regole dei preset (A1)', () => {
  it('regole già salvate (value_mapping, default_values.resource e .severity) vengono rilette, modificate e rinviate', async () => {
    const saved = { ...SOURCE, valueMapping: JSON.stringify({ severity: { page: 'critical' }, status: { silenced: 'resolved' } }), defaultValues: JSON.stringify({ severity: 'warning', resource: 'prometheus-prod', resourceKind: 'name' }) }
    const updates: UpdateInput[] = []
    const { user } = render(saved, updates)
    expect(await screen.findByLabelText('"page" becomes')).toHaveValue('critical')
    expect(screen.getByLabelText('"silenced" becomes')).toHaveValue('resolved')
    expect(screen.getByLabelText('Severity to use when missing')).toHaveValue('warning')
    expect(screen.getByLabelText('Resource to use when missing')).toHaveValue('prometheus-prod')
    expect(screen.getByLabelText('The resource is a…')).toHaveValue('name')
    await user.selectOptions(screen.getByLabelText('"page" becomes'), 'warning')
    await user.click(screen.getByRole('button', { name: 'Remove value silenced' }))
    await user.clear(screen.getByLabelText('Severity to use when missing'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updates).toEqual([{
      name: 'Prometheus prod', enabled: true, rateLimitPerMinute: 100,
      fieldMapping: '{}', defaultValues: JSON.stringify({ resource: 'prometheus-prod', resourceKind: 'name' }), valueMapping: JSON.stringify({ severity: { page: 'warning' } }),
    }]))
  })

  it('configurazione salvata che l\'editor non sa rappresentare (default_values.title via API) → errore in chiaro e Salva disabilitato: nessuna regola persa in silenzio', async () => {
    render({ ...SOURCE, defaultValues: JSON.stringify({ title: 'fallback' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('The saved configuration cannot be edited from this page (saving disabled so it is not lost): defaultValues.title: cannot be edited from this page')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('EditSourcePage — round-trip del connettore generic (D·1.2)', () => {
  const GENERIC: MonitoringSource & SourceRateLimit = {
    ...SOURCE, id: 's1', name: 'Custom tool', connectorKind: 'generic',
    fieldMapping: JSON.stringify({ title: 'alert.name', severity: 'alert.level', resource: 'host.name', labels: 'tags' }),
    defaultValues: JSON.stringify({ resourceKind: 'ip', severity: 'warning', status: 'resolved', title: 'fallback' }),
    valueMapping: JSON.stringify({ severity: { major: 'critical' }, foo: { a: 'b' } }),
  }

  it('severità/stato predefiniti e resourceKind vengono riletti; le chiavi non rappresentabili sono elencate con il prefisso; il salvataggio riscrive i predefiniti', async () => {
    const updates: UpdateInput[] = []
    const { user } = render(GENERIC, updates)
    expect(await screen.findByLabelText('Title *')).toHaveValue('alert.name')
    expect(screen.getByLabelText('Severity *')).toHaveValue('alert.level')
    expect(screen.getByLabelText('Resource (host, IP, …) *')).toHaveValue('host.name')
    expect(screen.getByLabelText('The resource is a…')).toHaveValue('ip')
    expect(screen.getByLabelText('Default severity')).toHaveValue('warning')
    expect(screen.getByLabelText('Default status')).toHaveValue('resolved')
    expect(screen.getByLabelText('"major" becomes')).toHaveValue('critical')
    expect(screen.getByText('Rules saved outside this editor will be dropped on save: fieldMapping.labels, defaultValues.title, valueMapping.foo')).toBeInTheDocument()
    // senza esempio incollato i percorsi restano modificabili a mano (D·2.2)
    expect(screen.getByLabelText('Title *')).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('Default status'), '')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({ name: 'Custom tool', enabled: true, rateLimitPerMinute: 100 })
    expect(JSON.parse(updates[0]!['fieldMapping'] as string)).toEqual({ title: 'alert.name', severity: 'alert.level', resource: 'host.name' })
    expect(JSON.parse(updates[0]!['defaultValues'] as string)).toEqual({ resourceKind: 'ip', severity: 'warning' })
    expect(JSON.parse(updates[0]!['valueMapping'] as string)).toEqual({ severity: { major: 'critical' } })
  })

  it('default_values.severity fuori vocabolario → errore in chiaro (il mappatore non lo rappresenta)', async () => {
    render({ ...GENERIC, defaultValues: JSON.stringify({ resourceKind: 'hostname', severity: 'major' }) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot read the fields: defaultValues.severity: expected one of critical, warning, info')
  })
})
