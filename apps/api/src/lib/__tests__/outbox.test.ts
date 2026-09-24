/**
 * The outbox of the domain events in the graph (wave 7 · B2, lib/outbox.ts):
 *  - an event is written once, with its tenant, as pending (MERGE on its id:
 *    the one recorded in its change's transaction is not written again);
 *  - the webhooks are delivered only for the events that asked for them;
 *  - the repeater sends again the tenant's pending events older than the
 *    grace period, oldest first, marks each one, notes the ones that failed
 *    without holding the others, and sets the metric;
 *  - the purge deletes what was sent a week ago, in the maintenance scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const runs: Array<{ cypher: string; params: Record<string, unknown> }> = []
let answers: Array<(cypher: string) => unknown[] | undefined> = []
const runQuery = vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown> = {}) => {
  runs.push({ cypher, params })
  for (const a of answers) { const r = a(cypher); if (r) return r }
  return []
})
const close = vi.fn(async () => undefined)
const scopes: unknown[] = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQuery: (...a: unknown[]) => runQuery(...(a as [unknown, string, Record<string, unknown>])),
  toNumber: (v: unknown) => Number(v ?? 0),
  MAINTENANCE_SCOPE: { name: 'maintenance' },
  runInQueryScope: vi.fn(async (scope: unknown, fn: () => Promise<unknown>) => { scopes.push(scope); return fn() }),
}))
const sendToConsumers = vi.fn(async () => undefined)
const registerEventOutbox = vi.fn()
vi.mock('@opengraphity/events', () => ({
  sendToConsumers: (...a: unknown[]) => sendToConsumers(...a),
  registerEventOutbox: (...a: unknown[]) => registerEventOutbox(...a),
}))
const enqueueOutboundWebhooks = vi.fn(async () => undefined)
vi.mock('../../jobs/webhookDeliveryWorker.js', () => ({ enqueueOutboundWebhooks: (...a: unknown[]) => enqueueOutboundWebhooks(...a) }))
const pendingSet = vi.fn()
const resentInc = vi.fn()
vi.mock('../../middleware/metrics.js', () => ({ outboxPendingEvents: { set: (...a: unknown[]) => pendingSet(...a) }, outboxResentTotal: { inc: (...a: unknown[]) => resentInc(...a) } }))
const logError = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn() }) } }))

const { neo4jEventOutbox, installEventOutbox, resendPendingEvents, purgeSentEvents, OUTBOX_RESEND_AFTER_MS, OUTBOX_KEEP_SENT_DAYS } = await import('../outbox.js')

const event = (id = 'evt-1'): DomainEvent<{ id: string }> => ({
  id, type: 'incident.created', tenant_id: 't1', timestamp: '2026-09-24T10:00:00.000Z', correlation_id: 'c', actor_id: 'u1', payload: { id: 'inc-1' },
})
const NOW = Date.parse('2026-09-24T10:05:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  runs.length = 0
  answers = []
  scopes.length = 0
})

describe('the store', () => {
  it('records an event once, with its tenant, pending, the whole event and whether it wants webhooks', async () => {
    await neo4jEventOutbox.record(event(), { webhooks: true })
    const [w] = runs
    expect(w!.cypher).toContain('MERGE (o:OutboxEvent {id: $id, tenant_id: $tenantId})')
    expect(w!.cypher).toContain('ON CREATE SET')
    expect(w!.cypher).toContain('o.pending = true')
    expect(w!.params).toMatchObject({ id: 'evt-1', tenantId: 't1', type: 'incident.created', webhooks: true, event: JSON.stringify(event()) })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('records inside the caller\'s transaction with the same statement', async () => {
    const tx = { run: vi.fn(async () => undefined) }
    await neo4jEventOutbox.recordIn(tx, event(), {})
    expect(tx.run.mock.calls[0]![0]).toContain('MERGE (o:OutboxEvent {id: $id, tenant_id: $tenantId})')
    expect(tx.run.mock.calls[0]![1]).toMatchObject({ id: 'evt-1', webhooks: false })
  })

  it('marks an event sent: no longer pending, with the time', async () => {
    await neo4jEventOutbox.markSent(event())
    expect(runs[0]!.cypher).toMatch(/REMOVE o\.pending\s+SET o\.sent_at = \$now/)
    expect(runs[0]!.params).toMatchObject({ id: 'evt-1', tenantId: 't1' })
  })

  it('delivers the webhooks, keyed by the event id, only when asked', async () => {
    await neo4jEventOutbox.deliverExtras(event(), {})
    expect(enqueueOutboundWebhooks).not.toHaveBeenCalled()
    await neo4jEventOutbox.deliverExtras(event(), { webhooks: true })
    expect(enqueueOutboundWebhooks).toHaveBeenCalledWith('t1', 'incident.created', { id: 'inc-1' }, 'evt-1')
  })

  it('installEventOutbox registers this store', () => {
    installEventOutbox()
    expect(registerEventOutbox).toHaveBeenCalledWith(neo4jEventOutbox)
  })
})

describe('the repeater', () => {
  const pending = (rows: unknown[], left: number) => {
    answers = [
      (c) => (c.includes('RETURN o.id AS id') ? rows : undefined),
      (c) => (c.includes('RETURN count(o) AS n') ? [{ n: left }] : undefined),
    ]
  }

  it('sends again the tenant\'s pending events older than the grace period, oldest first, and marks each', async () => {
    pending([{ id: 'evt-1', event: JSON.stringify(event('evt-1')), webhooks: true }, { id: 'evt-2', event: JSON.stringify(event('evt-2')), webhooks: false }], 0)
    const summary = await resendPendingEvents('t1', NOW)
    expect(summary).toEqual({ sent: 2, failed: 0, pending: 0 })
    const read = runs.find((r) => r.cypher.includes('RETURN o.id AS id'))!
    expect(read.cypher).toContain('MATCH (o:OutboxEvent {tenant_id: $tenantId, pending: true})')
    expect(read.cypher).toContain('ORDER BY o.created_at')
    expect(read.params).toMatchObject({ tenantId: 't1', before: new Date(NOW - OUTBOX_RESEND_AFTER_MS).toISOString(), limit: 200 })
    expect(sendToConsumers.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['evt-1', 'evt-2'])
    expect(enqueueOutboundWebhooks).toHaveBeenCalledTimes(1)
    expect(runs.filter((r) => r.cypher.includes('REMOVE o.pending')).map((r) => r.params['id'])).toEqual(['evt-1', 'evt-2'])
    expect(resentInc).toHaveBeenCalledWith({ tenant: 't1' }, 2)
    expect(pendingSet).toHaveBeenCalledWith({ tenant: 't1' }, 0)
  })

  it('one that fails is noted on its node and does not hold the others; the metric counts what is left', async () => {
    pending([{ id: 'evt-1', event: JSON.stringify(event('evt-1')), webhooks: false }, { id: 'evt-2', event: JSON.stringify(event('evt-2')), webhooks: false }], 1)
    sendToConsumers.mockRejectedValueOnce(new Error('redis down'))
    const summary = await resendPendingEvents('t1', NOW)
    expect(summary).toEqual({ sent: 1, failed: 1, pending: 1 })
    const noted = runs.find((r) => r.cypher.includes('o.last_error = $message'))!
    expect(noted.params).toMatchObject({ id: 'evt-1', tenantId: 't1', message: 'redis down' })
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-1' }), expect.stringContaining('could not be sent again'))
    expect(pendingSet).toHaveBeenCalledWith({ tenant: 't1' }, 1)
  })

  it('nothing pending: nothing sent, the metric at zero', async () => {
    pending([], 0)
    await expect(resendPendingEvents('t1', NOW)).resolves.toEqual({ sent: 0, failed: 0, pending: 0 })
    expect(sendToConsumers).not.toHaveBeenCalled()
    expect(resentInc).not.toHaveBeenCalled()
  })
})

describe('the purge', () => {
  it('deletes what was sent more than a week ago, a thousand per transaction, in the maintenance scope', async () => {
    answers = [(c) => (c.includes('DETACH DELETE') ? [{ n: 42 }] : undefined)]
    await expect(purgeSentEvents(NOW)).resolves.toBe(42)
    const [p] = runs
    expect(p!.cypher).toContain('WHERE o.sent_at < $before')
    expect(p!.cypher).toContain('IN TRANSACTIONS OF 1000 ROWS')
    expect(p!.params).toEqual({ before: new Date(NOW - OUTBOX_KEEP_SENT_DAYS * 86_400_000).toISOString() })
    expect(scopes).toEqual([{ name: 'maintenance' }])
  })
})
