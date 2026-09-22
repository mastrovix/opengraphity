/**
 * Monitoring sources, the failure paths and the navigation the main test does
 * not reach. For an admin wiring a tool to OpenGrafo:
 * - a failed enable/disable, delete or test event must say so (otherwise the
 *   admin believes the endpoint is on/off/gone when it is not);
 * - cancelling "regenerate token" must leave the current token working;
 * - the new token is shown once and the dialog closes only on request;
 * - two test events in a row refresh the counters once, after the job ran,
 *   not twice and not immediately (when nothing has changed yet);
 * - a failed first load shows an error with retry, not "no sources".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import type { MonitoringSource } from '@/types/events'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

import { MonitoringSourcesPage } from './MonitoringSourcesPage'

function source(over: Partial<MonitoringSource> & { id: string; name: string }): MonitoringSource {
  return {
    entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
    enabled: true, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0,
    createdAt: '2026-09-01T00:00:00Z', ...over,
  }
}

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetMonitoringSources'] = { monitoringSources: [source({ id: 's1', name: 'Prom' })] }
  apolloFinto.risposte['GetEventStats'] = { eventStats: { stormSources: [] } }
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
})

const confirmDialog = async (button: string) => {
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: button }))
}

describe('MonitoringSourcesPage — failures are reported', () => {
  it('a failed enable/disable shows the error and does not claim success', async () => {
    apolloFinto.esiti['UpdateMonitoringSource'] = { error: new Error('forbidden') }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByLabelText('Enable or disable Prom'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('forbidden')))
    expect(apolloFinto.chiamata('UpdateMonitoringSource')).toEqual({ id: 's1', input: { enabled: false } })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failed delete shows the error', async () => {
    apolloFinto.esiti['DeleteMonitoringSource'] = { error: new Error('still referenced') }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete Prom' }))
    await confirmDialog('Delete')
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('still referenced')))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a failed test event shows the error', async () => {
    apolloFinto.esiti['SendSampleEvent'] = { error: new Error('queue down') }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Send a test event from Prom' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Test event failed: queue down'))
  })

  it('a failed first load shows the error with a retry', async () => {
    apolloFinto.erroriQuery['GetMonitoringSources'] = new Error('sources down')
    renderWithProviders(<MonitoringSourcesPage />)
    expect(screen.getByText('sources down')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })
})

describe('MonitoringSourcesPage — token regeneration', () => {
  it('cancelling leaves the token alone', async () => {
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate token of Prom' }))
    await confirmDialog('Cancel')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('RegenerateSourceToken')).toBeUndefined()
  })

  it('an answer without a token is an error, not an empty secret', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { data: { regenerateWebhookToken: { id: 's1', token: '' } } }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate token of Prom' }))
    await confirmDialog('Regenerate token')
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.queryByText('New token — Prom')).toBeNull()
  })

  it('the new token is shown once, and the dialog closes from its button', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { data: { regenerateWebhookToken: { id: 's1', token: 'tok-123' } } }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate token of Prom' }))
    await confirmDialog('Regenerate token')
    expect(await screen.findByText('New token — Prom')).toBeInTheDocument()
    expect(screen.getByText('tok-123')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    const closeButtons = within(dialog).getAllByRole('button', { name: 'Close' })
    await userEvent.click(closeButtons.at(-1)!)
    await waitFor(() => expect(screen.queryByText('New token — Prom')).toBeNull())
  })

  it('the new token dialog also closes from its header', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { data: { regenerateWebhookToken: { id: 's1', token: 'tok-456' } } }
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate token of Prom' }))
    await confirmDialog('Regenerate token')
    await screen.findByText('New token — Prom')
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!)
    await waitFor(() => expect(screen.queryByText('New token — Prom')).toBeNull())
  })
})

describe('MonitoringSourcesPage — test event and navigation', () => {
  it('two test events in a row refresh the list once, after the delay; the toast opens the console on that source', async () => {
    apolloFinto.esiti['SendSampleEvent'] = { data: { sendSampleEvent: 1 } }
    renderWithProviders(<MonitoringSourcesPage sampleRefetchDelayMs={300} />)
    const send = screen.getByRole('button', { name: 'Send a test event from Prom' })
    await userEvent.click(send)
    await userEvent.click(send)
    // Nothing yet: the job has not processed the event.
    expect(apolloFinto.refetch).not.toHaveBeenCalled()
    await waitFor(() => expect(apolloFinto.refetch).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 400))
    // The first timer was replaced, not left to fire too.
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)

    const options = vi.mocked(toast.success).mock.calls.at(-1)?.[1] as unknown as { action: { onClick: () => void } }
    options.action.onClick()
    await attendiURL('/events', { sourceId: 's1' })
  })

  it('the name opens the source, as does the edit button; add opens the wizard', async () => {
    renderWithProviders(<MonitoringSourcesPage />)
    await userEvent.click(screen.getByRole('link', { name: 'Prom' }))
    await attendiURL('/monitoring/sources/s1')
    await userEvent.click(screen.getByRole('button', { name: 'Edit Prom' }))
    await attendiURL('/monitoring/sources/s1')
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }))
    await attendiURL('/monitoring/sources/new')
  })
})
