/**
 * The queues of the platform console (`/platform/queues`), on a real Express.
 *
 * Why these behaviours matter:
 *  - since 23 Sep 2026 every tenant has its own queues and a tenant admin sees
 *    only those: `maintenance` (backups) and `autoanalisi` belong to no tenant,
 *    and this is the one place they are seen and retried — by the platform
 *    identity only;
 *  - for each tenant the page gives the totals and the queues with failed
 *    jobs: which tenant has trouble, without entering its console. A tenant's
 *    jobs are NOT retried from here (its admin does it, in its console);
 *  - a job list has a declared ceiling, and an unknown status is a 400;
 *  - a retry names the actor in the log.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const logInfo = vi.hoisted(() => vi.fn())
vi.mock('../../lib/logger.js', () => {
  const child = { info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../auth/platformAuth.js', () => ({
  platformAuthMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-tenant-user'] === '1') { res.status(403).json({ error: 'platform identity required' }); return }
    req.platformActor = { email: 'ops@platform.example', subject: 'sub-1' }
    next()
  },
}))

interface FakeQueue {
  name: string
  getJobCounts: ReturnType<typeof vi.fn>
  isPaused: ReturnType<typeof vi.fn>
  getJobs: ReturnType<typeof vi.fn>
  getJob: ReturnType<typeof vi.fn>
}
const h = vi.hoisted(() => ({
  queues: new Map<string, unknown>(),
  counts: new Map<string, Record<string, number>>(),
  tenants: [] as Array<{ id: string; suspended: boolean }>,
}))
function fake(name: string): FakeQueue {
  let q = h.queues.get(name) as FakeQueue | undefined
  if (!q) {
    q = {
      name,
      getJobCounts: vi.fn(async () => h.counts.get(name) ?? {}),
      isPaused: vi.fn(async () => false),
      getJobs: vi.fn(async () => []),
      getJob: vi.fn(async () => undefined),
    }
    h.queues.set(name, q)
  }
  return q
}
vi.mock('../../lib/bullmq.js', () => ({
  getQueue: (name: string) => fake(name),
  getTenantQueue: (base: string, tenantId: string) => fake(`${base}@${tenantId}`),
}))
vi.mock('../../lib/tenantQueueLifecycle.js', () => ({ tenantsWithQueues: () => h.tenants }))

const { platformQueuesRouter } = await import('../platform-queues.js')

let server: Server
let base: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(platformQueuesRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/queues`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  h.queues.clear()
  h.counts.clear()
  h.tenants = []
})

describe('GET /platform/queues', () => {
  it('the platform queues with their counts, and for each tenant the totals and the queues with failed jobs', async () => {
    h.counts.set('maintenance', { waiting: 0, failed: 1, completed: 30 })
    h.tenants = [{ id: 'acme', suspended: false }, { id: 'globex', suspended: true }]
    h.counts.set('sla-jobs@acme', { delayed: 12, failed: 2 })
    h.counts.set('webhook-delivery@acme', { failed: 1, waiting: 3 })
    h.counts.set('email-digest@globex', { delayed: 1 })

    const res = await fetch(base)
    expect(res.status).toBe(200)
    const body = await res.json() as { platform: unknown[]; tenants: unknown[] }
    expect(body.platform).toEqual([
      { name: 'autoanalisi', paused: false, counts: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 } },
      { name: 'maintenance', paused: false, counts: { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 30 } },
    ])
    expect(body.tenants).toEqual([
      { tenantId: 'acme', suspended: false, counts: { waiting: 3, active: 0, delayed: 12, failed: 3, completed: 0 },
        failedQueues: [{ name: 'sla-jobs', failed: 2 }, { name: 'webhook-delivery', failed: 1 }] },
      { tenantId: 'globex', suspended: true, counts: { waiting: 0, active: 0, delayed: 1, failed: 0, completed: 0 }, failedQueues: [] },
    ])
  })

  it('refused before any queue is read without the platform identity', async () => {
    const res = await fetch(base, { headers: { 'x-test-tenant-user': '1' } })
    expect(res.status).toBe(403)
    expect(h.queues.size).toBe(0)
  })
})

describe('GET /platform/queues/:name/jobs', () => {
  it('the failed jobs of a platform queue by default, mapped, skipping jobs gone from Redis', async () => {
    fake('maintenance').getJobs.mockResolvedValueOnce([
      undefined,
      { id: 'b1', name: 'backup_neo4j', data: { kind: 'nightly' }, timestamp: 1_700_000_000_000, finishedOn: 1_700_000_060_000, failedReason: 'disk full', attemptsMade: 3, opts: { attempts: 3 } },
    ])
    const res = await fetch(`${base}/maintenance/jobs`)
    expect(res.status).toBe(200)
    expect(fake('maintenance').getJobs).toHaveBeenCalledWith(['failed'], 0, 49)
    expect(await res.json()).toEqual({ queue: 'maintenance', status: 'failed', jobs: [{
      id: 'b1', name: 'backup_neo4j', data: '{"kind":"nightly"}', timestamp: new Date(1_700_000_000_000).toISOString(),
      finishedOn: new Date(1_700_000_060_000).toISOString(), failedReason: 'disk full', attemptsMade: 3, maxAttempts: 3,
    }] })
  })

  it('the page has a ceiling, and an unknown status is a 400', async () => {
    await fetch(`${base}/autoanalisi/jobs?status=waiting&limit=100000`)
    expect(fake('autoanalisi').getJobs).toHaveBeenCalledWith(['waiting'], 0, 99)
    const bad = await fetch(`${base}/autoanalisi/jobs?status=paused`)
    expect(bad.status).toBe(400)
  })

  it('a tenant queue is not the platform\'s: 404, and nothing is read', async () => {
    const res = await fetch(`${base}/sla-jobs/jobs`)
    expect(res.status).toBe(404)
    expect(h.queues.size).toBe(0)
  })
})

describe('POST /platform/queues/:name/jobs/:id/retry', () => {
  it('retries a failed job of a platform queue and names the actor in the log', async () => {
    const retry = vi.fn(async () => undefined)
    fake('maintenance').getJob.mockResolvedValueOnce({ id: 'b1', name: 'backup_neo4j', retry })
    const res = await fetch(`${base}/maintenance/jobs/b1/retry`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ queue: 'maintenance', id: 'b1', retried: true })
    expect(retry).toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ actor: 'ops@platform.example', queue: 'maintenance', jobId: 'b1' }), 'platform queue job retried')
  })

  it('a job that is not there is a 404; a tenant queue is refused', async () => {
    expect((await fetch(`${base}/maintenance/jobs/nope/retry`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${base}/sla-jobs/jobs/j1/retry`, { method: 'POST' })).status).toBe(404)
  })
})
