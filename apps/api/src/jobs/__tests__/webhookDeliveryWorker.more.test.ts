/**
 * Outbound webhook delivery: the processor and the enqueue path.
 *
 * Why these behaviours matter to a customer:
 *  - the job carries only a POINTER: url, headers and the HMAC secret are
 *    re-read from the tenant-scoped node at delivery time. If this regresses,
 *    a rotated secret keeps signing with the old one, or (worse) a webhook
 *    id from another tenant could be delivered with its config;
 *  - a deleted/disabled webhook or an unsafe URL must FAIL the job, not
 *    complete it: a "completed" job reads as healthy while nothing was sent;
 *  - the receiver verifies `X-Webhook-Signature`: a wrong HMAC means every
 *    delivery is rejected on their side;
 *  - send/error counters on the node are what the admin page shows; a non-2xx
 *    response must count as an error AND be retried;
 *  - enqueueing must not swallow errors (events would be lost silently) and
 *    must honour `retry_on_failure` and the per-event job id (de-duplication).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'

const runQuery = vi.fn()
const close = vi.fn(async () => undefined)
const getSession = vi.fn(() => ({ close }))
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: (...a: unknown[]) => runQuery(...a),
  getSession: (...a: unknown[]) => getSession(...(a as [])),
}))

vi.mock('../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const queueAdd = vi.fn(async () => undefined)
const getQueue = vi.fn(() => ({ add: queueAdd }))
const createWorker = vi.fn((..._a: unknown[]) => ({ worker: true }))
vi.mock('../../lib/bullmq.js', () => ({
  getQueue: (...a: unknown[]) => getQueue(...(a as [])),
  createWorker: (...a: unknown[]) => createWorker(...a),
}))

const assertSafeOutboundUrl = vi.fn(async (u: string) => new URL(u))
vi.mock('../../lib/safeUrl.js', () => ({
  assertSafeOutboundUrl: (u: string) => assertSafeOutboundUrl(u),
  loggableUrl: (u: string) => u,
}))

const {
  startWebhookDeliveryWorker, enqueueOutboundWebhooks, WEBHOOK_DELIVERY_QUEUE,
} = await import('../webhookDeliveryWorker.js')

type Processor = (job: unknown) => Promise<void>
interface WorkerOpts { concurrency: number; onFailed: (job: unknown, err: Error) => void }

/** Starts the worker and hands back the processor BullMQ would call. */
function processor(): { run: Processor; opts: WorkerOpts } {
  startWebhookDeliveryWorker()
  const call = createWorker.mock.calls.at(-1)!
  return { run: call[1] as Processor, opts: call[2] as WorkerOpts }
}

const job = (over: Record<string, unknown> = {}) => ({
  attemptsMade: 0,
  data: { webhookId: 'wh-1', tenantId: 't1', eventType: 'incident.created', eventId: 'ev-1', body: '{"a":1}', ...over },
})

function webhookRow(props: Record<string, unknown>) {
  return [{ props: { id: 'wh-1', url: 'https://hooks.example.com/x', enabled: true, ...props } }]
}

const cancel = vi.fn(async () => undefined)
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  runQuery.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('processDelivery — the node is the truth', () => {
  it('re-reads the webhook scoped to the job tenant, signs the body with the stored secret and records the success', async () => {
    runQuery
      .mockResolvedValueOnce(webhookRow({ secret: 's3cret', headers: '{"Authorization":"Bearer x"}', method: 'PUT' }))
      .mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204, body: { cancel } })

    await processor().run(job())

    // The read is tenant-scoped: a webhook id alone must never resolve across tenants.
    expect(runQuery.mock.calls[0]![2]).toEqual({ id: 'wh-1', tenantId: 't1' })
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://hooks.example.com/x')
    expect(init.method).toBe('PUT')
    expect(init.body).toBe('{"a":1}')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.headers['Authorization']).toBe('Bearer x')
    // The receiver recomputes this HMAC: it must be exactly sha256(secret, body).
    expect(init.headers['X-Webhook-Signature']).toBe(createHmac('sha256', 's3cret').update('{"a":1}').digest('hex'))
    // The response body is drained so the connection is released (C-29).
    expect(cancel).toHaveBeenCalled()
    const write = runQuery.mock.calls[1]!
    expect(write[1]).toContain('send_count')
    expect(write[2]).toMatchObject({ id: 'wh-1', tenantId: 't1', statusCode: 204 })
    // Every session opened is closed (read + write).
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('without a secret sends no signature, defaults to POST, and GET sends no body', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({ method: null })).mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: null })
    await processor().run(job())
    let init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> }
    expect(init.method).toBe('POST')
    expect(init.headers).not.toHaveProperty('X-Webhook-Signature')

    runQuery.mockResolvedValueOnce(webhookRow({ method: 'GET' })).mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: { cancel } })
    await processor().run(job())
    init = fetchMock.mock.calls[1]![1] as RequestInit & { headers: Record<string, string> }
    expect(init.body).toBeUndefined()
  })

  it('a failure while draining the response body does not turn a delivered webhook into a failure', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({})).mockResolvedValueOnce([])
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: { cancel: vi.fn(async () => { throw new Error('already locked') }) } })
    await expect(processor().run(job())).resolves.toBeUndefined()
    expect(runQuery.mock.calls[1]![1]).toContain('send_count')
  })

  it('a webhook deleted after enqueue fails the job instead of completing it', async () => {
    runQuery.mockResolvedValueOnce([])
    await expect(processor().run(job())).rejects.toThrow(/not found in tenant t1/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a disabled webhook fails the job and sends nothing', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({ enabled: false }))
    await expect(processor().run(job())).rejects.toThrow(/is disabled/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an unsafe URL (SSRF guard) fails the job visibly and is never fetched', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({ url: 'http://169.254.169.254/' }))
    assertSafeOutboundUrl.mockRejectedValueOnce(new Error('private address'))
    await expect(processor().run(job())).rejects.toThrow('private address')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('corrupt stored headers fail loud rather than delivering without the auth header', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({ headers: '{not json' }))
    await expect(processor().run(job())).rejects.toThrow(/Corrupt headers JSON/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a non-2xx response counts as sent AND as an error, and rethrows so BullMQ retries', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({})).mockResolvedValue([])
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, body: { cancel } })
    await expect(processor().run(job())).rejects.toThrow('HTTP 503')
    const cyphers = runQuery.mock.calls.map((c) => c[1] as string)
    expect(cyphers[1]).toContain('send_count')
    expect(cyphers[2]).toContain('error_count')
    expect(runQuery.mock.calls[2]![2]).toMatchObject({ tenantId: 't1', error: 'HTTP 503' })
  })

  it('a network failure records the error message; a non-Error rejection is stringified', async () => {
    runQuery.mockResolvedValueOnce(webhookRow({})).mockResolvedValue([])
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(processor().run(job())).rejects.toThrow('ECONNREFUSED')
    expect(runQuery.mock.calls[1]![2]).toMatchObject({ error: 'ECONNREFUSED' })

    runQuery.mockReset()
    runQuery.mockResolvedValueOnce(webhookRow({})).mockResolvedValue([])
    fetchMock.mockRejectedValueOnce('socket hang up')
    await expect(processor().run(job())).rejects.toBe('socket hang up')
    expect(runQuery.mock.calls[1]![2]).toMatchObject({ error: 'socket hang up' })
  })

  it('aborts a receiver that never answers after 10 seconds', async () => {
    vi.useFakeTimers()
    runQuery.mockResolvedValueOnce(webhookRow({})).mockResolvedValue([])
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => rej(new Error('aborted')))
    }))
    const p = processor().run(job())
    const settled = expect(p).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
  })
})

