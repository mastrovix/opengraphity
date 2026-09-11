import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { MonitoringSourcesPage } from './MonitoringSourcesPage'
import { GET_MONITORING_SOURCES, GET_EVENT_STATS } from '@/graphql/queries'
import { UPDATE_MONITORING_SOURCE, DELETE_MONITORING_SOURCE, REGENERATE_SOURCE_TOKEN, SEND_SAMPLE_EVENT } from '@/graphql/mutations'
import { renderWithProviders, type GqlMock } from '@/test/utils'
import type { MonitoringSource, StormSource } from '@/types/events'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

function source(over: Partial<MonitoringSource> & { id: string; name: string }): MonitoringSource {
  return {
    entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
    enabled: true, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0,
    createdAt: '2026-09-01T00:00:00Z', ...over,
  }
}

const SOURCES: MonitoringSource[] = [
  source({ id: 's1', name: 'Prometheus prod', receiveCount: 42, lastReceivedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
  source({ id: 's2', name: 'Zabbix DC', connectorKind: 'zabbix', enabled: false, errorCount: 3, lastError: 'event_value must be "1" (problem) or "0" (recovery). Got: null', lastErrorAt: '2026-09-09T10:00:00Z' }),
]

const typed = (s: MonitoringSource) => ({ __typename: 'InboundWebhook', ...s })

/** `onCall` conta le richieste dell'elenco (refetch dopo l'evento di prova, "Aggiorna"). */
const sourcesMock = (items = SOURCES, onCall?: () => void): GqlMock => ({
  request: { query: GET_MONITORING_SOURCES, variables: () => { onCall?.(); return true } },
  result: { data: { monitoringSources: items.map(typed) } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

/** `eventStats`: la pagina la legge solo per il badge "Tempesta". */
const statsMock = (stormSources: StormSource[] = []): GqlMock => ({
  request: { query: GET_EVENT_STATS },
  result: { data: { eventStats: {
    __typename: 'EventStats', firing: 0, critical: 0, warning: 0, orphan: 0, suppressed: 0, flapping: 0, resolved24h: 0,
    stormSources: stormSources.map((s) => ({ __typename: 'StormSource', ...s })),
  } } },
  maxUsageCount: Number.POSITIVE_INFINITY,
})

const bodyRows = () => within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')

beforeEach(() => { vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear() })

describe('MonitoringSourcesPage', () => {
  it('elenca le sorgenti con strumento, stato, contatori e ultimo errore in chiaro', async () => {
    renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock()] })
    expect(await screen.findByRole('link', { name: 'Prometheus prod' })).toHaveAttribute('href', '/monitoring/sources/s1')
    expect(screen.getByText('2 sources', { exact: false })).toBeInTheDocument()

    const rows = bodyRows()
    expect(within(rows[0]!).getByText('Prometheus Alertmanager')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('42')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('None')).toBeInTheDocument()
    expect(within(rows[0]!).getByRole('switch', { name: 'Enable or disable Prometheus prod' })).toHaveAttribute('aria-checked', 'true')

    expect(within(rows[1]!).getByText('Zabbix')).toBeInTheDocument()
    // stato (non imperativo, D·6.2) e nota sotto il nome
    expect(within(rows[1]!).getByText('Inactive')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Disabled: alarms sent to this endpoint are rejected.')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('Never')).toBeInTheDocument()
    expect(within(rows[1]!).getByText('3 errors')).toBeInTheDocument()
    expect(within(rows[1]!).getByText(/Last reason: event_value must be/)).toBeInTheDocument()
  })

  it('D·1.11 — "Aggiorna" rilegge l\'elenco', async () => {
    let calls = 0
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(SOURCES, () => { calls++ }), statsMock()] })
    await screen.findByRole('link', { name: 'Prometheus prod' })
    expect(calls).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(calls).toBe(2))
  })

  it('badge "Tempesta" sulla sorgente in tempesta (da eventStats.stormSources), con tooltip E descrizione accessibile (D·3.1)', async () => {
    const storms: StormSource[] = [{ sourceId: 's2', sourceName: 'Zabbix DC', ratePerMinute: 64, since: '2026-09-09T08:00:00Z', incidentId: 'inc9', incidentNumber: 'INC-0099' }]
    renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock(storms)] })
    await screen.findByRole('link', { name: 'Prometheus prod' })
    const badge = await screen.findByText('Storm')
    const rows = bodyRows()
    expect(within(rows[1]!).getByText('Storm')).toBe(badge)
    expect(badge).toHaveAttribute('title', expect.stringMatching(/^In a storm: 64 alarms per minute since \d{2}:\d{2}, grouped into INC-0099$/))
    // D·3.1: il motivo non è più solo nel `title` (che per chi non usa il mouse non esiste).
    expect(badge).toHaveAccessibleDescription(/^In a storm: 64 alarms per minute since \d{2}:\d{2}, grouped into INC-0099$/)
    expect(within(rows[0]!).queryByText('Storm')).not.toBeInTheDocument()
  })

  it('stato vuoto: invito e pulsante che porta alla procedura guidata', async () => {
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock([]), statsMock()] })
    expect(await screen.findByText('No monitoring source yet')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Add source' })
    await user.click(buttons[buttons.length - 1]!)
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources/new')
  })

  it('il toggle disattiva la sorgente con updateInboundWebhook({ enabled: false })', async () => {
    const seen: unknown[] = []
    const updateMock: GqlMock = {
      request: { query: UPDATE_MONITORING_SOURCE, variables: (v) => { seen.push(v); return true } },
      result: { data: { updateInboundWebhook: typed({ ...SOURCES[0]!, enabled: false }) } },
    }
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock(), updateMock] })
    await user.click(await screen.findByRole('switch', { name: 'Enable or disable Prometheus prod' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source updated'))
    expect(seen).toEqual([{ id: 's1', input: { enabled: false } }])
  })

  it('"Invia evento di prova" accoda il campione, avvisa con il link alla console e rilegge l\'elenco dopo l\'attesa (D·1.11)', async () => {
    const sampleMock: GqlMock = {
      request: { query: SEND_SAMPLE_EVENT, variables: { sourceId: 's1' } },
      result: { data: { sendSampleEvent: 1 } },
    }
    let calls = 0
    const { user } = renderWithProviders(<MonitoringSourcesPage sampleRefetchDelayMs={0} />, { route: '/monitoring/sources', mocks: [sourcesMock(SOURCES, () => { calls++ }), statsMock(), sampleMock] })
    await user.click(await screen.findByRole('button', { name: 'Send a test event from Prometheus prod' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test event queued: open it in Events', expect.objectContaining({ action: expect.objectContaining({ label: 'Open in Events' }) })))
    await waitFor(() => expect(calls).toBe(2))
  })

  it('rigenera il token dopo conferma e lo mostra una sola volta', async () => {
    const regenMock: GqlMock = {
      request: { query: REGENERATE_SOURCE_TOKEN, variables: { id: 's1' } },
      result: { data: { regenerateWebhookToken: { __typename: 'InboundWebhookWithToken', id: 's1', token: 'tok-NEW-123' } } },
    }
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock(), regenMock] })
    await user.click(await screen.findByRole('button', { name: 'Regenerate token of Prometheus prod' }))
    // conferma (ConfirmModal)
    await user.click(await screen.findByRole('button', { name: 'Regenerate token' }))
    expect(await screen.findByText('tok-NEW-123')).toBeInTheDocument()
    expect(screen.getByText('Copy it now: for security it will not be shown again.')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Token regenerated')
  })

  it('rigenerazione senza token nella risposta → errore in chiaro (i18n), nessun modale', async () => {
    const regenMock: GqlMock = {
      request: { query: REGENERATE_SOURCE_TOKEN, variables: { id: 's1' } },
      result: { data: { regenerateWebhookToken: { __typename: 'InboundWebhookWithToken', id: 's1', token: '' } } },
    }
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock(), regenMock] })
    await user.click(await screen.findByRole('button', { name: 'Regenerate token of Prometheus prod' }))
    await user.click(await screen.findByRole('button', { name: 'Regenerate token' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: regenerateWebhookToken: token missing in the response'))
    expect(screen.queryByText('New token', { exact: false })).not.toBeInTheDocument()
  })

  it('elimina con conferma; l\'annullamento non chiama la mutation', async () => {
    const seen: unknown[] = []
    const deleteMock: GqlMock = {
      request: { query: DELETE_MONITORING_SOURCE, variables: (v) => { seen.push(v); return true } },
      result: { data: { deleteInboundWebhook: { __typename: 'DeleteSourceResult', deleted: true, resolvedEvents: 2, affectedCIs: 1 } } },
    }
    const { user } = renderWithProviders(<MonitoringSourcesPage />, { route: '/monitoring/sources', mocks: [sourcesMock(), statsMock(), deleteMock] })
    await user.click(await screen.findByRole('button', { name: 'Delete Zabbix DC' }))
    expect(await screen.findByText('Delete the source "Zabbix DC"?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(seen).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Delete Zabbix DC' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    // D4.1: la sorgente aveva allarmi accesi → il messaggio dice quanti ne sono stati chiusi e su quanti CI
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source deleted: 2 active alarms were resolved on 1 CIs'))
    expect(seen).toEqual([{ id: 's2' }])
  })
})
