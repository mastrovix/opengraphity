/**
 * Automatic escalation — the change release-window gate and guard refusals.
 *
 * Two contracts the base suite does not walk:
 * - A change workflow with an `sla_breach` edge towards the scheduled step
 *   would put an UNAPPROVED change into production when an SLA expires. For
 *   changes the window gate decides first; when it says no, nothing moves and
 *   the event is not retried (retrying does not make approvals appear).
 * - A transition refused by a guard (e.g. open tasks) is not a failure: the
 *   refusal is written as an internal comment ON THE TICKET, where whoever was
 *   waiting for the escalation sees it, and the event closes without retrying.
 *   Throwing would exhaust BullMQ retries and mark the event lost, silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const publish = vi.fn()
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public readonly queueName: string) {} },
  publish: (...a: unknown[]) => publish(...a),
}))

let row: Record<string, unknown> = {}
const writeTx = { run: vi.fn() }
const session = {
  executeRead: async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async () => ({ records: [{ get: (k: string) => row[k] ?? null }] }),
  }),
  executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(writeTx)),
  close: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => session }))

const transition = vi.fn()
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() } }))

const automaticTransitionAllowed = vi.fn()
vi.mock('../../graphql/resolvers/change/windowGate.js', () => ({
  automaticTransitionAllowed: (...a: unknown[]) => automaticTransitionAllowed(...a),
}))
const writeTicketComment = vi.fn()
vi.mock('../../lib/ticketComments.js', () => ({ writeTicketComment: (...a: unknown[]) => writeTicketComment(...a) }))
vi.mock('../../lib/systemText.js', () => ({
  systemText: vi.fn(async (_t: string, key: string, p: Record<string, string>) => `${key}:${p['step']}:${p['reason']}`),
}))

const { EscalationConsumer } = await import('../escalationConsumer.js')
const consumer = new EscalationConsumer()

const event = (type: string, payload: Record<string, unknown>): DomainEvent<unknown> => ({
  id: 'evt-1', type, tenant_id: 't1', timestamp: '2026-09-22T10:00:00.000Z', correlation_id: 'corr-1', actor_id: 'sla-engine', payload,
})

beforeEach(() => {
  vi.clearAllMocks()
  transition.mockResolvedValue({ success: true })
  publish.mockResolvedValue(undefined)
})

describe('EscalationConsumer — change release-window gate', () => {
  beforeEach(() => {
    row = { instanceId: 'wi-c', entityType: 'change', fromStep: 'assessment', toStep: 'scheduled', changeType: 'normal', number: 'CHG0001' }
  })

  it('asks the gate with the change type, current and target step, on the sla_breach path', async () => {
    automaticTransitionAllowed.mockResolvedValue(true)
    await consumer.process(event('sla.breached', { entity_id: 'chg-1' }))
    expect(automaticTransitionAllowed).toHaveBeenCalledWith(session, {
      tenantId: 't1', changeId: 'chg-1', changeType: 'normal', currentStep: 'assessment', toStep: 'scheduled',
    }, 'sla_breach')
    expect(transition).toHaveBeenCalledTimes(1)
    // With no title the notification uses the ticket number, never a bare uuid.
    expect(publish.mock.calls[0]![0]).toMatchObject({ type: 'change.scheduled', payload: { title: 'CHG0001', severity: 'unknown' } })
  })

  it('a refused gate moves nothing, publishes nothing and does not throw (no retry)', async () => {
    automaticTransitionAllowed.mockResolvedValue(false)
    row = { ...row, changeType: null }
    await expect(consumer.process(event('ola.breached', { id: 'chg-1' }))).resolves.toBeUndefined()
    // A change without a type is passed as '' — the gate decides, not a default.
    expect(automaticTransitionAllowed.mock.calls[0]![1]).toMatchObject({ changeType: '' })
    expect(transition).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })
})

describe('EscalationConsumer — transition refused by a guard', () => {
  beforeEach(() => {
    row = { instanceId: 'wi-1', entityType: 'incident', fromStep: 'in_progress', toStep: 'escalated', title: 'DB down' }
  })

  it('writes the refusal as an internal system comment on the ticket and closes the event without retrying', async () => {
    transition.mockResolvedValue({ success: false, refusedByCondition: 'all_tasks_complete', error: '2 tasks still open' })
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).resolves.toBeUndefined()

    expect(writeTicketComment).toHaveBeenCalledWith(writeTx, {
      entityType: 'incident', entityId: 'inc-1', tenantId: 't1',
      text: 'escalation.refusedByGuard:escalated:2 tasks still open',
      authorId: 'system', authorLabel: 'system', isInternal: true,
    })
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ condition: 'all_tasks_complete' }), expect.stringContaining('not retried'))
    // Nothing escalated, so no step-entered event.
    expect(publish).not.toHaveBeenCalled()
  })

  it('a refusal without an error message still writes a comment (empty reason)', async () => {
    transition.mockResolvedValue({ success: false, refusedByCondition: 'custom_guard' })
    await consumer.process(event('sla.breached', { entity_id: 'inc-1' }))
    expect(writeTicketComment.mock.calls[0]![1]).toMatchObject({ text: 'escalation.refusedByGuard:escalated:' })
  })
})
