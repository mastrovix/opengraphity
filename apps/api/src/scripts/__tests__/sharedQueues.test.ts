/**
 * scripts/lib/sharedQueues.ts — the queues the tenants used to share, dropped
 * once each tenant has its own (23 Sep 2026).
 *
 * Why these behaviours matter:
 *  - without the confirmation nothing is removed: the command says what it
 *    would drop, jobs and recurring jobs included;
 *  - a shared queue still worked by some process is the live queue of the code
 *    from before: it is never dropped, confirmation or not;
 *  - a queue that is no longer in Redis is not even opened.
 */
import { describe, it, expect, vi } from 'vitest'
import { dropSharedQueues, formatSharedQueueReport, type RetiredQueue } from '../lib/sharedQueues.js'

function fakeQueue(over: { counts?: Record<string, number>; schedulers?: number; workers?: number } = {}): RetiredQueue & { obliterate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    getJobCounts: vi.fn(async () => over.counts ?? { delayed: 12, failed: 1 }),
    getJobSchedulersCount: vi.fn(async () => over.schedulers ?? 2),
    getWorkersCount: vi.fn(async () => over.workers ?? 0),
    obliterate: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  }
}

describe('dropSharedQueues', () => {
  it('without the confirmation it only says what would go, and closes every queue it opened', async () => {
    const sla = fakeQueue()
    const out = await dropSharedQueues({
      bases: ['sla-jobs', 'email-digest'], apply: false,
      exists: async (b) => b === 'sla-jobs', open: () => sla,
    })
    expect(out).toEqual([{
      base: 'sla-jobs', schedulers: 2, workers: 0, outcome: 'would-drop',
      jobs: { waiting: 0, prioritized: 0, delayed: 12, active: 0, failed: 1, completed: 0, 'waiting-children': 0 },
    }])
    expect(sla.obliterate).not.toHaveBeenCalled()
    expect(sla.close).toHaveBeenCalled()
  })

  it('with the confirmation it obliterates them, running jobs included', async () => {
    const q = fakeQueue()
    const out = await dropSharedQueues({ bases: ['sla-jobs'], apply: true, exists: async () => true, open: () => q })
    expect(q.obliterate).toHaveBeenCalledWith({ force: true })
    expect(out[0]!.outcome).toBe('dropped')
  })

  it('a shared queue with workers connected is never dropped: some process still runs the code from before', async () => {
    const q = fakeQueue({ workers: 3 })
    const out = await dropSharedQueues({ bases: ['sla-jobs'], apply: true, exists: async () => true, open: () => q })
    expect(q.obliterate).not.toHaveBeenCalled()
    expect(out[0]).toMatchObject({ outcome: 'still-worked', workers: 3 })
  })

  it('a queue gone from Redis is not opened at all', async () => {
    const open = vi.fn(() => fakeQueue())
    expect(await dropSharedQueues({ bases: ['embeddings'], apply: true, exists: async () => false, open })).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it('a queue that fails while being read is still closed, and the failure reaches the caller', async () => {
    const q = fakeQueue()
    q.getJobCounts = vi.fn(async () => { throw new Error('NOAUTH') })
    await expect(dropSharedQueues({ bases: ['sla-jobs'], apply: true, exists: async () => true, open: () => q })).rejects.toThrow('NOAUTH')
    expect(q.close).toHaveBeenCalled()
  })
})

describe('formatSharedQueueReport', () => {
  const jobs = { waiting: 0, prioritized: 0, delayed: 12, active: 0, failed: 1, completed: 0, 'waiting-children': 0 }
  it('names the non-empty states, the schedulers and what happened', () => {
    expect(formatSharedQueueReport({ base: 'sla-jobs', jobs, schedulers: 2, workers: 0, outcome: 'would-drop' }))
      .toMatch(/^sla-jobs\s+delayed 12, failed 1; 2 scheduler\(s\) — would be dropped$/)
    expect(formatSharedQueueReport({ base: 'sla-jobs', jobs, schedulers: 0, workers: 1, outcome: 'still-worked' }))
      .toContain('NOT dropped: 1 worker(s) still connected')
    expect(formatSharedQueueReport({ base: 'x', jobs: { ...jobs, delayed: 0, failed: 0 }, schedulers: 0, workers: 0, outcome: 'dropped' }))
      .toContain('no jobs; 0 scheduler(s) — dropped')
  })
})
