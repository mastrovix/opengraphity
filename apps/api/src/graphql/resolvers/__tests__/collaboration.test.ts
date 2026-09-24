/**
 * collaboration.ts — requireAgent (chat interna solo admin/operator),
 * scoping per tenant delle query, destinatari delle mail di menzione
 * (`notifications_enabled`), cancellazione messaggi (admin qualunque, autore i propri).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/db.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// M-16: i permessi del ruolo vengono dai ruoli del tenant; qui quelli di fabbrica.
vi.mock('../../../lib/roles.js', () => ({
  roleHasPermission: async (_t: string, role: string, permission: string) =>
    (perms(role as never) as ReadonlySet<string>).has(permission),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@opengraphity/notifications', async () => {
  const texts = await import('../../../../../../packages/notifications/src/texts.js')
  return {
    sseManager: { sendToUser: vi.fn(), sendToTenant: vi.fn() },
    sendEmail:  vi.fn().mockResolvedValue(undefined),
    // Ondata 6: le e-mail partono a nome dell'organizzazione, con il suo marchio.
    loadTenantBrand: vi.fn(async () => ({ displayName: 'ACME', senderName: 'ACME IT', replyTo: null, logo: null })),
    sendTenantEmail: vi.fn(async (_tenantId: string, msg: unknown) => (await import('@opengraphity/notifications')).sendEmail(msg as never)),
    // CO-2: il testo di ripiego nella lingua del cliente (qui inglese).
    loadNotificationLocale: vi.fn(async () => ({ language: 'en', timeZone: 'UTC' })),
    notificationText: texts.notificationText,
  }
})
vi.mock('../../../lib/emailTemplates.js', () => ({
  mentionNotification: vi.fn().mockReturnValue({ subject: 'Mention', html: '<p/>', text: 'x' }),
  watcherNotification: vi.fn().mockReturnValue({ subject: 'Update', html: '<p/>', text: 'x' }),
}))

const { collaborationResolvers, notifyMentions, notifyWatchers } = await import('../collaboration.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { sseManager, sendEmail } = await import('@opengraphity/notifications')

const base = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'agent@test.io' }
const asRole = (role: GraphQLContext['role']): GraphQLContext => ({ ...base, role, permissions: perms(role) })

const MSG_PROPS = {
  id: 'm-1', tenant_id: 'tenant-1', entity_type: 'incident', entity_id: 'inc-1',
  author_id: 'user-1', author_name: 'agent@test.io', body: 'ciao', mentions: [], created_at: '2026-01-01T00:00:00Z', edited_at: null,
}

const expectForbidden = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).message).toMatch(/ticket\.internalChat/)
  expect((err as GraphQLError).extensions['code']).toBe('FORBIDDEN')
}

describe('ticket.internalChat — viewer/end_user bloccati PRIMA di qualunque query', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['viewer', 'end_user'] as const)('internalMessages con ruolo %s → FORBIDDEN, nessuna query', async (role) => {
    await expectForbidden(collaborationResolvers.Query.internalMessages(null, { entityType: 'incident', entityId: 'inc-1' }, asRole(role)))
    expect(runQuery).not.toHaveBeenCalled()
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })

  it.each(['viewer', 'end_user'] as const)('sendInternalMessage con ruolo %s → FORBIDDEN, nessuna scrittura né SSE', async (role) => {
    await expectForbidden(collaborationResolvers.Mutation.sendInternalMessage(null, { entityType: 'incident', entityId: 'inc-1', body: 'x' }, asRole(role)))
    expect(runQuery).not.toHaveBeenCalled()
    expect(sseManager.sendToTenant).not.toHaveBeenCalled()
  })

  it.each(['viewer', 'end_user'] as const)('editInternalMessage / deleteInternalMessage con ruolo %s → FORBIDDEN', async (role) => {
    await expectForbidden(collaborationResolvers.Mutation.editInternalMessage(null, { messageId: 'm-1', body: 'x' }, asRole(role)))
    await expectForbidden(collaborationResolvers.Mutation.deleteInternalMessage(null, { messageId: 'm-1' }, asRole(role)))
    expect(runQuery).not.toHaveBeenCalled()
  })

  it.each(['operator', 'admin'] as const)('internalMessages con ruolo %s → passa, query scoped per tenant, ordine cronologico', async (role) => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { props: { ...MSG_PROPS, id: 'm-2', created_at: '2026-01-02T00:00:00Z' } },
      { props: { ...MSG_PROPS, id: 'm-1' } },
    ] as never)

    const out = await collaborationResolvers.Query.internalMessages(null, { entityType: 'incident', entityId: 'inc-1', limit: 500 }, asRole(role))

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (m:InternalMessage {entity_id: $entityId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ tenantId: 'tenant-1', entityId: 'inc-1', entityType: 'incident', limit: 100, before: null })
    // DESC dal DB, poi reverse → cronologico
    expect(out.map((m) => m.id)).toEqual(['m-1', 'm-2'])
  })
})

describe('sendInternalMessage (admin) — scrittura con tenant del contesto + notifiche', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([] as never)
    vi.mocked(runQueryOne).mockResolvedValue({ title: 'Stampante rotta' } as never)
  })

  it('CREATE con tenant_id/author dal contesto, mentions estratte, SSE al tenant', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { ...MSG_PROPS, mentions: ['u-2'] } }] as never)

    const out = await collaborationResolvers.Mutation.sendInternalMessage(
      null, { entityType: 'incident', entityId: 'inc-1', body: 'ciao @[Bob](u-2)' }, asRole('admin'),
    )

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (e:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(cypher).toContain('CREATE (m:InternalMessage {')
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toMatchObject({ tenantId: 'tenant-1', authorId: 'user-1', authorName: 'agent@test.io', mentions: ['u-2'], entityId: 'inc-1' })
    expect(out).toMatchObject({ id: 'm-1', mentions: ['u-2'], authorId: 'user-1' })
    // Revisione del 14 set 2026 · CO-2/F10: niente più «nuovo messaggio interno»
    // trasmesso a tutto il tenant (con le notifiche salvate sarebbe finito nel
    // pannello di ogni persona). Lo ricevono gli osservatori e i menzionati.
    expect(sseManager.sendToTenant).not.toHaveBeenCalled()
    // il menzionato riceve la notifica, con chiave e parametri del messaggio (fire-and-forget → attendo)
    await vi.waitFor(() => expect(sseManager.sendToUser).toHaveBeenCalledWith('tenant-1', 'u-2', expect.objectContaining({
      type: 'mention', title: 'notification.mention.title',
      message_key: 'inApp.mention.chatMessage',
      message_params: { author: 'agent@test.io', entity: 'incident', title: 'Stampante rotta' },
      message: 'agent@test.io mentioned you in the internal chat of incident "Stampante rotta"',
    })))
  })

  // CO-3: su un ticket che non esiste nel tenant non nasce un messaggio orfano.
  it('ticket inesistente nel tenant → NOT_FOUND, nessuna notifica', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(collaborationResolvers.Mutation.sendInternalMessage(null, { entityType: 'incident', entityId: 'nope', body: 'x' }, asRole('admin'))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(sseManager.sendToTenant).not.toHaveBeenCalled()
  })
})

/**
 * Revisione del 14 set 2026 · CO-1: le e-mail di menzione e di osservazione
 * scartavano gli indirizzi `@demo.`, `@opengrafo.com` e `usr-N@`. Un cliente
 * con quei domini non riceveva mai niente, senza traccia. Ora decide la persona
 * (`notifications_enabled` dal Profilo), come per il digest e il dispatcher.
 */
