/**
 * THE QUEUES PANEL of the platform console (23 Sep 2026).
 *
 * Every tenant has its own queues since 23 Sep 2026, and its administrator
 * retries them in its own console. What this panel must make plain:
 *
 *  1. the two queues of the platform (backups, self-analysis) with their
 *     counts, and their failed jobs WITH the reason and a Retry — this is the
 *     only place they can be retried;
 *  2. for each tenant, only totals and the queues with failed jobs: no retry
 *     of a tenant's job from here;
 *  3. a suspended tenant's queues read "paused": its jobs wait, they are not
 *     lost;
 *  4. a failure is said on the page, never swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const api = vi.hoisted(() => ({ queues: vi.fn(), failedJobs: vi.fn(), retryJob: vi.fn() }))
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  api,
}))
vi.mock('./keycloak', () => ({ keycloak: { token: 'tok' } }))

const { QueuesPanel } = await import('./QueuesPanel')

const counts = (over: Record<string, number> = {}) => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, ...over })
const DATA = {
  platform: [
    { name: 'autoanalisi', paused: false, counts: counts() },
    { name: 'maintenance', paused: false, counts: counts({ failed: 1, completed: 30 }) },
  ],
  tenants: [
    { tenantId: 'acme', suspended: false, counts: counts({ delayed: 12, failed: 3 }), failedQueues: [{ name: 'sla-jobs', failed: 2 }, { name: 'webhook-delivery', failed: 1 }] },
    { tenantId: 'globex', suspended: true, counts: counts({ delayed: 1 }), failedQueues: [] },
  ],
}
const FAILED = { queue: 'maintenance', status: 'failed', jobs: [{
  id: 'b1', name: 'backup_neo4j', data: '{}', timestamp: '2026-09-23T00:00:00.000Z', finishedOn: null,
  failedReason: 'ENOSPC: no space left on device', attemptsMade: 3, maxAttempts: 3,
}] }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.queues.mockResolvedValue(DATA)
  api.failedJobs.mockResolvedValue(FAILED)
  api.retryJob.mockResolvedValue({ queue: 'maintenance', id: 'b1', retried: true })
})
afterEach(cleanup)

describe('QueuesPanel', () => {
  it('lists the platform queues with their counts; a queue without failures has nothing to open', async () => {
    render(<QueuesPanel />)
    const table = await screen.findByRole('table', { name: 'Platform queues' })
    const maintenance = within(table).getByText('maintenance').closest('tr')!
    expect(within(maintenance).getAllByRole('cell').map((c) => c.textContent)).toEqual(['maintenance', '0', '0', '0', '1', '30', 'Show'])
    const autoanalisi = within(table).getByText('autoanalisi').closest('tr')!
    expect((within(autoanalisi).getByRole('button', { name: 'Show' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the failed jobs of a platform queue with their reason, and retries one', async () => {
    const user = userEvent.setup()
    render(<QueuesPanel />)
    const table = await screen.findByRole('table', { name: 'Platform queues' })
    await user.click(within(within(table).getByText('maintenance').closest('tr')!).getByRole('button', { name: 'Show' }))
    const list = await screen.findByRole('list', { name: 'Failed jobs of maintenance' })
    expect(within(list).getByText('ENOSPC: no space left on device')).toBeTruthy()
    expect(within(list).getByText('3/3 attempts')).toBeTruthy()

    await user.click(within(list).getByRole('button', { name: 'Retry' }))
    expect(api.retryJob).toHaveBeenCalledWith('maintenance', 'b1')
    // Both are read again from the server: the state after a retry is not guessed.
    await vi.waitFor(() => expect(api.queues).toHaveBeenCalledTimes(2))
    expect(api.failedJobs).toHaveBeenCalledTimes(2)
  })

  it('for the tenants only totals and the queues with failures, and no Retry; a suspended one reads paused', async () => {
    render(<QueuesPanel />)
    const table = await screen.findByRole('table', { name: 'Tenant queues' })
    const acme = within(table).getByText('acme').closest('tr')!
    expect(within(acme).getByText('sla-jobs (2), webhook-delivery (1)')).toBeTruthy()
    expect(within(table).queryByRole('button')).toBeNull()
    const globex = within(table).getByText('globex').closest('tr')!
    expect(within(globex).getByText('paused')).toBeTruthy()
    expect(within(globex).getByText('none')).toBeTruthy()
  })

  it('a failure is said on the page', async () => {
    api.queues.mockRejectedValueOnce(new Error('Queue maintenance not found'))
    render(<QueuesPanel />)
    expect((await screen.findByRole('alert')).textContent).toContain('Queue maintenance not found')
  })

  it('no tenant yet: said, not an empty table', async () => {
    api.queues.mockResolvedValueOnce({ platform: DATA.platform, tenants: [] })
    render(<QueuesPanel />)
    expect(await screen.findByText('No tenant has queues yet.')).toBeTruthy()
  })
})
