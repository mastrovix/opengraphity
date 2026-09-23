/**
 * One queue per tenant (owner's decision, 23 Sep 2026): the names, the
 * producers on one shared connection, the pools that follow the tenants, the
 * pause of a suspended tenant and the removal of a purged one. BullMQ and
 * ioredis are fakes: nothing here touches Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  class Queue {
    handlers: Record<string, Handler> = {}
    add = vi.fn(async (_n: string, _d: unknown, o?: { jobId?: string }) => ({ id: o?.jobId ?? 'job' }))
    pause = vi.fn(async () => { if (state.failPause === this.name) throw new Error('redis down') })
    resume = vi.fn(async () => {})
    obliterate = vi.fn(async () => { if (state.failObliterate === this.name) throw new Error('obliterate failed') })
    close = vi.fn(async () => {})
    constructor(public name: string, public opts: { connection: unknown }) { state.queues.push(this) }
    on(event: string, cb: Handler) { this.handlers[event] = cb; return this }
  }
  class Worker {
    handlers: Record<string, Handler> = {}
    close = vi.fn(async () => {})
    constructor(public name: string, public processor: (job: unknown, ...rest: unknown[]) => Promise<unknown>, public opts: Record<string, unknown>) { state.workers.push(this) }
    on(event: string, cb: Handler) { this.handlers[event] = cb; return this }
  }
  class Redis {
    handlers: Record<string, Handler> = {}
    quit = vi.fn(async () => 'OK')
    disconnect = vi.fn()
    constructor(public opts: unknown) { state.redis.push(this) }
    on(event: string, cb: Handler) { this.handlers[event] = cb; return this }
  }
  const state = {
    queues: [] as Queue[], workers: [] as Worker[], redis: [] as Redis[],
    failPause: null as string | null, failObliterate: null as string | null,
  }
  return { state, Queue, Worker, Redis }
})

vi.mock('bullmq', () => ({ Queue: fake.Queue, Worker: fake.Worker }))
vi.mock('ioredis', () => ({ Redis: fake.Redis }))

const tq = await import('../tenantQueues.js')

beforeEach(() => {
  tq.resetTenantQueuesForTests()
  fake.state.queues.length = 0
  fake.state.workers.length = 0
  fake.state.redis.length = 0
  fake.state.failPause = null
  fake.state.failObliterate = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  delete process.env['REDIS_URL']
  process.env['REDIS_HOST'] = 'redis.test'
  process.env['REDIS_PORT'] = '6390'
})

const job = (data: unknown, name = 'x', id = 'j1') => ({ name, id, data }) as unknown as Job

describe('the name of a tenant queue', () => {
  it('is <base>@<tenant>, and splits back', () => {
    expect(tq.tenantQueueName('sla-jobs', 'c-one')).toBe('sla-jobs@c-one')
    expect(tq.splitTenantQueueName('sla-jobs@c-one')).toEqual({ base: 'sla-jobs', tenantId: 'c-one' })
  })

  it('refuses a missing or malformed tenant, saying which queue asked', () => {
    expect(() => tq.tenantQueueName('sla-jobs', '')).toThrow('"" is not a tenant id: the work of queue "sla-jobs" belongs to a tenant')
    expect(() => tq.tenantQueueName('sla-jobs', 'a@b')).toThrow('is not a tenant id')
    expect(() => tq.tenantQueueName('sla-jobs', 'a:b')).toThrow('is not a tenant id')
    expect(() => tq.tenantQueueName('Sla_Jobs', 't1')).toThrow('"Sla_Jobs" is not a queue base name')
  })

  it('a shared or platform queue name is not a tenant queue', () => {
    expect(tq.splitTenantQueueName('maintenance')).toBeNull()
    expect(tq.splitTenantQueueName('@c-one')).toBeNull()
    expect(tq.splitTenantQueueName('sla-jobs@')).toBeNull()
  })
})

describe('the tenant a job names', () => {
  it('reads tenantId, tenant_id (a domain event) and one level down', () => {
    expect(tq.jobTenantOf({ tenantId: 't1' })).toBe('t1')
    expect(tq.jobTenantOf({ tenant_id: 't2', payload: {} })).toBe('t2')
    expect(tq.jobTenantOf({ event: { tenant_id: 't3' } })).toBe('t3')
  })

  it('is null when the job names none', () => {
    expect(tq.jobTenantOf({ tenantId: '' })).toBeNull()
    expect(tq.jobTenantOf({ sweep: true })).toBeNull()
    expect(tq.jobTenantOf(null)).toBeNull()
    expect(tq.jobTenantOf([{ tenantId: 't1' }])).toBeNull()
    expect(tq.jobTenantOf({ list: [{ tenantId: 't1' }] })).toBeNull()
  })
})

describe('producer queues', () => {
  it('one per name, all on ONE Redis connection, each with an error listener', () => {
    const errors: string[] = []
    tq.setTenantQueueHooks({ queueError: (name) => { errors.push(name) } })
    const a = tq.tenantQueue('sla-jobs', 't1')
    expect(tq.tenantQueue('sla-jobs', 't1')).toBe(a)
    const b = tq.tenantQueue('sla-jobs', 't2')
    expect(b).not.toBe(a)
    expect(fake.state.redis).toHaveLength(1)
    expect((a as unknown as { opts: { connection: unknown } }).opts.connection).toBe(fake.state.redis[0])
    ;(a as unknown as InstanceType<typeof fake.Queue>).handlers['error']!(new Error('blip'))
    fake.state.redis[0]!.handlers['error']!(new Error('conn blip'))
    expect(errors).toEqual(['sla-jobs@t1', 'tenant-producers'])
    expect(tq.openTenantQueues()).toHaveLength(2)
  })

  it('closeTenantQueues closes every producer and the shared connection, and a later use opens fresh ones', async () => {
    const a = tq.tenantQueue('sla-jobs', 't1') as unknown as InstanceType<typeof fake.Queue>
    await tq.closeTenantQueues()
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(fake.state.redis[0]!.quit).toHaveBeenCalledTimes(1)
    expect(tq.openTenantQueues()).toHaveLength(0)
    expect(tq.tenantQueue('sla-jobs', 't1')).not.toBe(a)
    expect(fake.state.redis).toHaveLength(2)
  })

  it('without the host\'s hooks the faults still reach the console, naming the queue', async () => {
    const q = tq.tenantQueue('sla-jobs', 't1') as unknown as InstanceType<typeof fake.Queue>
    q.handlers['error']!(new Error('blip'))
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    await pool.add('t1')
    fake.state.workers[0]!.handlers['error']!(new Error('conn lost'))
    fake.state.workers[0]!.handlers['ready']!()
    expect(vi.mocked(console.error).mock.calls.map((c) => c[0])).toEqual([
      '[tenant-queues] queue sla-jobs@t1: blip',
      '[tenant-queues] worker sla-jobs@t1: conn lost',
    ])
  })

  it('a shared connection that does not quit cleanly is dropped anyway', async () => {
    tq.tenantQueue('sla-jobs', 't1')
    fake.state.redis[0]!.quit.mockRejectedValueOnce(new Error('already closed'))
    await tq.closeTenantQueues()
    expect(fake.state.redis[0]!.disconnect).toHaveBeenCalled()
  })

  it('a producer that does not close is reported, after the others are closed', async () => {
    const a = tq.tenantQueue('sla-jobs', 't1') as unknown as InstanceType<typeof fake.Queue>
    const b = tq.tenantQueue('sla-jobs', 't2') as unknown as InstanceType<typeof fake.Queue>
    a.close.mockRejectedValueOnce(new Error('stuck'))
    await expect(tq.closeTenantQueues()).rejects.toThrow('1 queue(s) did not close: sla-jobs@t1: stuck')
    expect(b.close).toHaveBeenCalled()
  })
})

describe('a pool of workers, one per tenant', () => {
  it('gives each tenant its own worker on <base>@<tenant>, with the options of the base', async () => {
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => 'ok', { concurrency: 3 })
    await pool.add('t1')
    await pool.add('t2')
    await pool.add('t1')   // idempotent
    expect(fake.state.workers.map((w) => w.name)).toEqual(['sla-jobs@t1', 'sla-jobs@t2'])
    expect(fake.state.workers[0]!.opts).toMatchObject({ concurrency: 3, connection: { host: 'redis.test', port: 6390 } })
    expect(pool.tenants()).toEqual(['t1', 't2'])
    expect(pool.name).toBe('sla-jobs')
    expect(pool.workerOf('t2')).toBe(fake.state.workers[1])
    expect(pool.workerOf('nobody')).toBeUndefined()
  })

  it('works a job of its tenant, and refuses a job of another tenant or of none', async () => {
    const processor = vi.fn(async () => 'done')
    const pool = new tq.TenantWorkerPool('sla-jobs', processor)
    await pool.add('t1')
    const run = fake.state.workers[0]!.processor
    await expect(run(job({ tenantId: 't1' }), 'token')).resolves.toBe('done')
    expect(processor).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: 't1' } }), 'token')
    await expect(run(job({ tenantId: 't2' }, 'sla.breach', 'b1'))).rejects.toThrow('[sla-jobs@t1] job sla.breach (b1) belongs to tenant t2, not to t1: refused')
    await expect(run(job({}, 'sweep', 's1'))).rejects.toThrow('[sla-jobs@t1] job sweep (s1) names no tenant')
    expect(processor).toHaveBeenCalledTimes(1)
  })

  it('reports errors, readiness and failures to the host hooks, and to the pool\'s own onFailed', async () => {
    const seen: string[] = []
    tq.setTenantQueueHooks({
      workerError: (b, t, e) => { seen.push(`error ${b}@${t} ${e.message}`) },
      workerReady: (b, t) => { seen.push(`ready ${b}@${t}`) },
      jobFailed: (b, t, j, e) => { seen.push(`failed ${b}@${t} ${String(j?.id)} ${e.message}`) },
    })
    const onFailed = vi.fn()
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => undefined, { onFailed })
    await pool.add('t1')
    const w = fake.state.workers[0]!
    w.handlers['error']!(new Error('blip'))
    w.handlers['ready']!()
    const failedJob = job({ tenantId: 't1' }, 'x', 'j9')
    w.handlers['failed']!(failedJob, new Error('boom'))
    expect(seen).toEqual(['error sla-jobs@t1 blip', 'ready sla-jobs@t1', 'failed sla-jobs@t1 j9 boom'])
    expect(onFailed).toHaveBeenCalledWith(failedJob, expect.any(Error), 't1')
  })

  it('registers the tenant\'s recurring jobs once, and again after a failed attempt', async () => {
    const schedule = vi.fn(async () => {})
    schedule.mockRejectedValueOnce(new Error('redis down'))
    const pool = new tq.TenantWorkerPool('workflow-jobs', async () => undefined, { schedule })
    await expect(pool.add('t1')).rejects.toThrow('redis down')
    expect(pool.tenants()).toEqual(['t1'])   // the worker is there; only the schedule is owed
    await pool.add('t1')
    await pool.add('t1')
    expect(schedule).toHaveBeenCalledTimes(2)
    expect(schedule).toHaveBeenLastCalledWith(tq.tenantQueue('workflow-jobs', 't1'), 't1')
  })

  it('remove closes the tenant\'s worker; close closes them all and the pool refuses new tenants', async () => {
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    await pool.add('t1'); await pool.add('t2')
    await pool.remove('t1')
    expect(fake.state.workers[0]!.close).toHaveBeenCalled()
    expect(pool.tenants()).toEqual(['t2'])
    await pool.remove('nobody')
    await pool.close()
    expect(fake.state.workers[1]!.close).toHaveBeenCalled()
    expect(tq.tenantWorkerPools()).not.toContain(pool)
    await expect(pool.add('t3')).rejects.toThrow('pool sla-jobs is closed')
  })

  it('a base name that is not one is refused at construction', () => {
    expect(() => new tq.TenantWorkerPool('Bad Name', async () => undefined)).toThrow('is not a queue base name')
  })

  /*
   * THE PROCESS LIMIT (23 Sep 2026): with one queue per tenant, work bound by
   * the process's own CPU (the local embedding model) or fired for every
   * tenant at the same instant (the hourly and nightly scans) would run once
   * per tenant, all at once. With a limit it takes turns, as it did when the
   * tenants shared one queue.
   */
  it('processLimit: the jobs of different tenants take turns in this process, in arrival order', async () => {
    const started: string[] = []
    const release = new Map<string, () => void>()
    const processor = vi.fn((j: Job) => new Promise<string>((resolve) => {
      const t = (j.data as { tenantId: string }).tenantId
      started.push(t)
      release.set(t, () => resolve(`done ${t}`))
    }))
    const pool = new tq.TenantWorkerPool('embeddings', processor, { concurrency: 1, processLimit: 1 })
    await pool.add('t1'); await pool.add('t2'); await pool.add('t3')
    expect(fake.state.workers[0]!.opts).not.toHaveProperty('processLimit')
    const [w1, w2, w3] = fake.state.workers
    const r1 = w1!.processor(job({ tenantId: 't1' }))
    const r2 = w2!.processor(job({ tenantId: 't2' }))
    const r3 = w3!.processor(job({ tenantId: 't3' }))
    await vi.waitFor(() => expect(started).toEqual(['t1']))
    release.get('t1')!()
    await expect(r1).resolves.toBe('done t1')
    await vi.waitFor(() => expect(started).toEqual(['t1', 't2']))
    release.get('t2')!()
    await vi.waitFor(() => expect(started).toEqual(['t1', 't2', 't3']))
    release.get('t3')!()
    await expect(Promise.all([r2, r3])).resolves.toEqual(['done t2', 'done t3'])
  })

  it('processLimit: a job that fails hands its turn on; a refused job never takes one', async () => {
    let calls = 0
    const pool = new tq.TenantWorkerPool('anomaly-scanner', async () => { calls += 1; if (calls === 1) throw new Error('scan failed'); return 'ok' }, { processLimit: 1 })
    await pool.add('t1'); await pool.add('t2')
    const [w1, w2] = fake.state.workers
    await expect(w1!.processor(job({ tenantId: 't2' }))).rejects.toThrow('refused')
    await expect(w1!.processor(job({ tenantId: 't1' }))).rejects.toThrow('scan failed')
    await expect(w2!.processor(job({ tenantId: 't2' }))).resolves.toBe('ok')
  })

  it('processLimit: a limit that is not a whole number of at least 1 is refused at construction', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => new tq.TenantWorkerPool('embeddings', async () => undefined, { processLimit: bad }), String(bad)).toThrow('processLimit of embeddings must be a whole number of at least 1')
    }
  })
})

