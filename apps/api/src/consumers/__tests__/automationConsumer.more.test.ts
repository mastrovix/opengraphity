/**
 * The automation consumer, edge cases the main suite leaves out.
 *
 * Why these matter to a user:
 *  - a malformed or foreign event (no id, no entity, an event type the
 *    automations do not listen to) must be ignored, not crash the queue:
 *    a thrown error would retry the job forever and stall every other
 *    automation of the tenant behind it;
 *  - an event on a ticket type the automation table does not support
 *    (a change has no field updates) must not even read the graph;
 *  - a failing rule or trigger must be LOGGED with its name — the owner
 *    has no other way to learn that a configured automation did not run;
 *  - a new incident also schedules the notification escalations (NT-8),
 *    other tickets do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const logSpies = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }))

vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} },
  getRedisConnection: () => ({ host: 'localhost', port: 6379 }),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => logSpies, ...logSpies },
}))
vi.mock('../../lib/notificationEscalation.js', () => ({ scheduleNotificationEscalations: vi.fn(async () => 0) }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ close: vi.fn() })) }))
vi.mock('../../lib/automationEntity.js', () => ({ loadAutomationEntity: vi.fn(async () => ({ id: 'e1', status: 'new' })) }))
vi.mock('../../lib/triggerEngine.js', () => ({ evaluateTriggers: vi.fn(async () => []), scheduleTimerTriggers: vi.fn() }))
vi.mock('../../lib/rulesEngine.js', () => ({ evaluateBusinessRules: vi.fn(async () => []) }))

const { automationWorkFor, AutomationConsumer } = await import('../automationConsumer.js')
const { evaluateTriggers, scheduleTimerTriggers } = await import('../../lib/triggerEngine.js')
const { evaluateBusinessRules } = await import('../../lib/rulesEngine.js')
const { loadAutomationEntity } = await import('../../lib/automationEntity.js')
const { scheduleNotificationEscalations } = await import('../../lib/notificationEscalation.js')
const { getSession } = await import('@opengraphity/neo4j')

const ev = (type: string, payload: unknown, actor = 'u1'): DomainEvent<unknown> =>
  ({ id: 'x', type, tenant_id: 't1', timestamp: 'now', correlation_id: 'c', actor_id: actor, payload })

beforeEach(() => vi.clearAllMocks())

describe('automationWorkFor — events that carry no automation work', () => {
  it('a creation event without a string id is ignored instead of loading "undefined"', () => {
    expect(automationWorkFor(ev('incident.created', {}))).toBeNull()
    expect(automationWorkFor(ev('incident.created', { id: 42 }))).toBeNull()
  })

  it('a missing payload is treated as empty, not as a crash', () => {
    expect(automationWorkFor(ev('incident.created', null))).toBeNull()
    expect(automationWorkFor(ev('ticket.updated', undefined))).toBeNull()
  })

  it('an entity event without entity type or string entity id is ignored', () => {
    expect(automationWorkFor(ev('sla.breached', { entity_id: 'i1' }))).toBeNull()
    expect(automationWorkFor(ev('sla.breached', { entity_type: 'incident', entity_id: 7 }))).toBeNull()
  })

  it('a ticket.updated with no changed field is not an update worth evaluating', () => {
    expect(automationWorkFor(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1', changed_fields: [] }))).toBeNull()
    // Missing list is the same as an empty one.
    expect(automationWorkFor(ev('ticket.updated', { entity_type: 'incident', entity_id: 'i1' }))).toBeNull()
  })

  it('an event type the automations do not listen to yields no work', () => {
    expect(automationWorkFor(ev('incident.resolved', { entity_type: 'incident', entity_id: 'i1' }))).toBeNull()
  })

  it('a problem creation maps to the problem entity type', () => {
    expect(automationWorkFor(ev('problem.created', { id: 'p1' }))).toEqual({
      entityType: 'problem', entityId: 'p1', events: ['on_create'], scheduleTimers: true,
    })
  })
})

describe('AutomationConsumer.process — edge cases', () => {
  it('does nothing (not even a graph read) for an event without work', async () => {
    await new AutomationConsumer().process(ev('incident.resolved', { entity_type: 'incident', entity_id: 'i1' }))
    expect(getSession).not.toHaveBeenCalled()
  })

  it('an update on a change is dropped before reading the graph: changes have no field updates', async () => {
    await new AutomationConsumer().process(ev('ticket.updated', { entity_type: 'change', entity_id: 'c1', changed_fields: ['title'] }))
    expect(getSession).not.toHaveBeenCalled()
    expect(evaluateTriggers).not.toHaveBeenCalled()
  })

  it('closes the read session even when loading the ticket throws', async () => {
    const close = vi.fn()
    vi.mocked(getSession).mockReturnValueOnce({ close } as never)
    vi.mocked(loadAutomationEntity).mockRejectedValueOnce(new Error('neo4j down'))
    await expect(new AutomationConsumer().process(ev('sla.breached', { entity_type: 'incident', entity_id: 'i1' })))
      .rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalled()
  })

  it('logs the ticket that vanished, so a skipped automation is explainable', async () => {
    vi.mocked(loadAutomationEntity).mockResolvedValueOnce(null)
    await new AutomationConsumer().process(ev('sla.breached', { entity_type: 'incident', entity_id: 'gone' }))
    expect(logSpies.info).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'gone', tenantId: 't1' }), expect.any(String))
  })

  it('a new incident also schedules the notification escalations; a new change does not', async () => {
    await new AutomationConsumer().process(ev('incident.created', { id: 'i1' }))
    expect(scheduleNotificationEscalations).toHaveBeenCalledWith('t1', 'i1')
    vi.clearAllMocks()
    await new AutomationConsumer().process(ev('change.created', { id: 'c1' }))
    expect(scheduleNotificationEscalations).not.toHaveBeenCalled()
    expect(scheduleTimerTriggers).toHaveBeenCalledWith('t1', 'change', 'c1')
  })

  it('logs every failed rule and trigger by name and keeps evaluating the rest', async () => {
    vi.mocked(evaluateBusinessRules).mockResolvedValue([
      { ruleName: 'Ok rule' }, { ruleName: 'Broken rule', error: 'bad field' },
    ] as never)
    vi.mocked(evaluateTriggers).mockResolvedValue([
      { triggerName: 'Broken trigger', error: 'webhook 500' },
    ] as never)
    await new AutomationConsumer().process(ev('incident.created', { id: 'i1' }))
    expect(logSpies.error).toHaveBeenCalledWith(expect.objectContaining({ rule: 'Broken rule', error: 'bad field', entityId: 'i1' }), 'business rule failed')
    expect(logSpies.error).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'Broken trigger', error: 'webhook 500' }), 'trigger failed')
    // Only the failed rule is logged, not the successful one.
    expect(logSpies.error).not.toHaveBeenCalledWith(expect.objectContaining({ rule: 'Ok rule' }), expect.anything())
    vi.mocked(evaluateBusinessRules).mockResolvedValue([])
    vi.mocked(evaluateTriggers).mockResolvedValue([])
  })
})