describe('startWebhookDeliveryWorker', () => {
  it('opens the producer queue and a worker on the delivery queue with bounded concurrency', () => {
    const { opts } = processor()
    expect(getQueue).toHaveBeenCalledWith(WEBHOOK_DELIVERY_QUEUE)
    expect(createWorker.mock.calls[0]![0]).toBe('webhook-delivery')
    expect(opts.concurrency).toBe(10)
    // The failure hook only logs: it must tolerate a missing job (stalled job cleanup).
    expect(() => opts.onFailed(undefined, new Error('x'))).not.toThrow()
    expect(() => opts.onFailed({ id: 'j', data: { webhookId: 'w' }, attemptsMade: 5 }, new Error('x'))).not.toThrow()
  })
})

describe('enqueueOutboundWebhooks', () => {
  it('does nothing when no enabled webhook subscribes to the event (and closes the session)', async () => {
    runQuery.mockResolvedValueOnce([])
    await enqueueOutboundWebhooks('t1', 'incident.created', { id: 'i1' })
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't1', eventType: 'incident.created' })
    expect(queueAdd).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('enqueues one job per webhook with the rendered body, retry policy and deterministic id', async () => {
    runQuery.mockResolvedValueOnce([
      { props: { id: 'w1', payload_template: '{"t":"{{title}}","ty":"{{event_type}}"}' } },
      { props: { id: 'w2', retry_on_failure: false } },
    ])
    await enqueueOutboundWebhooks('t1', 'incident.created', { id: 'i1', title: 'Disk "full"' }, 'ev-9')

    expect(queueAdd).toHaveBeenCalledTimes(2)
    const [name1, data1, opts1] = queueAdd.mock.calls[0]! as unknown as [string, Record<string, string>, Record<string, unknown>]
    expect(name1).toBe('deliver')
    expect(JSON.parse(data1['body']!)).toEqual({ t: 'Disk "full"', ty: 'incident.created' })
    expect(data1).toMatchObject({ webhookId: 'w1', tenantId: 't1', eventType: 'incident.created', eventId: 'ev-9' })
    expect(opts1).toMatchObject({ jobId: 'wh-w1-ev-9', attempts: 5 })

    const [, data2, opts2] = queueAdd.mock.calls[1]! as unknown as [string, Record<string, string>, Record<string, unknown>]
    // No template: the default envelope carries the entity and the tenant.
    expect(JSON.parse(data2['body']!)).toMatchObject({ event_type: 'incident.created', entity: { id: 'i1' }, tenant_id: 't1' })
    // retry_on_failure = false means exactly one attempt.
    expect(opts2).toMatchObject({ jobId: 'wh-w2-ev-9', attempts: 1 })
  })

  it('without an event id the job id doubles as the event id (payload hash)', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'w1' } }])
    await enqueueOutboundWebhooks('t1', 'incident.created', { id: 'i1' })
    const [, data, opts] = queueAdd.mock.calls[0]! as unknown as [string, Record<string, string>, { jobId: string }]
    expect(opts.jobId).toMatch(/^wh-w1-[0-9a-f]{32}$/)
    expect(data['eventId']).toBe(opts.jobId)
  })

  it('a failure to enqueue propagates (events must not be lost silently) and still closes the session', async () => {
    runQuery.mockResolvedValueOnce([{ props: { id: 'w1' } }])
    queueAdd.mockRejectedValueOnce(new Error('redis down'))
    await expect(enqueueOutboundWebhooks('t1', 'incident.created', { id: 'i1' })).rejects.toThrow('redis down')
    expect(close).toHaveBeenCalled()
  })
})
