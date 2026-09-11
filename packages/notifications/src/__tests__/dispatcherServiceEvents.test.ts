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

describe('notifiche dell\'Event Management (revisione 2, D3.2: mai un uuid come corpo)', () => {
  const alarm = { id: 'ev-1', fingerprint: 'fp', title: 'CPU > 95%', severity: 'critical', status: 'firing', resource: 'web-02', count: 3, ci_id: 'ci-1', source_id: 'src-1', entity_type: 'event', entity_id: 'ev-1' }

  it('ci.health_changed → corpo "<nome CI> — <nuova salute>", entità ci (link /cis/:id)', async () => {
    ruleRow = { id: 'r1', enabled: true, severity_override: 'warning', title_key: 'notification.ci.health_changed.title', channels: ['in_app'], target: 'all' }
    await new NotificationDispatcher().process(event('ci.health_changed', { id: 'ci-1', ci_id: 'ci-1', name: 'db-01', previous_health: 'operational', new_health: 'down' }))
    expect(sent.mock.calls[0]![1]).toMatchObject({ message: 'db-01 — down', entity_id: 'ci-1', entity_type: 'ci' })
  })

  it('ci.health_changed senza name → errore esplicito (il produttore deve valorizzarlo)', async () => {
    ruleRow = { id: 'r1', enabled: true, severity_override: 'warning', title_key: 'k', channels: ['in_app'], target: 'all' }
    await expect(new NotificationDispatcher().process(event('ci.health_changed', { id: 'ci-1', ci_id: 'ci-1', previous_health: null, new_health: 'down' })))
      .rejects.toThrow(/ci\.health_changed payload has no "name"/)
    expect(sent).not.toHaveBeenCalled()
  })

  it('event.received/resolved/orphan/suppressed/correlated/flapping/stable → "<titolo> — <risorsa>", entità event', async () => {
    for (const type of ['event.received', 'event.resolved', 'event.orphan', 'event.suppressed', 'event.correlated', 'event.flapping', 'event.stable']) {
      sent.mockClear()
      ruleRow = { id: 'r', enabled: true, severity_override: 'info', title_key: `notification.${type}.title`, channels: ['in_app'], target: 'all' }
      await new NotificationDispatcher().process(event(type, { ...alarm, incident_id: null, outcome: 'opened' }))
      expect(sent.mock.calls[0]![1], type).toMatchObject({ message: 'CPU > 95% — web-02', entity_id: 'ev-1', entity_type: 'event' })
    }
  })

  it('event.storm_started → "<sorgente> — <ritmo>/min" sull\'incident di tempesta; event.storm_ended → allarmi e durata sulla sorgente', async () => {
    ruleRow = { id: 'r', enabled: true, severity_override: 'error', title_key: 'k', channels: ['in_app'], target: 'all' }
    await new NotificationDispatcher().process(event('event.storm_started', {
      id: 'inc-7', source_id: 'src-1', source_name: 'Zabbix prod', rate_per_minute: 84, incident_id: 'inc-7', since: 'T', entity_type: 'incident', entity_id: 'inc-7',
    }))
    expect(sent.mock.calls[0]![1]).toMatchObject({ message: 'Zabbix prod — 84/min', entity_id: 'inc-7', entity_type: 'incident' })

    sent.mockClear()
    await new NotificationDispatcher().process(event('event.storm_ended', {
      id: 'src-1', source_id: 'src-1', source_name: 'Zabbix prod', rate_per_minute: 0, incident_id: null, since: 'T', events: 412, duration_minutes: 9, entity_type: 'inbound_webhook', entity_id: 'src-1',
    }))
    expect(sent.mock.calls[0]![1]).toMatchObject({ message: 'Zabbix prod — 412 allarmi in 9 min', entity_id: 'src-1', entity_type: 'inbound_webhook' })
  })

  it('tempesta senza rate_per_minute numerico → errore esplicito', async () => {
    ruleRow = { id: 'r', enabled: true, severity_override: 'error', title_key: 'k', channels: ['in_app'], target: 'all' }
    await expect(new NotificationDispatcher().process(event('event.storm_started', { id: 'src-1', source_name: 'Zabbix', rate_per_minute: '84' })))
      .rejects.toThrow(/event\.storm_started payload has no numeric "rate_per_minute"/)
  })
})

describe('email: il link viene dalla tabella entity_type → percorso condivisa (D3.2)', () => {
  it('service → /monitoring/services/:id; inbound_webhook → /monitoring/sources/:id; tipo senza pagina → nessun link', async () => {
    const { renderNotificationEmail } = await import('../dispatcher.js')
    const base = { id: 'n', type: 't', title: 'k', message: 'm', severity: 'info' as const, timestamp: 'T', read: false }
    expect(renderNotificationEmail({ ...base, entity_type: 'service', entity_id: 'map-1' })).toContain('/monitoring/services/map-1"')
    expect(renderNotificationEmail({ ...base, entity_type: 'inbound_webhook', entity_id: 'src-1' })).toContain('/monitoring/sources/src-1"')
    expect(renderNotificationEmail({ ...base, entity_type: 'event', entity_id: 'ev-1' })).toContain('/events/ev-1"')
    expect(renderNotificationEmail({ ...base, entity_type: 'ci', entity_id: 'ci-1' })).toContain('/cis/ci-1"')
    expect(renderNotificationEmail({ ...base, entity_type: 'sync', entity_id: 'run-1' })).not.toContain('<a ')
    // mai più `/${entity_type}s/${id}`: /services/map-1 era una rotta inesistente
    expect(renderNotificationEmail({ ...base, entity_type: 'service', entity_id: 'map-1' })).not.toMatch(/href="[a-z]+:\/\/[^/"]+\/services\/map-1"/)
  })
})
