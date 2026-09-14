/**
 * Revisione del 14 set 2026 · F10: il pannello delle notifiche legge l'archivio
 * della persona collegata e ne scrive lo stato (letto, nascosto).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listInbox = vi.fn(async () => [{ id: 'n-1', type: 'mention', title: 't', message: 'm', message_key: 'k', message_params: { a: 'b' }, severity: 'info', entity_id: 'e', entity_type: 'incident', timestamp: 'ts', read: false }])
const markInboxRead = vi.fn(async () => 1)
const markAllInboxRead = vi.fn(async () => 4)
const dismissInbox = vi.fn(async () => 9)
vi.mock('@opengraphity/notifications', () => ({ listInbox, markInboxRead, markAllInboxRead, dismissInbox }))

const { inboxResolvers } = await import('../inbox.js')
const ctx = { tenantId: 't1', userId: 'u1', role: 'operator' } as never

describe('resolver del pannello notifiche', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('myNotifications: le notifiche della persona, in camelCase, con i parametri del messaggio in JSON', async () => {
    const out = await inboxResolvers.Query.myNotifications(null, { limit: 20 }, ctx)
    expect(listInbox).toHaveBeenCalledWith('t1', 'u1', 20)
    expect(out).toEqual([{ id: 'n-1', type: 'mention', title: 't', titleFallback: null, message: 'm', messageKey: 'k', messageParams: '{"a":"b"}', severity: 'info', entityId: 'e', entityType: 'incident', timestamp: 'ts', read: false }])
  })

  it('limite: da 1 a 200, altrimenti errore', async () => {
    await expect(inboxResolvers.Query.myNotifications(null, { limit: 0 }, ctx)).rejects.toThrow()
    await expect(inboxResolvers.Query.myNotifications(null, { limit: 201 }, ctx)).rejects.toThrow()
  })

  it('letto, tutto letto e svuota scrivono sulla persona collegata', async () => {
    expect(await inboxResolvers.Mutation.markNotificationRead(null, { id: 'n-1' }, ctx)).toBe(true)
    expect(markInboxRead).toHaveBeenCalledWith('t1', 'u1', 'n-1')
    expect(await inboxResolvers.Mutation.markAllNotificationsRead(null, {}, ctx)).toBe(4)
    expect(await inboxResolvers.Mutation.dismissAllNotifications(null, {}, ctx)).toBe(9)
  })
})
