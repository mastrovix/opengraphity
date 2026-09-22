/**
 * The "Add source" wizard, past the happy path: the Test step's reception
 * check, a failed test event, the rate limit, and leaving with an uncopied token.
 *
 * What a regression costs the admin:
 * - the reception check is the ONLY way the admin learns whether the tool
 *   can actually reach OpenGrafo: every outcome (not yet processed, rejected
 *   with an error, source gone, check itself failed) must be told apart and
 *   re-checkable; a check that silently shows nothing leaves them guessing;
 * - a test event that fails, or a server answer without the count, must say
 *   so instead of pretending the event was queued;
 * - the token is shown only once: leaving through the back link without
 *   having copied it must ask first (D·1.17), and must NOT ask once copied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders, attendiURL } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { NewSourceWizard } from './NewSourceWizard'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}))

/**
 * The reception check is a lazy query whose answer the test must shape
 * freely (an `error` field, no `data`, a throw): the shared fake only returns
 * data, so the lazy query is replaced here.
 */
const reception = vi.hoisted(() => ({ answer: (async () => ({ data: undefined })) as (vars: unknown) => Promise<unknown> }))
vi.mock('@apollo/client/react', async () => {
  const m = (await import('@/test/apolloFinto')).moduloApollo()
  return { ...m, useLazyQuery: () => [(o: { variables?: unknown }) => reception.answer(o.variables), { loading: false }] }
})

const SOURCE = {
  id: 'src-9', name: 'AM', entityType: 'event', connectorKind: 'alertmanager', fieldMapping: '{}', defaultValues: null, valueMapping: null,
  enabled: true, lastReceivedAt: null, receiveCount: 0, lastError: null, lastErrorAt: null, errorCount: 0, createdAt: '2026-09-09T10:00:00Z',
}

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.esiti['CreateMonitoringSource'] = { data: { createInboundWebhook: { id: 'src-9', name: 'AM', token: 'tok-9' } } }
  apolloFinto.esiti['SendSampleEvent'] = { data: { sendSampleEvent: 2 } }
  reception.answer = async () => ({ data: { monitoringSource: SOURCE } })
})

type User = ReturnType<typeof renderWithProviders>['user']

async function toConnect(user: User) {
  await user.click(screen.getByRole('radio', { name: /Alertmanager/ }))
  await user.click(screen.getByRole('button', { name: 'Next →' }))
  await user.type(screen.getByLabelText('Source name'), 'AM')
  await user.click(screen.getByRole('button', { name: 'Create source' }))
  await screen.findByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })
}

async function toTest(user: User) {
  await toConnect(user)
  await user.click(screen.getByRole('button', { name: 'Next →' }))
  await screen.findByRole('heading', { level: 2, name: 'Step 4 of 4 · Test' })
}

const mount = () => renderWithProviders(<NewSourceWizard sampleCheckDelayMs={0} />, { route: '/monitoring/sources/new' })

describe('NewSourceWizard — reception check outcomes', () => {
  it('not processed yet → says so; "Check again" asks the same source again and reads it as received', async () => {
    const { user } = mount()
    await toTest(user)
    const asked: unknown[] = []
    reception.answer = async (v) => { asked.push(v); return { data: { monitoringSource: SOURCE } } }
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText('Not processed yet: try again in a few seconds.')).toBeInTheDocument()
    expect(screen.getByText(/2 test events queued/)).toBeInTheDocument()
    expect(apolloFinto.chiamata('SendSampleEvent')).toEqual({ sourceId: 'src-9', payload: null })

    reception.answer = async (v) => { asked.push(v); return { data: { monitoringSource: { ...SOURCE, lastReceivedAt: '2026-09-09T10:05:00Z' } } } }
    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText(/^Received ✔/)).toBeInTheDocument()
    expect(asked).toEqual([{ id: 'src-9' }, { id: 'src-9' }])
  })

  it('a source that is no longer there is reported as such', async () => {
    reception.answer = async () => ({ data: { monitoringSource: null } })
    const { user } = mount()
    await toTest(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText('The source is no longer listed.')).toBeInTheDocument()
  })

  it.each([
    ['the query returns an error', async () => ({ error: new Error('boom'), data: undefined }), 'Cannot check reception: boom'],
    ['the query returns no data', async () => ({ data: undefined }), 'Cannot check reception: monitoringSource: empty response'],
    ['the query throws', async () => { throw new Error('offline') }, 'Cannot check reception: offline'],
  ])('%s → the check itself is reported as failed, not as "pending"', async (_label, answer, text) => {
    reception.answer = answer
    const { user } = mount()
    await toTest(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
    // Still re-checkable: the failure may be transient.
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('sending twice restarts the check instead of stacking two', async () => {
    const { user } = mount()
    await toTest(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    await screen.findByText('Not processed yet: try again in a few seconds.')
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    await waitFor(() => expect(apolloFinto.chiamate['SendSampleEvent']).toHaveLength(2))
    expect(await screen.findByText('Not processed yet: try again in a few seconds.')).toBeInTheDocument()
  })
})

describe('NewSourceWizard — a test event that does not go through', () => {
  it('a server error is reported and nothing claims the event was queued', async () => {
    apolloFinto.esiti['SendSampleEvent'] = { error: new Error('queue full') }
    const { user } = mount()
    await toTest(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Test event failed: queue full'))
    expect(screen.queryByText(/test events? queued/)).toBeNull()
  })

  it('an answer without the count is an error, not a success', async () => {
    apolloFinto.esiti['SendSampleEvent'] = { data: { sendSampleEvent: null } }
    const { user } = mount()
    await toTest(user)
    await user.click(screen.getByRole('button', { name: 'Send test event' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Test event failed: sendSampleEvent: empty response'))
    expect(toast.success).not.toHaveBeenCalledWith('Test event queued: open it in Events')
  })
})

describe('NewSourceWizard — rate limit and leaving', () => {
  it('the rate limit typed on step 2 is the one the source is created with; an invalid one blocks creation', async () => {
    const { user } = mount()
    await user.click(screen.getByRole('radio', { name: /Alertmanager/ }))
    await user.click(screen.getByRole('button', { name: 'Next →' }))
    await user.type(screen.getByLabelText('Source name'), 'AM')
    const limit = screen.getByLabelText('Requests per minute accepted')
    await user.clear(limit)
    expect(screen.getByRole('button', { name: 'Create source' })).toBeDisabled()
    expect(screen.getByText('Enter a whole number between 1 and 10000.')).toBeInTheDocument()
    await user.type(limit, '42')
    await user.click(screen.getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(apolloFinto.chiamata('CreateMonitoringSource')).toMatchObject({ input: { name: 'AM', rateLimitPerMinute: 42, connectorKind: 'alertmanager' } }))
  })

  it('the back link with an uncopied token asks first; cancelling stays, confirming leaves', async () => {
    const { user } = mount()
    await toConnect(user)
    await user.click(screen.getByRole('link', { name: 'Back to sources' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Token not copied')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('heading', { level: 2, name: 'Step 3 of 4 · Connection' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Back to sources' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave anyway' }))
    await attendiURL('/monitoring/sources')
  })

  it('once the token is copied, the back link leaves without asking', async () => {
    const { user } = mount()
    await toConnect(user)
    await user.click(screen.getByRole('button', { name: 'Copy token' }))
    await user.click(screen.getByRole('link', { name: 'Back to sources' }))
    await attendiURL('/monitoring/sources')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
