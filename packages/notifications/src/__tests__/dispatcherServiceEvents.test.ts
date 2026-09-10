/**
 * Dispatcher — eventi dei Servizi monitorati (ondata 3).
 *
 * `service.health_changed` e `service.incident_opened` hanno un payload senza
 * `title` e senza `entity_type`/`entity_id`: senza una voce esplicita nella
 * mappa dei messaggi la notifica arriverebbe con il corpo VUOTO (fallback
 * silenzioso). Qui si pinna il testo reso e il rifiuto di un payload
 * incompleto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

let ruleRow: Record<string, unknown> | null = null

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string) => {
          if (cypher.includes('NotificationRule')) return { records: ruleRow ? [{ get: () => ({ properties: ruleRow }) }] : [] }
          return { records: [] }
        },
      }),
    close: async () => {},
  }),
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
}))
vi.mock('../email.js', () => ({ sendEmail: vi.fn(async () => {}) }))

const { NotificationDispatcher, invalidateRuleCache } = await import('../dispatcher.js')
const { sseManager } = await import('../sse.js')

const sent = vi.spyOn(sseManager, 'sendToTenant').mockImplementation(() => {})

function event(type: string, payload: Record<string, unknown>): DomainEvent<unknown> {
  return { id: 'e1', type, tenant_id: 't1', timestamp: '2026-09-10T10:00:00.000Z', correlation_id: 'c', actor_id: 'monitoring', payload }
}

beforeEach(() => {
  sent.mockClear()
  invalidateRuleCache('t1')
})

describe('notifiche dei Servizi monitorati', () => {
  it('service.health_changed → titolo dalla regola, corpo "<servizio> — <nuova salute>", entità del servizio', async () => {
    ruleRow = { id: 'r1', enabled: true, severity_override: 'warning', title_key: 'notification.service.health_changed.title', channels: ['in_app'], target: 'all' }
    await new NotificationDispatcher().process(event('service.health_changed', {
      id: 'map-1', map_id: 'map-1', service_id: 'ba-1', name: 'Enterprise Billing',
      previous_health: 'operational', new_health: 'down', impact_score: 62,
    }))
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent.mock.calls[0]![1]).toMatchObject({
      type: 'service.health_changed', title: 'notification.service.health_changed.title',
      message: 'Enterprise Billing — down', severity: 'warning', entity_id: 'map-1', entity_type: 'service',
    })
  })

  it('service.incident_opened → corpo "<servizio> — <salute> (<numero incident>)"', async () => {
    ruleRow = { id: 'r2', enabled: true, severity_override: 'error', title_key: 'notification.service.incident_opened.title', channels: ['in_app'], target: 'all' }
    await new NotificationDispatcher().process(event('service.incident_opened', {
      id: 'map-1', map_id: 'map-1', service_id: 'ba-1', name: 'Enterprise Billing',
      incident_id: 'inc-9', incident_number: 'INC00000099', health: 'down', impact_score: 62,
    }))
    expect(sent.mock.calls[0]![1]).toMatchObject({
      message: 'Enterprise Billing — down (INC00000099)', severity: 'error', entity_id: 'map-1', entity_type: 'service',
    })
  })

  it('payload incompleto → errore esplicito (mai una notifica con il corpo vuoto)', async () => {
    ruleRow = { id: 'r1', enabled: true, severity_override: 'warning', title_key: 'k', channels: ['in_app'], target: 'all' }
    await expect(new NotificationDispatcher().process(event('service.health_changed', { id: 'map-1', map_id: 'map-1' })))
      .rejects.toThrow(/service\.health_changed payload has no "name"/)
    expect(sent).not.toHaveBeenCalled()
  })

  it('regola assente o spenta → nessuna notifica (nessun errore)', async () => {
    ruleRow = null
    await new NotificationDispatcher().process(event('service.incident_opened', { id: 'map-1' }))
    expect(sent).not.toHaveBeenCalled()
  })
})
