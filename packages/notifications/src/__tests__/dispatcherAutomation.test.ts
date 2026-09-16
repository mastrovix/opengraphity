/**
 * AU-2 (revisione del 14 set 2026): l'azione «crea notifica» di trigger e
 * Business Rule pubblicava `automation.notification`, che nessuno consumava.
 * Ora la consegna il dispatcher: titolo = nome della regola, testo dell'azione,
 * destinatari del bersaglio scelto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

// Revisione totale · E-3: la consegna è deduplicata per canale su Redis. Nei
// test gli eventi riusano lo stesso id, quindi la deduplica va azzerata a
// ogni caso: il contratto della deduplica è pinnato in deliveryDedup.test.ts.
vi.mock('../deliveryDedup.js', () => ({
  deliverOnce: async (_id: string | undefined, _ch: string, deliver: () => Promise<void> | void) => { await deliver(); return true },
  alreadyDelivered: async () => false,
  markDelivered: async () => {},
  resetDeliveryDedup: () => {},
}))

vi.mock('../locale.js', () => ({ loadNotificationLocale: vi.fn(async () => ({ language: 'en', timeZone: 'UTC' })), invalidateNotificationLocale: vi.fn() }))
vi.mock('@opengraphity/events', () => ({ BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} }, assertSafeOutboundUrl: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ executeRead: vi.fn(async () => ({ records: [] })), close: vi.fn() })) }))
vi.mock('../email.js', () => ({ sendEmail: vi.fn() }))
vi.mock('../recipients.js', () => ({
  targetNeedsRecipients: (t: string) => t !== 'all',
  resolveNotificationRecipients: vi.fn(async () => [{ id: 'u-9', email: 'u9@x', notificationsEnabled: true }]),
}))
const sendToUser = vi.fn()
const sendToTenant = vi.fn()
// E-19: il dispatcher usa le consegne ATTESE (un in-app non salvato deve far
// fallire il job); i metodi sincroni restano per i cammini fire-and-forget.
vi.mock('../sse.js', () => ({ sseManager: {
  sendToUser: (...a: unknown[]) => sendToUser(...a),
  sendToTenant: (...a: unknown[]) => sendToTenant(...a),
  deliverToUser: async (...a: unknown[]) => sendToUser(...a),
  deliverToTenant: async (...a: unknown[]) => sendToTenant(...a),
} }))

const { NotificationDispatcher } = await import('../dispatcher.js')
const { resolveNotificationRecipients } = await import('../recipients.js')

const event = (payload: Record<string, unknown>): DomainEvent<unknown> => ({ id: 'e1', type: 'automation.notification', tenant_id: 't1', timestamp: '2026-09-14T10:00:00Z', correlation_id: 'c', actor_id: 'automation', payload })

beforeEach(() => vi.clearAllMocks())

describe('automation.notification', () => {
  it('in_app all → al tenant, titolo = nome della regola', async () => {
    await new NotificationDispatcher().process(event({ entity_id: 'i1', entity_type: 'incident', message: 'Incident critico non gestito', channel: 'in_app', target: 'all', rule: 'Escalation' }))
    expect(sendToTenant).toHaveBeenCalledWith('t1', expect.objectContaining({ title: 'Escalation', message: 'Incident critico non gestito', entity_id: 'i1' }))
  })

  it('bersaglio assignee → solo i suoi destinatari, per quel ticket', async () => {
    await new NotificationDispatcher().process(event({ entity_id: 'i1', entity_type: 'incident', message: 'm', channel: 'in_app', target: 'assignee', rule: 'R' }))
    expect(resolveNotificationRecipients).toHaveBeenCalledWith('t1', 'assignee', expect.objectContaining({ type: 'incident', id: 'i1' }))
    expect(sendToUser).toHaveBeenCalledWith('t1', 'u-9', expect.anything())
    expect(sendToTenant).not.toHaveBeenCalled()
  })

  it('un canale non consegnabile è un errore, non un silenzio', async () => {
    await expect(new NotificationDispatcher().process(event({ entity_id: 'i1', entity_type: 'incident', message: 'm', channel: 'slack', target: 'all', rule: 'R' }))).rejects.toThrow(/unsupported channel/)
  })
})

/** CH-13: il promemoria di un task di change arriva alla persona scelta. */
describe('change.task_reminder', () => {
  it('in-app al solo destinatario, con codice e titolo della change', async () => {
    await new NotificationDispatcher().process({ ...event({}), type: 'change.task_reminder', payload: { recipient_user_id: 'u-7', entity_id: 'chg-1', code: 'CHG00000009', title: 'Patch DB' } })
    expect(sendToUser).toHaveBeenCalledWith('t1', 'u-7', expect.objectContaining({ title: 'notification.change.task_reminder.title', message: 'CHG00000009 — Patch DB', entity_type: 'change' }))
    expect(sendToTenant).not.toHaveBeenCalled()
  })
})
