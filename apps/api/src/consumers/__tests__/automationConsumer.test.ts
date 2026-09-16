/**
 * Revisione del 14 set 2026 · AU-1: le automazioni girano su ogni evento che le
 * pagine offrono. Prima trigger e regole si valutavano solo dentro la creazione
 * di incident e problem: «aggiornato», «campo cambiato», «cambio di stato»,
 * «SLA violato», le change e le richieste non partivano mai (dal vivo su c-one
 * c'erano regole attive mai eseguite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} },
  getRedisConnection: () => ({ host: 'localhost', port: 6379 }),
}))
// C-36: per un incident si accodano anche le escalation delle notifiche.
vi.mock('../../lib/notificationEscalation.js', () => ({ scheduleNotificationEscalations: vi.fn(async () => 0) }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn() })), runQuery: vi.fn(async () => []), runQueryOne: vi.fn(async () => null) }))
vi.mock('../../lib/automationEntity.js', () => ({ loadAutomationEntity: vi.fn(async () => ({ id: 'e1', status: 'new' })) }))
vi.mock('../../lib/triggerEngine.js', () => ({ evaluateTriggers: vi.fn(async () => []), scheduleTimerTriggers: vi.fn() }))
vi.mock('../../lib/rulesEngine.js', () => ({ evaluateBusinessRules: vi.fn(async () => []) }))

const { automationWorkFor, AutomationConsumer } = await import('../automationConsumer.js')
const { evaluateTriggers, scheduleTimerTriggers } = await import('../../lib/triggerEngine.js')
const { evaluateBusinessRules } = await import('../../lib/rulesEngine.js')
const { loadAutomationEntity } = await import('../../lib/automationEntity.js')

const ev = (type: string, payload: Record<string, unknown>, actor = 'u1'): DomainEvent<unknown> =>
  ({ id: 'x', type, tenant_id: 't1', timestamp: 'now', correlation_id: 'c', actor_id: actor, payload })

beforeEach(() => vi.clearAllMocks())

describe('automationWorkFor — ogni evento offerto ha la sua sorgente', () => {
  it('creazione dei quattro ticket → on_create con i trigger a tempo', () => {
    expect(automationWorkFor(ev('change.created', { id: 'c1' }))).toMatchObject({ entityType: 'change', entityId: 'c1', events: ['on_create'], scheduleTimers: true })
    expect(automationWorkFor(ev('request.created', { id: 'r1' }))).toMatchObject({ entityType: 'service_request' })
  })
  it('ticket.updated → on_update e on_field_change con i campi cambiati', () => {
    expect(automationWorkFor(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1', changed_fields: ['impact', 'severity'], previous: {} })))
      .toEqual({ entityType: 'incident', entityId: 'i1', events: ['on_update', 'on_field_change'], changedFields: ['impact', 'severity'] })
  })
  it('workflow.step_entered → on_transition; sla.breached → on_sla_breach', () => {
    expect(automationWorkFor(ev('workflow.step_entered', { entity_type: 'change', entity_id: 'c1' }))?.events).toEqual(['on_transition'])
    expect(automationWorkFor(ev('sla.breached', { entity_type: 'problem', entity_id: 'p1' }))?.events).toEqual(['on_sla_breach'])
  })
  it('un evento prodotto da un\'automazione non rimette in moto le automazioni', () => {
    expect(automationWorkFor(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1', changed_fields: ['severity'] }, 'automation'))).toBeNull()
    expect(automationWorkFor(ev('workflow.step_entered', { entity_type: 'incident', entity_id: 'i1' }, 'automation'))).toBeNull()
  })
})

describe('AutomationConsumer.process', () => {
  it('change.created: regole e trigger on_create sulla change riletta dal grafo, poi i trigger a tempo', async () => {
    await new AutomationConsumer().process(ev('change.created', { id: 'c1' }))
    expect(loadAutomationEntity).toHaveBeenCalledWith(expect.anything(), 't1', 'change', 'c1')
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'change', 'on_create', { id: 'e1', status: 'new' }, 'automation', undefined)
    expect(evaluateTriggers).toHaveBeenCalledWith('t1', 'change', 'on_create', { id: 'e1', status: 'new' }, 'automation', undefined)
    expect(scheduleTimerTriggers).toHaveBeenCalledWith('t1', 'change', 'c1')
  })
  it('sla.breached: solo i trigger (le regole non hanno questo evento)', async () => {
    await new AutomationConsumer().process(ev('sla.breached', { entity_type: 'incident', entity_id: 'i1' }))
    expect(evaluateTriggers).toHaveBeenCalledWith('t1', 'incident', 'on_sla_breach', expect.anything(), 'automation', undefined)
    expect(evaluateBusinessRules).not.toHaveBeenCalled()
  })
  it('workflow.step_entered: solo le regole on_transition', async () => {
    await new AutomationConsumer().process(ev('workflow.step_entered', { entity_type: 'problem', entity_id: 'p1' }))
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'problem', 'on_transition', expect.anything(), 'automation', undefined)
    expect(evaluateTriggers).not.toHaveBeenCalled()
  })
  it('ticket.updated: on_field_change riceve i campi cambiati', async () => {
    await new AutomationConsumer().process(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1', changed_fields: ['severity'] }))
    expect(evaluateTriggers).toHaveBeenCalledWith('t1', 'incident', 'on_field_change', expect.anything(), 'automation', { changedFields: ['severity'] })
    // V-19: le regole «aggiornato» ricevono i campi cambiati, per l'operatore «è cambiato».
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'incident', 'on_update', expect.anything(), 'automation', { changedFields: ['severity'] })
    expect(evaluateTriggers).toHaveBeenCalledWith('t1', 'incident', 'on_update', expect.anything(), 'automation', { changedFields: ['severity'] })
  })
  it('ticket che non esiste più → niente da valutare', async () => {
    vi.mocked(loadAutomationEntity).mockResolvedValueOnce(null)
    await new AutomationConsumer().process(ev('incident.created', { id: 'gone' }))
    expect(evaluateTriggers).not.toHaveBeenCalled()
    expect(scheduleTimerTriggers).not.toHaveBeenCalled()
  })
})

/**
 * Revisione totale · C-36: le azioni delle regole (commento, webhook,
 * notifica, assegnazione) NON sono idempotenti, e venivano eseguite PRIMA di
 * accodare i timer. Se l'accodamento lanciava (Redis in affanno) il consumer
 * rilanciava e l'evento veniva ritentato: due commenti identici e due
 * webhook. I job dei timer hanno un `jobId` deterministico, quindi accodarli
 * per primi non produce doppioni.
 */
describe('ordine: prima i timer, poi le azioni (C-36)', () => {
  it('l\'accodamento dei timer precede la valutazione delle regole', async () => {
    const order: string[] = []
    vi.mocked(scheduleTimerTriggers).mockImplementation(async () => { order.push('timers') })
    vi.mocked(evaluateBusinessRules).mockImplementation(async () => { order.push('rules'); return [] })
    vi.mocked(evaluateTriggers).mockImplementation(async () => { order.push('triggers'); return [] })
    await new AutomationConsumer().process(ev('incident.created', { id: 'inc-1' }))
    expect(order[0]).toBe('timers')
    expect(order).toContain('rules')
  })

  it('se l\'accodamento dei timer fallisce, nessuna azione è stata eseguita', async () => {
    vi.mocked(scheduleTimerTriggers).mockRejectedValueOnce(new Error('redis in affanno'))
    await expect(new AutomationConsumer().process(ev('incident.created', { id: 'inc-1' }))).rejects.toThrow('redis in affanno')
    expect(evaluateBusinessRules).not.toHaveBeenCalled()
    expect(evaluateTriggers).not.toHaveBeenCalled()
  })
})
