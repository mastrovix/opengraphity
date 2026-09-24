/**
 * Automatic escalation — a refusal is an answer, not a failure.
 *
 * A transition refused by a guard (open tasks, the release window of a change,
 * an approval) does not depend on time: throwing would exhaust BullMQ retries
 * and mark the event lost, silently. The pipeline (services/ticketTransition.ts)
 * writes the refusal ON THE TICKET, where whoever was waiting for the
 * escalation sees it (tested there); here the event closes without retrying
 * and nothing is published. The release window of a change is one of the
 * pipeline's guards since wave 7 · B1: the consumer no longer asks it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const publish = vi.fn()
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public readonly queueName: string) {} },
  publish: (...a: unknown[]) => publish(...a),
}))

let row: Record<string, unknown> = {}
const session = {
  executeRead: async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async () => ({ records: [{ get: (k: string) => row[k] ?? null }] }),
  }),
  close: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => session }))

const transitionTicket = vi.fn()
vi.mock('../../services/ticketTransition.js', () => ({ transitionTicket: (...a: unknown[]) => transitionTicket(...a) }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { EscalationConsumer } = await import('../escalationConsumer.js')
const consumer = new EscalationConsumer()

const event = (type: string, payload: Record<string, unknown>): DomainEvent<unknown> => ({
  id: 'evt-1', type, tenant_id: 't1', timestamp: '2026-09-22T10:00:00.000Z', correlation_id: 'corr-1', actor_id: 'sla-engine', payload,
})

beforeEach(() => {
  vi.clearAllMocks()
  publish.mockResolvedValue(undefined)
})

describe('EscalationConsumer — a change', () => {
  beforeEach(() => {
    row = { instanceId: 'wi-c', entityType: 'change', fromStep: 'assessment', toStep: 'scheduled', number: 'CHG0001' }
  })

  it('moves through the pipeline like any ticket, and the notification names it by its number', async () => {
    transitionTicket.mockResolvedValue({ moved: true })
    await consumer.process(event('sla.breached', { entity_id: 'chg-1' }))
    expect(transitionTicket).toHaveBeenCalledWith(session, expect.objectContaining({ instanceId: 'wi-c', toStep: 'scheduled' }))
    // With no title the notification uses the ticket number, never a bare uuid.
    expect(publish.mock.calls[0]![0]).toMatchObject({ type: 'change.scheduled', payload: { title: 'CHG0001', severity: 'unknown' } })
  })

  it('the release window refuses: nothing published, no throw (no retry), the session closed', async () => {
    transitionTicket.mockResolvedValue({ moved: false, refusal: { guard: 'change_window', final: true, message: 'needs approvals' } })
    await expect(consumer.process(event('ola.breached', { id: 'chg-1' }))).resolves.toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })
})

describe('EscalationConsumer — transition refused by a guard of the workflow', () => {
  beforeEach(() => {
    row = { instanceId: 'wi-1', entityType: 'incident', fromStep: 'in_progress', toStep: 'escalated', title: 'DB down' }
  })

  it('closes the event without retrying, and publishes nothing (nothing escalated)', async () => {
    transitionTicket.mockResolvedValue({ moved: false, refusal: { guard: 'workflow', final: true, message: '2 tasks still open' } })
    await expect(consumer.process(event('sla.breached', { entity_id: 'inc-1' }))).resolves.toBeUndefined()
    expect(publish).not.toHaveBeenCalled()
  })
})