describe('notifyMentions — destinatari delle e-mail', () => {
  beforeEach(() => vi.clearAllMocks())

  const run = (row: { email: string; enabled: boolean } | null) => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(row as never)
    return notifyMentions('tenant-1', 'Mario', 'incident', 'inc-1', 'Titolo', ['u-2'], 'comment', 'excerpt')
  }

  it('email con notifiche attive → sendEmail al destinatario, lookup scoped per tenant', async () => {
    await run({ email: 'bob@azienda.it', enabled: true })
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'bob@azienda.it', subject: 'Mention' }))
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (u:User {id: $id, tenant_id: $t})')
    expect(cypher).toContain('notifications_enabled')
    expect(params).toEqual({ id: 'u-2', t: 'tenant-1' })
    expect(sseManager.sendToUser).toHaveBeenCalledWith('tenant-1', 'u-2', expect.objectContaining({
      type: 'mention', message_key: 'inApp.mention.message',
      message: 'Mario mentioned you in incident "Titolo"',
    }))
  })

  it.each(['bob@demo.local', 'bob@opengrafo.com', 'usr-12@x.io'])('nessun dominio cablato: %s riceve la mail', async (email) => {
    await run({ email, enabled: true })
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: email }))
  })

  it('e-mail disattivate dal Profilo → SSE sì, nessuna mail', async () => {
    await run({ email: 'bob@azienda.it', enabled: false })
    expect(sseManager.sendToUser).toHaveBeenCalledOnce()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('utente senza email (o di altro tenant: lookup vuoto) → nessuna mail', async () => {
    await run(null)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('deleteInternalMessage — admin qualunque messaggio, operator solo i propri', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([{ n: 1 }] as never)
  })

  // CO-3: prima rispondeva true anche senza aver cancellato niente.
  it('messaggio inesistente o altrui → NOT_FOUND, non un true bugiardo', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(collaborationResolvers.Mutation.deleteInternalMessage(null, { messageId: 'm-x' }, asRole('operator'))).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('operator → filtro author_id = $authorId', async () => {
    await collaborationResolvers.Mutation.deleteInternalMessage(null, { messageId: 'm-1' }, asRole('operator'))
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('AND m.author_id = $authorId')
    expect(cypher).toContain('MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'm-1', tenantId: 'tenant-1', authorId: 'user-1' })
  })

  it('admin → nessun filtro autore, ma sempre scoped per tenant', async () => {
    await collaborationResolvers.Mutation.deleteInternalMessage(null, { messageId: 'm-1' }, asRole('admin'))
    const [, cypher] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).not.toContain('author_id')
    expect(cypher).toContain('tenant_id: $tenantId')
  })

  it('editInternalMessage: messaggio altrui / scaduto → errore, la query vincola autore e finestra 15 min', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(collaborationResolvers.Mutation.editInternalMessage(null, { messageId: 'm-1', body: 'nuovo' }, asRole('operator')))
      .rejects.toThrow(/Message not found, not yours, or edit window expired/)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId, author_id: $authorId})')
    expect(cypher).toContain('.minutes < 15')
    expect(params).toMatchObject({ id: 'm-1', tenantId: 'tenant-1', authorId: 'user-1', body: 'nuovo' })
  })
})

