/**
 * consumers/serviceImpactConsumer.ts — su `ci.health_changed` accoda una
 * valutazione SOLO per le mappe del tenant che includono il CI (non in
 * pausa); ignora gli altri eventi; un payload senza ci_id è un errore
 * (visibile, non un ritorno silenzioso); una coda non disponibile propaga.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public readonly queueName: string) {} },
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../services/serviceImpact/engine.js', () => ({ findMapsIncludingCI: vi.fn() }))
vi.mock('../../jobs/serviceImpactWorker.js', () => ({ enqueueServiceMapEvaluation: vi.fn().mockResolvedValue(undefined) }))

const { ServiceImpactConsumer, SERVICE_IMPACT_CONSUMER_QUEUE } = await import('../serviceImpactConsumer.js')
const { findMapsIncludingCI } = await import('../../services/serviceImpact/engine.js')
const { enqueueServiceMapEvaluation } = await import('../../jobs/serviceImpactWorker.js')

const consumer = new ServiceImpactConsumer()

const event = (type: string, payload: Record<string, unknown>): DomainEvent<never> => ({
  id: 'evt-1', type, tenant_id: 't1', timestamp: '2026-09-10T10:00:00.000Z', correlation_id: 'corr-1', actor_id: 'monitoring', payload: payload as never,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findMapsIncludingCI).mockResolvedValue([])
})

describe('ServiceImpactConsumer', () => {
  it('la coda del consumer è `service-impact-consumer` (nel fan-out di packages/events/src/publisher.ts, pinnato dal suo test)', () => {
    expect(SERVICE_IMPACT_CONSUMER_QUEUE).toBe('service-impact-consumer')
    expect((consumer as unknown as { queueName: string }).queueName).toBe('service-impact-consumer')
  })

  it('ci.health_changed → cerca le mappe che includono il CI e accoda UNA valutazione per mappa (trigger ci_health)', async () => {
    vi.mocked(findMapsIncludingCI).mockResolvedValueOnce([{ id: 'map-a', status: 'active' }, { id: 'map-b', status: 'draft' }])
    await consumer.process(event('ci.health_changed', { id: 'ci-1', ci_id: 'ci-1', previous_health: 'operational', new_health: 'down' }))
    expect(findMapsIncludingCI).toHaveBeenCalledWith('t1', 'ci-1')
    expect(vi.mocked(enqueueServiceMapEvaluation).mock.calls).toEqual([['t1', 'map-a', 'ci_health'], ['t1', 'map-b', 'ci_health']])
  })

  it('CI in nessuna mappa → nessun job; usa payload.id se ci_id manca', async () => {
    await consumer.process(event('ci.health_changed', { id: 'ci-9', previous_health: null, new_health: 'down' }))
    expect(findMapsIncludingCI).toHaveBeenCalledWith('t1', 'ci-9')
    expect(enqueueServiceMapEvaluation).not.toHaveBeenCalled()
  })

  it('altri eventi → nessuna lettura; payload senza ci_id/id → errore esplicito', async () => {
    await consumer.process(event('event.received', { ci_id: 'ci-1' }))
    expect(findMapsIncludingCI).not.toHaveBeenCalled()
    await expect(consumer.process(event('ci.health_changed', { new_health: 'down' }))).rejects.toThrow(/ci\.health_changed evt-1 has no ci_id \(tenant t1\)/)
  })

  it('coda non disponibile → l\'errore propaga (BaseConsumer ritenta), nessun fallback', async () => {
    vi.mocked(findMapsIncludingCI).mockResolvedValueOnce([{ id: 'map-a', status: 'active' }])
    vi.mocked(enqueueServiceMapEvaluation).mockRejectedValueOnce(new Error('Redis down'))
    await expect(consumer.process(event('ci.health_changed', { ci_id: 'ci-1' }))).rejects.toThrow('Redis down')
  })
})
