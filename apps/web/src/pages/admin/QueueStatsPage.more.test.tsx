/**
 * The job queue page, from a queue's row down to one job: this is where the
 * owner goes when something did not happen (a notification not sent, an
 * alarm not correlated) and decides whether to retry. What must hold:
 * - opening a queue asks the server for ITS jobs in the chosen state, and
 *   switching state or refreshing asks again (never a stale list);
 * - a job's detail tells what it carried (payload, pretty-printed; or that it
 *   carries nothing), how it failed (reason, stack trace) and what it returned;
 * - Retry sends that job of that queue, says it is queued and reloads both the
 *   jobs and the counters; a failed retry is SAID and the button comes back;
 * - the page keeps itself fresh (every 10 s) and stops when it is left.
 * QueueStatsPage.test.tsx covers the grouping and which queues are retryable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, within, act } from '@testing-library/react'
import { toast } from 'sonner'
import { renderWithProviders } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { QueueStatsPage } from './QueueStatsPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))

const counts = { waiting: 0, active: 0, completed: 0, failed: 1, delayed: 0 }
const QUEUES = [
  { name: 'workflow-jobs', group: 'itsm', retryable: true, paused: false, counts },
  { name: 'notification-service', group: 'itsm', retryable: false, paused: false, counts },
]

const FAILED_JOB = {
  id: 'job-1', name: 'advance', queueName: 'workflow-jobs', status: 'failed',
  data: '{"ticket":"INC1","step":"triage"}',
  timestamp: '2026-09-11T08:00:00Z', processedOn: '2026-09-11T08:00:01Z', finishedOn: '2026-09-11T08:00:02Z',
  failedReason: 'step not found', stacktrace: ['Error: step not found', '    at advance (workflow.ts:10)'],
  attemptsMade: 3, maxAttempts: 3, returnValue: null,
}
const DONE_JOB = {
  id: 'job-2', name: 'tick', queueName: 'workflow-jobs', status: 'completed', data: '{}',
  timestamp: '', processedOn: null, finishedOn: null, failedReason: null, stacktrace: [],
  attemptsMade: 1, maxAttempts: 3, returnValue: 'x'.repeat(80),
}
const RAW_JOB = { ...DONE_JOB, id: 'job-3', data: 'not json at all', returnValue: 'ok' }

beforeEach(() => {
  apolloFinto.reset()
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.error).mockClear()
  apolloFinto.risposte['GetQueueStats'] = { queueStats: QUEUES }
  apolloFinto.risposte['GetQueueJobs'] = { queueJobs: [FAILED_JOB, DONE_JOB, RAW_JOB] }
})
afterEach(() => { vi.restoreAllMocks() })

const queueRow = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) })
const queueBox = (name: string) => queueRow(name).parentElement as HTMLElement
const jobRow = (box: HTMLElement, id: string) => within(box).getByRole('button', { name: new RegExp(`^${id}`) })

async function openQueue(name = 'workflow-jobs') {
  const view = renderWithProviders(<QueueStatsPage />, { route: '/admin/queues' })
  await view.user.click(queueRow(name))
  return { ...view, box: queueBox(name) }
}

describe('QueueStatsPage — jobs of a queue', () => {
  it('opening a queue loads its failed jobs; another state or Refresh reloads; closing hides them', async () => {
    const { user, box } = await openQueue()
    expect(apolloFinto.chiamata('GetQueueJobs')).toEqual({ queueName: 'workflow-jobs', status: 'failed', limit: 50 })
    expect(within(box).getByRole('button', { name: 'failed' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(within(box).getByRole('button', { name: 'waiting' }))
    expect(apolloFinto.chiamata('GetQueueJobs')).toEqual({ queueName: 'workflow-jobs', status: 'waiting', limit: 50 })
    expect(within(box).getByRole('button', { name: 'waiting' })).toHaveAttribute('aria-pressed', 'true')

    const before = apolloFinto.chiamate['GetQueueJobs']!.length
    await user.click(within(box).getByRole('button', { name: 'Refresh' }))
    expect(apolloFinto.chiamate['GetQueueJobs']!.length).toBe(before + 1)
    // Refresh keeps the state being looked at.
    expect(apolloFinto.chiamata('GetQueueJobs')).toMatchObject({ status: 'waiting' })

    await user.click(queueRow('workflow-jobs'))
    expect(queueRow('workflow-jobs')).toHaveAttribute('aria-expanded', 'false')
    expect(within(box).queryByRole('button', { name: 'waiting' })).not.toBeInTheDocument()
  })

  it('a failed job tells what it carried and how it failed: payload pretty-printed, reason, stack trace on demand', async () => {
    const { user, box } = await openQueue()
    // The reason is readable already on the row, before opening the job.
    expect(jobRow(box, 'job-1')).toHaveTextContent('step not found')
    await user.click(jobRow(box, 'job-1'))
    expect(jobRow(box, 'job-1')).toHaveAttribute('aria-expanded', 'true')
    expect(within(box).getByText('3 / 3')).toBeInTheDocument()
    expect(within(box).getByText('Processed')).toBeInTheDocument()
    expect(within(box).getByText('Finished')).toBeInTheDocument()

    await user.click(within(box).getByRole('button', { name: 'Payload' }))
    expect(within(box).getByText(/"ticket": "INC1"/)).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Payload' }))
    expect(within(box).queryByText(/"ticket": "INC1"/)).not.toBeInTheDocument()

    await user.click(within(box).getByRole('button', { name: 'Stack trace (2 lines)' }))
    expect(within(box).getByText(/at advance \(workflow\.ts:10\)/)).toBeInTheDocument()
    await user.click(within(box).getByRole('button', { name: 'Stack trace (2 lines)' }))
    expect(within(box).queryByText(/at advance/)).not.toBeInTheDocument()

    // Clicking the open job again closes it.
    await user.click(jobRow(box, 'job-1'))
    expect(within(box).queryByRole('button', { name: 'Payload' })).not.toBeInTheDocument()
  })

  it('a job without data SAYS it carries none; a long return value is cut; a missing date is a dash', async () => {
    const { user, box } = await openQueue()
    await user.click(jobRow(box, 'job-2'))
    expect(within(box).getByText('No payload: this job carries no data')).toBeInTheDocument()
    expect(within(box).queryByRole('button', { name: 'Payload' })).not.toBeInTheDocument()
    expect(within(box).getByText(`Return: ${'x'.repeat(60)}…`)).toBeInTheDocument()
    expect(within(box).getByText('Created').nextElementSibling).toHaveTextContent(/^—$/)
    // Opening another job closes the first: one detail at a time.
    await user.click(jobRow(box, 'job-3'))
    expect(jobRow(box, 'job-2')).toHaveAttribute('aria-expanded', 'false')
    // Data that is not JSON is shown as it came, not dropped.
    await user.click(within(box).getByRole('button', { name: 'Payload' }))
    expect(within(box).getByText('not json at all')).toBeInTheDocument()
    expect(within(box).getByText('Return: ok')).toBeInTheDocument()
  })

  it('Retry sends that job of that queue, says it is queued and reloads the counters', async () => {
    apolloFinto.esiti['RetryQueueJob'] = { data: { retryQueueJob: true } }
    const { user, box } = await openQueue()
    await user.click(jobRow(box, 'job-1'))
    const refetchesBefore = apolloFinto.refetch.mock.calls.length
    await user.click(within(box).getByRole('button', { name: 'Retry' }))
    expect(apolloFinto.chiamata('RetryQueueJob')).toEqual({ queueName: 'workflow-jobs', jobId: 'job-1' })
    expect(toast.success).toHaveBeenCalledWith('Job queued for retry')
    expect(apolloFinto.refetch.mock.calls.length).toBeGreaterThan(refetchesBefore)
    expect(within(box).getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('a failed retry is shown and the button comes back', async () => {
    apolloFinto.esiti['RetryQueueJob'] = { error: new Error('job is locked') }
    const { user, box } = await openQueue()
    await user.click(jobRow(box, 'job-1'))
    await user.click(within(box).getByRole('button', { name: 'Retry' }))
    expect(toast.error).toHaveBeenCalledWith('job is locked')
    expect(toast.success).not.toHaveBeenCalled()
    expect(within(box).getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('a failed job of a consumer queue has no Retry, and says why', async () => {
    const { user, box } = await openQueue('notification-service')
    await user.click(jobRow(box, 'job-1'))
    expect(within(box).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(within(box).getAllByText('Not retryable from the UI').length).toBeGreaterThan(0)
  })

  it('a queue with no jobs in that state says so', async () => {
    apolloFinto.risposte['GetQueueJobs'] = { queueJobs: [] }
    const { box } = await openQueue()
    expect(within(box).getByText('No “failed” jobs in this queue')).toBeInTheDocument()
  })
})

describe('QueueStatsPage — freshness', () => {
  it('the page Refresh reloads the counters', async () => {
    const { user } = renderWithProviders(<QueueStatsPage />, { route: '/admin/queues' })
    await user.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!)
    expect(apolloFinto.refetch).toHaveBeenCalled()
  })

  it('reloads every 10 seconds and stops when the page is left', () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = renderWithProviders(<QueueStatsPage />, { route: '/admin/queues' })
    const call = setSpy.mock.calls.find(([, ms]) => ms === 10_000)!
    expect(call).toBeDefined()
    act(() => { (call[0] as () => void)() })
    expect(apolloFinto.refetch).toHaveBeenCalledTimes(1)
    const id = setSpy.mock.results[setSpy.mock.calls.indexOf(call)]!.value
    unmount()
    // A page left open in another tab must not keep polling forever.
    expect(clearSpy).toHaveBeenCalledWith(id)
  })

  it('a load error is shown instead of an empty «no results»', () => {
    apolloFinto.risposte['GetQueueStats'] = undefined
    apolloFinto.erroriQuery['GetQueueStats'] = new Error('redis unreachable')
    renderWithProviders(<QueueStatsPage />, { route: '/admin/queues' })
    expect(screen.getByText('redis unreachable')).toBeInTheDocument()
    expect(screen.queryByText('No results')).not.toBeInTheDocument()
  })
})
