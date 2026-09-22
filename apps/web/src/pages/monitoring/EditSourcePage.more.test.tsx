/**
 * Editing a monitoring source: the page states (loading, failed, missing) and
 * the token regeneration.
 *
 * What a regression costs the admin:
 * - regenerating the token invalidates the one the monitoring tool is using,
 *   so it must ask first, and the new token must be SHOWN (it is visible
 *   only once — lose it and the tool can no longer send alerts);
 * - a response without a token must be an error, not a silent "done";
 * - a failed save must say why and keep the admin on the page with their edits;
 * - a source that does not exist (deleted, wrong link) must offer the way back,
 *   not an empty form that would try to save nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { EditSourcePage } from './EditSourcePage'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

// The fake Apollo always answers "loaded"; this flag holds the query in flight.
const inFlight = vi.hoisted(() => ({ loading: false }))
vi.mock('@apollo/client/react', async () => {
  const m = (await import('@/test/apolloFinto')).moduloApollo()
  return {
    ...m,
    useQuery: (...args: Parameters<typeof m.useQuery>) => {
      const r = m.useQuery(...args)
      return inFlight.loading ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const SOURCE = {
  id: 's1', name: 'Prometheus prod', entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
  enabled: true, rateLimitPerMinute: 100, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0, createdAt: '2026-09-01T00:00:00Z',
}

const mount = () => renderWithProviders(<EditSourcePage />, { route: '/monitoring/sources/s1', path: '/monitoring/sources/:id' })

beforeEach(() => {
  apolloFinto.reset()
  inFlight.loading = false
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetMonitoringSource'] = { monitoringSource: SOURCE }
})

describe('EditSourcePage — page states', () => {
  it('while the source loads, a loader and no form', () => {
    inFlight.loading = true
    mount()
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('a failed load shows the error and "Retry" asks again', async () => {
    apolloFinto.erroriQuery['GetMonitoringSource'] = new Error('upstream timeout')
    const { user } = mount()
    expect(screen.getByText('upstream timeout')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('a source that does not exist offers the way back to the list', async () => {
    apolloFinto.risposte['GetMonitoringSource'] = { monitoringSource: null }
    const { user } = mount()
    expect(screen.getByText('Source not found')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to sources' }))
    await attendiURL('/monitoring/sources')
  })
})

describe('EditSourcePage — saving', () => {
  it('the edited name is saved trimmed', async () => {
    const { user } = mount()
    const name = screen.getByLabelText('Source name')
    await user.clear(name)
    await user.type(name, '  Prometheus EU  ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(apolloFinto.chiamata('UpdateMonitoringSource')).toMatchObject({ id: 's1', input: { name: 'Prometheus EU' } }))
  })

  it('an empty name cannot be saved', async () => {
    const { user } = mount()
    await user.clear(screen.getByLabelText('Source name'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a failed save says why and stays on the page', async () => {
    apolloFinto.esiti['UpdateMonitoringSource'] = { error: new Error('name already used') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: name already used'))
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByTestId('location')).toHaveTextContent('/monitoring/sources/s1')
  })
})

describe('EditSourcePage — token regeneration', () => {
  it('asks first: cancelling regenerates nothing', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Regenerate token' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Regenerate the token?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(apolloFinto.chiamata('RegenerateSourceToken')).toBeUndefined()
  })

  it('confirmed: the new token is shown once, in place of the button', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { data: { regenerateWebhookToken: { id: 's1', token: 'tok-NEW-42' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Regenerate token' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate token' }))
    expect(await screen.findByLabelText('Token')).toHaveTextContent('tok-NEW-42')
    expect(apolloFinto.chiamata('RegenerateSourceToken')).toEqual({ id: 's1' })
    expect(toast.success).toHaveBeenCalledWith('Token regenerated')
    expect(screen.queryByRole('button', { name: 'Regenerate token' })).toBeNull()
  })

  it('a response without the token is an error, not a silent success', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { data: { regenerateWebhookToken: { id: 's1', token: '' } } }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Regenerate token' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate token' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: regenerateWebhookToken: token missing in the response'))
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a server error is reported and the button stays available', async () => {
    apolloFinto.esiti['RegenerateSourceToken'] = { error: new Error('forbidden') }
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Regenerate token' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Regenerate token' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Action failed: forbidden'))
    expect(screen.getByRole('button', { name: 'Regenerate token' })).toBeInTheDocument()
  })
})
