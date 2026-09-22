/**
 * The failure handlers of the two event queues, and a non-Error rejection in
 * a periodic pass.
 *
 * Why these behaviours matter: when a delayed correlation or a change-window
 * re-evaluation fails for the last time, the `onFailed` log line is the only
 * trace an operator has — it must name the tenant and the event (or the
 * change) so the stuck alarm can be found. BullMQ may call `onFailed` with no
 * job at all (a stalled job it could not load): the handler must not crash
 * the worker in that case. And a pass that rejects with something that is
 * not an Error must still produce a readable reason, not "[object Object]"
 * or a crash of the aggregation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type OnFailed = (job: unknown, err: Error) => void
const workerOpts = new Map<string, { onFailed: OnFailed }>()
const logError = vi.fn()

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, _processor: unknown, opts: { onFailed: OnFailed }) => {
    workerOpts.set(name, opts)
    return { name }
  }),
  getQueue: vi.fn(() => ({ add: vi.fn(), upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn(async () => false), getJob: vi.fn() })),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => logError(...a), debug: vi.fn() }
  return { logger: { child: () => child } }
})
vi.mock('../../services/eventCorrelation.js', () => ({
  runEventPipeline: vi.fn(),
  reevaluateSuppressedEvents: vi.fn(),
  reevaluateClosedWindows: vi.fn(async () => ({ evaluated: 0, failed: 0, truncated: false })),
  reevaluatePendingEvents: vi.fn(async () => ({ evaluated: 0, failed: 0, truncated: false })),
  reevaluateFlappingEvents: vi.fn(async () => ({ evaluated: 0, stabilized: 0, failed: 0, truncated: false })),
  refreshEventGauges: vi.fn(async () => ({ overdueDelayed: 0, firingUncorrelated: 0 })),
}))
vi.mock('../../services/eventStorm.js', () => ({ endCooledStorms: vi.fn(async () => ({ evaluated: 0, active: 0, ended: 0, failed: 0, truncated: false })) }))
vi.mock('../../middleware/metrics.js', () => ({
  eventCorrelateJobLagSeconds: { observe: vi.fn() }, eventPassTotal: { inc: vi.fn() }, eventPassDurationSeconds: { observe: vi.fn() },
}))

const { startEventCorrelateWorker, startEventMaintenanceWorker, runPeriodicPasses, EVENT_CORRELATE_QUEUE, EVENT_MAINTENANCE_QUEUE } = await import('../eventCorrelateWorker.js')
const { reevaluatePendingEvents } = await import('../../services/eventCorrelation.js')

beforeEach(() => { logError.mockClear(); workerOpts.clear() })

describe('events-correlate onFailed', () => {
  it('logs tenant, event and attempts of a failed delayed correlation', async () => {
    await startEventCorrelateWorker()
    const { onFailed } = workerOpts.get(EVENT_CORRELATE_QUEUE)!
    onFailed({ id: 'j1', name: 'correlate', attemptsMade: 3, data: { tenantId: 't1', eventId: 'ev-1', dueAt: 'x' } }, new Error('Event ev-1 not found'))
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', jobName: 'correlate', tenantId: 't1', eventId: 'ev-1', changeId: undefined, attemptsMade: 3, err: 'Event ev-1 not found' }),
      'Event correlate job failed',
    )
  })

  it('logs the change of a failed change-window re-evaluation', async () => {
    await startEventCorrelateWorker()
    workerOpts.get(EVENT_CORRELATE_QUEUE)!.onFailed({ id: 'j2', name: 'reevaluate-change-window', attemptsMade: 1, data: { tenantId: 't1', changeId: 'chg-1', stepEpoch: 1 } }, new Error('boom'))
    expect(logError.mock.calls[0]![0]).toMatchObject({ tenantId: 't1', changeId: 'chg-1', eventId: undefined })
  })

  it('does not crash when BullMQ reports a failure without a job', async () => {
    await startEventCorrelateWorker()
    expect(() => workerOpts.get(EVENT_CORRELATE_QUEUE)!.onFailed(undefined, new Error('stalled'))).not.toThrow()
    expect(logError.mock.calls[0]![0]).toMatchObject({ jobId: undefined, tenantId: undefined, err: 'stalled' })
  })
})

describe('events-maintenance onFailed', () => {
  it('logs the job and the reason; a missing job does not crash', async () => {
    await startEventMaintenanceWorker()
    const { onFailed } = workerOpts.get(EVENT_MAINTENANCE_QUEUE)!
    onFailed({ id: 'm1', name: 'events-maintenance', attemptsMade: 1 }, new Error('pending: db down'))
    expect(logError).toHaveBeenCalledWith({ jobId: 'm1', jobName: 'events-maintenance', attemptsMade: 1, err: 'pending: db down' }, 'Event maintenance job failed')
    expect(() => onFailed(undefined, new Error('stalled'))).not.toThrow()
  })
})

describe('runPeriodicPasses with a non-Error rejection', () => {
  it('uses the string form of whatever was thrown as the reason', async () => {
    vi.mocked(reevaluatePendingEvents).mockRejectedValueOnce('lock timeout')
    await expect(runPeriodicPasses('2026-09-09T10:00:00.000Z')).rejects.toThrow('[events-maintenance] events-maintenance: pending: lock timeout')
  })
})
