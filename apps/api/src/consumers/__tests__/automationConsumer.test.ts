/**
 * Revisione del 14 set 2026 · AU-1: le automazioni girano su ogni evento che le
 * pagine offrono. Prima trigger e regole si valutavano solo dentro la creazione
 * di incident e problem: «aggiornato», «campo cambiato», «cambio di stato»,
 * «SLA violato», le change e le richieste non partivano mai (dal vivo su c-one
 * c'erano regole attive mai eseguite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

vi.mock('@opengraphity/events', () => ({ BaseConsumer: class { constructor(public queueName: string) {} } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn() })) }))
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
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'change', 'on_create', { id: 'e1', status: 'new' }, 'automation')
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
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'problem', 'on_transition', expect.anything(), 'automation')
    expect(evaluateTriggers).not.toHaveBeenCalled()
  })
  it('ticket.updated: on_field_change riceve i campi cambiati', async () => {
    await new AutomationConsumer().process(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1', changed_fields: ['severity'] }))
    expect(evaluateTriggers).toHaveBeenCalledWith('t1', 'incident', 'on_field_change', expect.anything(), 'automation', { changedFields: ['severity'] })
    expect(evaluateBusinessRules).toHaveBeenCalledWith('t1', 'incident', 'on_update', expect.anything(), 'automation')
  })
  it('ticket che non esiste più → niente da valutare', async () => {
    vi.mocked(loadAutomationEntity).mockResolvedValueOnce(null)
    await new AutomationConsumer().process(ev('incident.created', { id: 'gone' }))
    expect(evaluateTriggers).not.toHaveBeenCalled()
    expect(scheduleTimerTriggers).not.toHaveBeenCalled()
  })
})
