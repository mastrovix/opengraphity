/**
 * consumers/serviceImpactConsumer.ts — su `ci.health_changed` accoda una
 * valutazione SOLO per le mappe del tenant che includono il CI (non in
 * pausa); su `event.storm_ended` (revisione 2 · D6.4) rivaluta le mappe che la
 * tempesta aveva sospeso; ignora gli altri eventi; un payload senza ci_id (o
 * senza source_id) è un errore visibile, non un ritorno silenzioso; una coda
 * non disponibile propaga.
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
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })), runQuery: vi.fn().mockResolvedValue([]) }))
vi.mock('../../jobs/serviceImpactWorker.js', () => ({ enqueueServiceMapEvaluation: vi.fn().mockResolvedValue(undefined) }))

const { ServiceImpactConsumer, SERVICE_IMPACT_CONSUMER_QUEUE, MAPS_TOUCHED_BY_SOURCE_CYPHER } = await import('../serviceImpactConsumer.js')
const { runQuery } = await import('@opengraphity/neo4j')
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

  it('D6.4: event.storm_ended → rivaluta le mappe che includono un CI con allarmi di quella sorgente (trigger maintenance)', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ id: 'map-a' }, { id: 'map-b' }] as never)
    await consumer.process(event('event.storm_ended', { source_id: 'hook-1', source_name: 'Zabbix prod' }))
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toBe(MAPS_TOUCHED_BY_SOURCE_CYPHER)
    expect(cypher).toContain('MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId})-[:RAISED_ON]->(ci {tenant_id: $tenantId})')
    expect(cypher).toContain("WHERE m.status <> 'paused'")
    expect(params).toEqual({ tenantId: 't1', sourceId: 'hook-1' })
    expect(vi.mocked(enqueueServiceMapEvaluation).mock.calls).toEqual([['t1', 'map-a', 'maintenance'], ['t1', 'map-b', 'maintenance']])
    expect(findMapsIncludingCI).not.toHaveBeenCalled()
  })

  it('D6.4: nessuna mappa coinvolta → nessun job; storm_ended senza source_id → errore esplicito', async () => {
    await consumer.process(event('event.storm_ended', { source_id: 'hook-2' }))
    expect(enqueueServiceMapEvaluation).not.toHaveBeenCalled()
    await expect(consumer.process(event('event.storm_ended', { source_name: 'x' }))).rejects.toThrow(/event\.storm_ended evt-1 has no source_id \(tenant t1\)/)
  })

  it('coda non disponibile → l\'errore propaga (BaseConsumer ritenta), nessun fallback', async () => {
    vi.mocked(findMapsIncludingCI).mockResolvedValueOnce([{ id: 'map-a', status: 'active' }])
    vi.mocked(enqueueServiceMapEvaluation).mockRejectedValueOnce(new Error('Redis down'))
    await expect(consumer.process(event('ci.health_changed', { ci_id: 'ci-1' }))).rejects.toThrow('Redis down')
  })
})
