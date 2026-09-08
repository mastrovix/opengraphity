/**
 * collaboration.ts — requireAgent (chat interna solo admin/operator),
 * scoping per tenant delle query, filtro isRealEmail sui destinatari delle
 * mail di menzione, cancellazione messaggi (admin qualunque, autore i propri).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@opengraphity/notifications', () => ({
  sseManager: { sendToUser: vi.fn(), sendToTenant: vi.fn() },
  sendEmail:  vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/emailTemplates.js', () => ({
  mentionNotification: vi.fn().mockReturnValue({ subject: 'Menzione', html: '<p/>', text: 'x' }),
  watcherNotification: vi.fn().mockReturnValue({ subject: 'Aggiornamento', html: '<p/>', text: 'x' }),
}))

const { collaborationResolvers, notifyMentions } = await import('../collaboration.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { sseManager, sendEmail } = await import('@opengraphity/notifications')

const base = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'agent@test.io' }
const asRole = (role: GraphQLContext['role']): GraphQLContext => ({ ...base, role })

const MSG_PROPS = {
  id: 'm-1', tenant_id: 'tenant-1', entity_type: 'incident', entity_id: 'inc-1',
  author_id: 'user-1', author_name: 'agent@test.io', body: 'ciao', mentions: [], created_at: '2026-01-01T00:00:00Z', edited_at: null,
}

const expectForbidden = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).message).toBe('Access denied: agents/admin only')
  expect((err as GraphQLError).extensions['code']).toBe('FORBIDDEN')
}

describe('requireAgent — viewer/end_user bloccati PRIMA di qualunque query', () => {
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
    expect(cypher).toContain('CREATE (m:InternalMessage {')
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toMatchObject({ tenantId: 'tenant-1', authorId: 'user-1', authorName: 'agent@test.io', mentions: ['u-2'], entityId: 'inc-1' })
    expect(out).toMatchObject({ id: 'm-1', mentions: ['u-2'], authorId: 'user-1' })
    expect(sseManager.sendToTenant).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ type: 'internal_message.new', entity_id: 'inc-1' }))
    // il menzionato riceve la notifica SSE (fire-and-forget → attendo)
    await vi.waitFor(() => expect(sseManager.sendToUser).toHaveBeenCalledWith('tenant-1', 'u-2', expect.objectContaining({ type: 'mention' })))
  })
})

describe('notifyMentions — filtro isRealEmail sui destinatari', () => {
  beforeEach(() => vi.clearAllMocks())

  const run = (email: string | null) => {
    vi.mocked(runQueryOne).mockResolvedValueOnce((email === null ? null : { email }) as never)
    return notifyMentions('tenant-1', 'Mario', 'incident', 'inc-1', 'Titolo', ['u-2'], 'comment', 'excerpt')
  }

  it('email reale → sendEmail al destinatario, lookup scoped per tenant', async () => {
    await run('bob@azienda.it')
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'bob@azienda.it', subject: 'Menzione' }))
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (u:User {id: $id, tenant_id: $t})')
    expect(params).toEqual({ id: 'u-2', t: 'tenant-1' })
    expect(sseManager.sendToUser).toHaveBeenCalledWith('tenant-1', 'u-2', expect.objectContaining({ type: 'mention' }))
  })

  it.each(['bob@demo.local', 'bob@opengrafo.com', 'usr-12@x.io'])('email demo/seed %s → SSE sì, nessuna mail', async (email) => {
    await run(email)
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
    vi.mocked(runQuery).mockResolvedValue([] as never)
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
    await expect(collaborationResolvers.Mutation.editInternalMessage(null, { messageId: 'm-1', body: 'nuovo' }, asRole('operator')))
      .rejects.toThrow(/Message not found, not yours, or edit window expired/)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId, author_id: $authorId})')
    expect(cypher).toContain('.minutes < 15')
    expect(params).toMatchObject({ id: 'm-1', tenantId: 'tenant-1', authorId: 'user-1', body: 'nuovo' })
  })
})