/**
 * Revisione totale · M-16: chi apre un ticket dal portale diventa osservatore
 * alla creazione, e riceveva l'avviso — in-app e per e-mail, con il testo nel
 * corpo — di una NOTA INTERNA che non può leggere. Gli osservatori senza il
 * permesso di lavorare i ticket non vengono avvisati del contenuto interno.
 */
describe('notifyWatchers — il contenuto interno non esce dal perimetro dello staff (M-16)', () => {
  const watchers = [
    { userId: 'staff-1',  role: 'operator' },
    { userId: 'utente-1', role: 'end_user' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('[:WATCHES]->') ? watchers : []) as never)
    vi.mocked(runQueryOne).mockResolvedValue({ email: 'x@y.z', notificationsEnabled: true, title: 'Rete giù' } as never)
  })

  it('contenuto interno: solo chi lavora i ticket viene avvisato', async () => {
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'internal_chat', author: 'agent@test.io' }, undefined, true)
    const notified = vi.mocked(sseManager.sendToUser).mock.calls.map((c) => c[1])
    expect(notified).toEqual(['staff-1'])
  })

  it('commento pubblico: tutti gli osservatori, portale compreso', async () => {
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'comment', author: 'agent@test.io' })
    const notified = vi.mocked(sseManager.sendToUser).mock.calls.map((c) => c[1])
    expect(notified).toEqual(['staff-1', 'utente-1'])
  })
})