describe('reconciling the pools with the tenants', () => {
  const T = (id: string, suspended = false) => ({ id, suspended })

  it('gives every pool a worker for every tenant, and resumes their queues once', async () => {
    const a = new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    const b = new tq.TenantWorkerPool('workflow-jobs', async () => undefined)
    const out = await tq.reconcileTenantPools([T('t1'), T('t2')])
    expect(a.tenants()).toEqual(['t1', 't2'])
    expect(b.tenants()).toEqual(['t1', 't2'])
    expect(out.added.sort()).toEqual(['sla-jobs@t1', 'sla-jobs@t2', 'workflow-jobs@t1', 'workflow-jobs@t2'])
    expect(out.failures).toEqual([])
    const q = tq.tenantQueue('sla-jobs', 't1') as unknown as InstanceType<typeof fake.Queue>
    expect(q.resume).toHaveBeenCalledTimes(1)
    expect(out.resumed).toEqual([])   // it was not paused: nothing to report

    const again = await tq.reconcileTenantPools([T('t1'), T('t2')])
    expect(again.added).toEqual([])
    expect(q.resume).toHaveBeenCalledTimes(1)   // applied on change only
  })

  it('pauses the queues of a suspended tenant, and resumes them when it is resumed', async () => {
    new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    await tq.reconcileTenantPools([T('t1')])
    const q = tq.tenantQueue('sla-jobs', 't1') as unknown as InstanceType<typeof fake.Queue>
    const paused = await tq.reconcileTenantPools([T('t1', true)])
    expect(paused.paused).toEqual(['sla-jobs@t1'])
    expect(q.pause).toHaveBeenCalledTimes(1)
    await tq.reconcileTenantPools([T('t1', true)])
    expect(q.pause).toHaveBeenCalledTimes(1)
    const resumed = await tq.reconcileTenantPools([T('t1')])
    expect(resumed.resumed).toEqual(['sla-jobs@t1'])
  })

  it('closes the workers and the producers of a tenant that no longer exists', async () => {
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    await tq.reconcileTenantPools([T('t1'), T('gone')])
    const gone = tq.tenantQueue('sla-jobs', 'gone') as unknown as InstanceType<typeof fake.Queue>
    const out = await tq.reconcileTenantPools([T('t1')])
    expect(out.removed).toEqual(['sla-jobs@gone'])
    expect(pool.tenants()).toEqual(['t1'])
    expect(gone.close).toHaveBeenCalled()
    expect(tq.openTenantQueues().map((q) => q.name)).toEqual(['sla-jobs@t1'])
  })

  it('a reconciliation that fails outright does not jam the ones after it', async () => {
    const pool = new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    await expect(tq.reconcileTenantPools(null as never)).rejects.toThrow()
    await tq.reconcileTenantPools([T('t1')])
    expect(pool.tenants()).toEqual(['t1'])
  })

  it('a failure on one queue is reported and does not stop the others; it is retried next time', async () => {
    new tq.TenantWorkerPool('sla-jobs', async () => undefined)
    fake.state.failPause = 'sla-jobs@t1'
    const out = await tq.reconcileTenantPools([T('t1', true), T('t2', true)])
    expect(out.failures).toEqual([{ queue: 'sla-jobs@t1', error: 'redis down' }])
    expect(out.paused).toEqual(['sla-jobs@t2'])
    fake.state.failPause = null
    const retry = await tq.reconcileTenantPools([T('t1', true), T('t2', true)])
    expect(retry.paused).toEqual(['sla-jobs@t1'])
  })

  it('a schedule that fails is a failure of that queue, and the tenant is still served', async () => {
    const pool = new tq.TenantWorkerPool('workflow-jobs', async () => undefined, { schedule: async () => { throw new Error('no scheduler') } })
    const out = await tq.reconcileTenantPools([T('t1')])
    expect(out.failures).toEqual([{ queue: 'workflow-jobs@t1', error: 'no scheduler' }])
    expect(pool.tenants()).toEqual(['t1'])
  })

  it('two reconciliations never run over each other', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    new tq.TenantWorkerPool('workflow-jobs', async () => undefined, {
      schedule: async (_q, t) => { order.push(`start ${t}`); if (t === 't1') await gate; order.push(`end ${t}`) },
    })
    const first = tq.reconcileTenantPools([T('t1')])
    const second = tq.reconcileTenantPools([T('t1'), T('t2')])
    await Promise.resolve()
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start t1', 'end t1', 'start t2', 'end t2'])
  })
})

describe('removing a purged tenant\'s queues', () => {
  it('obliterates each base\'s queue with force and closes its producer', async () => {
    await tq.obliterateTenantQueues('gone', ['sla-jobs', 'workflow-jobs'])
    const names = fake.state.queues.map((q) => q.name)
    expect(names).toEqual(['sla-jobs@gone', 'workflow-jobs@gone'])
    for (const q of fake.state.queues) {
      expect(q.obliterate).toHaveBeenCalledWith({ force: true })
      expect(q.close).toHaveBeenCalled()
    }
    expect(tq.openTenantQueues()).toHaveLength(0)
  })

  it('a queue that cannot be removed is reported after trying the others', async () => {
    fake.state.failObliterate = 'sla-jobs@gone'
    await expect(tq.obliterateTenantQueues('gone', ['sla-jobs', 'workflow-jobs']))
      .rejects.toThrow('the queues of tenant gone were not all removed: sla-jobs@gone: obliterate failed')
    expect(fake.state.queues.find((q) => q.name === 'workflow-jobs@gone')!.obliterate).toHaveBeenCalled()
  })
})
