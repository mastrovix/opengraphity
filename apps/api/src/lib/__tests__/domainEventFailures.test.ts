/**
 * lib/domainEventFailures.ts (revisione 2 · D2.2): il gancio `onEventFailed`
 * di packages/events è cablato a `events_failed_total{queue,type}`.
 */
import { describe, it, expect, vi } from 'vitest'

type Listener = (info: { queue: string; eventType: string; eventId?: string; attempts: number; error: Error }) => void
let listener: Listener | null = null
const off = vi.fn()
vi.mock('@opengraphity/events', () => ({
  onEventFailed: vi.fn((cb: Listener) => { listener = cb; return off }),
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }))

const { wireDomainEventFailureMetric } = await import('../domainEventFailures.js')
const { eventsFailedTotal } = await import('../../middleware/metrics.js')

describe('wireDomainEventFailureMetric', () => {
  it('registra il listener e ogni evento esaurito incrementa events_failed_total con coda e tipo', () => {
    const unwire = wireDomainEventFailureMetric()
    expect(listener).not.toBeNull()
    listener!({ queue: 'service-impact-consumer', eventType: 'ci.health_changed', eventId: 'e1', attempts: 4, error: new Error('neo4j down') })
    listener!({ queue: 'service-impact-consumer', eventType: 'ci.health_changed', eventId: 'e2', attempts: 4, error: new Error('neo4j down') })
    listener!({ queue: 'notification-service', eventType: 'incident.created', eventId: 'e3', attempts: 4, error: new Error('smtp') })
    expect(eventsFailedTotal.snapshot()).toEqual(expect.arrayContaining([
      { labels: { queue: 'service-impact-consumer', type: 'ci.health_changed' }, value: 2 },
      { labels: { queue: 'notification-service', type: 'incident.created' }, value: 1 },
    ]))
    expect(eventsFailedTotal.collect()).toContain('# TYPE events_failed_total counter')
    unwire()
    expect(off).toHaveBeenCalled()
  })
})
