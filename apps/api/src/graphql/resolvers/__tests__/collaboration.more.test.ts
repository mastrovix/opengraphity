/**
 * Collaboration resolvers (graphql/resolvers/collaboration.ts): @mention user
 * search, watchers, and the internal-chat paths not covered by
 * collaboration.test.ts.
 *
 * Why these behaviours matter:
 *  - user search and watcher lists are tenant-scoped: the @mention picker must
 *    never offer people of another customer, and the search is capped so a
 *    client cannot pull the whole directory in one request;
 *  - the internal chat shows the most recent page in chronological order and
 *    pages backwards with `before`; an off-by-order bug scrambles conversations;
 *  - mentions stored as a JSON string (older rows) must still be read, and a
 *    corrupt value must not break the whole chat;
 *  - notifications are fire-and-forget, but a failure must be logged loudly
 *    (a watcher who is not told is a defect) and must never reject unhandled —
 *    on Node 24 that terminates the API process;
 *  - the author of an event is not notified of their own action, and an
 *    e-mail failure for one watcher does not stop the others.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { close: vi.fn() }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/roles.js', () => ({
  roleHasPermission: async (_t: string, role: string, permission: string) =>
    (perms(role as never) as ReadonlySet<string>).has(permission),
  tenantRoles: vi.fn(),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@opengraphity/notifications', async () => {
  const texts = await import('../../../../../../packages/notifications/src/texts.js')
  return {
    sseManager: { sendToUser: vi.fn(), sendToTenant: vi.fn() },
    loadTenantBrand: vi.fn(async () => ({ displayName: 'ACME', senderName: 'ACME IT', replyTo: null, logo: null })),
    sendTenantEmail: vi.fn(async () => undefined),
    loadNotificationLocale: vi.fn(async () => ({ language: 'en', timeZone: 'UTC' })),
    notificationText: texts.notificationText,
  }
})
vi.mock('../../../lib/emailTemplates.js', () => ({
  mentionNotification: vi.fn().mockReturnValue({ subject: 'Mention', html: '<p/>', text: 'x' }),
  watcherNotification: vi.fn().mockReturnValue({ subject: 'Update', html: '<p/>', text: 'x' }),
}))

const { collaborationResolvers, notifyMentions, notifyWatchers, getEntityTitle } = await import('../collaboration.js')
const { tenantRoles } = await import('../../../lib/roles.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { sseManager, sendTenantEmail, loadNotificationLocale } = await import('@opengraphity/notifications')
const { watcherNotification } = await import('../../../lib/emailTemplates.js')
const { logger } = await import('../../../lib/logger.js')
const { audit } = await import('../../../lib/audit.js')

const base = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'agent@test.io' }
const asRole = (role: GraphQLContext['role']): GraphQLContext => ({ ...base, role, permissions: perms(role) }) as GraphQLContext
const Q = collaborationResolvers.Query
const M = collaborationResolvers.Mutation

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([] as never)
  vi.mocked(runQueryOne).mockResolvedValue(null as never)
})

describe('searchUsers', () => {
  it('searches active users of the tenant only, 5 by default', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ id: 'u-2', name: 'Bob', email: 'bob@x' }] as never)
    await expect(Q.searchUsers(null, { search: 'bo' }, asRole('operator'))).resolves.toEqual([{ id: 'u-2', name: 'Bob', email: 'bob@x' }])
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('coalesce(u.active, true) = true')
    expect(params).toEqual({ tenantId: 'tenant-1', search: 'bo', limit: 5, roles: null })
  })

  /*
   * «Who can do this job» (tour of 23 Sep 2026): the change-owner picker
   * downloaded the whole organization — 3,001 people on the demo — to keep the
   * ones whose role has «Changes: work». The server now filters by the roles
   * that grant the permission, as the user types.
   */
  it('with a permission, only the people whose role grants it', async () => {
    vi.mocked(tenantRoles).mockResolvedValueOnce(new Map([
      ['admin', { key: 'admin', permissions: new Set(['change.write', 'incident.write']) }],
      ['operator', { key: 'operator', permissions: new Set(['change.write']) }],
      ['end_user', { key: 'end_user', permissions: new Set(['portal.submit']) }],
    ]) as never)
    await Q.searchUsers(null, { search: 'an', permission: 'change.write' }, asRole('operator'))
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('($roles IS NULL OR u.role IN $roles)')
    expect((params as { roles: string[] }).roles).toEqual(['admin', 'operator'])
  })

  it('a permission no role grants answers nobody, without asking the graph', async () => {
    vi.mocked(tenantRoles).mockResolvedValueOnce(new Map([['end_user', { key: 'end_user', permissions: new Set(['portal.submit']) }]]) as never)
    await expect(Q.searchUsers(null, { search: 'an', permission: 'change.write' }, asRole('operator'))).resolves.toEqual([])
    expect(vi.mocked(runQuery)).not.toHaveBeenCalled()
  })

  it('an unknown permission is an error, not «nobody»', async () => {
    await expect(Q.searchUsers(null, { search: 'an', permission: 'change.fly' }, asRole('operator'))).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
  })

  it('caps the page at 20 whatever the client asks', async () => {
    await Q.searchUsers(null, { search: 'a', limit: 10_000 }, asRole('operator'))
    expect((vi.mocked(runQuery).mock.calls[0]![2] as { limit: number }).limit).toBe(20)
  })
})

describe('watchers / isWatching', () => {
  it('lists the watchers of an entity of the tenant, with an empty date when missing', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { id: 'u-1', name: 'Ada', email: 'a@x', watchedAt: '2026-09-01' },
      { id: 'u-2', name: 'Bob', email: 'b@x', watchedAt: null },
    ] as never)
    const out = await Q.watchers(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))
    expect(out).toEqual([
      { id: 'u-1', name: 'Ada', email: 'a@x', watchedAt: '2026-09-01' },
      { id: 'u-2', name: 'Bob', email: 'b@x', watchedAt: '' },
    ])
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ entityId: 'inc-1', tenantId: 'tenant-1' })
  })

  it('isWatching is true only when the caller watches the entity', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ c: 1 } as never)
    await expect(Q.isWatching(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))).resolves.toBe(true)
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ userId: 'user-1', entityId: 'inc-1', tenantId: 'tenant-1' })
    vi.mocked(runQueryOne).mockResolvedValueOnce({ c: 0 } as never)
    await expect(Q.isWatching(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))).resolves.toBe(false)
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(Q.isWatching(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))).resolves.toBe(false)
  })
})

describe('watch / unwatch / add / remove', () => {
  it('watchEntity links the caller, within the tenant, and audits it', async () => {
    await expect(M.watchEntity(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))).resolves.toBe(true)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    // Both ends are matched in the tenant: no watching another customer's ticket.
    expect(cypher).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(cypher).toContain('MATCH (e:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ userId: 'user-1', tenantId: 'tenant-1', entityId: 'inc-1' })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'entity.watched', 'incident', 'inc-1')
  })

  it('unwatchEntity removes only the caller link', async () => {
    await expect(M.unwatchEntity(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))).resolves.toBe(true)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ userId: 'user-1', tenantId: 'tenant-1', entityId: 'inc-1' })
  })

  it('addWatcher / removeWatcher act on the named user and are audited with who', async () => {
    await M.addWatcher(null, { entityType: 'problem', entityId: 'prb-1', userId: 'u-9' }, asRole('operator'))
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ userId: 'u-9', tenantId: 'tenant-1', entityId: 'prb-1' })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'watcher.added', 'problem', 'prb-1', { watcherId: 'u-9' })
    await M.removeWatcher(null, { entityType: 'problem', entityId: 'prb-1', userId: 'u-9' }, asRole('operator'))
    expect(vi.mocked(runQuery).mock.calls[1]![2]).toEqual({ userId: 'u-9', tenantId: 'tenant-1', entityId: 'prb-1' })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'watcher.removed', 'problem', 'prb-1', { watcherId: 'u-9' })
  })
})

describe('internalMessages', () => {
  // Review of 23 Sep 2026: the internal chat of a ticket type is for who reads that type.
  it('a role with the internal chat but without the ticket type\'s read permission is refused, before any query', async () => {
    const chatNoIncidents = { ...base, role: 'custom', permissions: new Set(['ticket.internalChat', 'request.read']) } as unknown as GraphQLContext
    await expect(Q.internalMessages(null, { entityType: 'incident', entityId: 'inc-1' }, chatNoIncidents)).rejects.toThrow(/incident\.read/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('returns the latest page in chronological order, reading legacy mention formats', async () => {
    // The query sorts newest first (for LIMIT); the chat shows oldest first.
    vi.mocked(runQuery).mockResolvedValueOnce([
      { props: { id: 'm-3', author_id: 'u', author_name: 'Ada', body: 'c', mentions: '["u-2"]', created_at: '3', edited_at: '4' } },
      { props: { id: 'm-2', author_id: 'u', author_name: 'Ada', body: 'b', mentions: 'not json', created_at: '2' } },
      { props: { id: 'm-1', author_id: 'u', author_name: 'Ada', body: 'a', mentions: null, created_at: '1' } },
    ] as never)
    const out = await Q.internalMessages(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('operator'))
    expect(out.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3'])
    expect(out[2]).toMatchObject({ mentions: ['u-2'], editedAt: '4' })
    // A corrupt value does not break the chat: no mentions for that message.
    expect(out[1]).toMatchObject({ mentions: [], editedAt: null })
    expect(out[0]!.mentions).toEqual([])
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).not.toContain('$before')
    expect(params).toEqual({ entityId: 'inc-1', tenantId: 'tenant-1', entityType: 'incident', limit: 50, before: null })
  })

  it('pages backwards with before and caps the page at 100', async () => {
    await Q.internalMessages(null, { entityType: 'incident', entityId: 'inc-1', limit: 500, before: '2026-09-01' }, asRole('operator'))
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('AND m.created_at < $before')
    expect(params).toMatchObject({ limit: 100, before: '2026-09-01' })
  })
})

describe('sendInternalMessage', () => {
  it('refuses an entity type that has no internal chat, before writing', async () => {
    await expect(M.sendInternalMessage(null, { entityType: 'Tenant', entityId: 't', body: 'x' }, asRole('admin')))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.entityType', params: { entityType: 'Tenant' } } } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a failing watcher or mention notification is logged, never an unhandled rejection', async () => {
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('CREATE (m:InternalMessage') ? [{ props: { id: 'm-1', body: 'hi', mentions: ['u-2'] } }] : []) as never)
    vi.mocked(runQueryOne).mockResolvedValue({ title: 'Printer down' } as never)
    // Both notifiers start by loading the locale: make it fail.
    vi.mocked(loadNotificationLocale).mockRejectedValue(new Error('redis down'))
    const out = await M.sendInternalMessage(null, { entityType: 'incident', entityId: 'inc-1', body: 'hi @[Bob](u-2)' }, asRole('admin'))
    expect(out).toMatchObject({ id: 'm-1' })
    await vi.waitFor(() => {
      const msgs = vi.mocked(logger.error).mock.calls.map((c) => c[1])
      expect(msgs).toContain('[collaboration] watchers NOT notified of the internal message')
      expect(msgs).toContain('[collaboration] mentioned people NOT notified of the internal message')
    })
    vi.mocked(loadNotificationLocale).mockResolvedValue({ language: 'en', timeZone: 'UTC' } as never)
  })
})

describe('editInternalMessage', () => {
  it('updates the own message within the window and returns it with the new mentions', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'm-1', body: 'new @[Bob](u-2)', mentions: ['u-2'], edited_at: 'now' } }] as never)
    const out = await M.editInternalMessage(null, { messageId: 'm-1', body: 'new @[Bob](u-2)' }, asRole('operator'))
    expect(out).toMatchObject({ id: 'm-1', mentions: ['u-2'], editedAt: 'now' })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ id: 'm-1', tenantId: 'tenant-1', authorId: 'user-1', mentions: ['u-2'] })
  })
})

describe('deleteInternalMessage', () => {
  it('returns true when a message was deleted', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ n: 1 }] as never)
    await expect(M.deleteInternalMessage(null, { messageId: 'm-1' }, asRole('operator'))).resolves.toBe(true)
  })
})

describe('getEntityTitle', () => {
  it('falls back to the id when the entity has no title (or is not in the tenant)', async () => {
    await expect(getEntityTitle('tenant-1', 'inc-1')).resolves.toBe('inc-1')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'inc-1', t: 'tenant-1' })
  })
})

describe('notifyMentions', () => {
  it('a comment mention uses the comment text, and a mailer failure is logged per person', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ email: 'bob@x', enabled: true } as never)
    vi.mocked(sendTenantEmail).mockRejectedValueOnce(new Error('smtp down'))
    await notifyMentions('tenant-1', 'Ada', 'incident', 'inc-1', 'Printer down', ['u-2', 'u-3'], 'comment', 'look at this')
    expect(sseManager.sendToUser).toHaveBeenCalledWith('tenant-1', 'u-2', expect.objectContaining({ message_key: 'inApp.mention.message' }))
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2', entityId: 'inc-1' }), expect.stringContaining('mention email failed'))
    // The failure for u-2 does not stop the e-mail to u-3.
    expect(sendTenantEmail).toHaveBeenCalledTimes(2)
  })
})

describe('notifyWatchers', () => {
  it('a text event (portal comment) is sent verbatim, the author is skipped, and e-mail goes to enabled watchers', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ userId: 'author', role: 'operator' }, { userId: 'w-1', role: 'end_user' }] as never)
    vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('e.title') ? { title: 'Printer down' } : { email: 'w1@x', enabled: true }) as never)
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'text', text: 'Customer wrote: still broken' }, 'author')
    expect(vi.mocked(sseManager.sendToUser).mock.calls.map((c) => c[1])).toEqual(['w-1'])
    const payload = vi.mocked(sseManager.sendToUser).mock.calls[0]![2] as Record<string, unknown>
    // Human text is not translated: no message key.
    expect(payload).toMatchObject({ type: 'watcher', message: 'Customer wrote: still broken' })
    expect(payload).not.toHaveProperty('message_key')
    expect(watcherNotification).toHaveBeenCalledWith(
      expect.objectContaining({ entityTitle: 'Printer down', event: 'Customer wrote: still broken' }), expect.anything(), expect.anything(),
    )
    expect(sendTenantEmail).toHaveBeenCalledWith('tenant-1', expect.objectContaining({ to: 'w1@x' }))
  })

  it('a watcher who turned off notifications gets the in-app notice but no e-mail', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ userId: 'w-1', role: 'operator' }] as never)
    vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('e.title') ? null : { email: 'w1@x', enabled: false }) as never)
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'comment', author: 'Ada' })
    expect(sseManager.sendToUser).toHaveBeenCalledTimes(1)
    expect(sendTenantEmail).not.toHaveBeenCalled()
  })

  it('internal content: a watcher without a role is not notified', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ userId: 'w-1', role: null }] as never)
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'internal_chat', author: 'Ada' }, undefined, true)
    expect(sseManager.sendToUser).not.toHaveBeenCalled()
  })

  it('an e-mail failure for one watcher is logged and the others are still notified', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ userId: 'w-1', role: 'operator' }, { userId: 'w-2', role: 'operator' }] as never)
    vi.mocked(runQueryOne).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('e.title') ? { title: 'T' } : { email: 'w@x', enabled: true }) as never)
    vi.mocked(sendTenantEmail).mockRejectedValueOnce(new Error('smtp down'))
    await notifyWatchers('tenant-1', 'incident', 'inc-1', { kind: 'comment', author: 'Ada' })
    expect(vi.mocked(sseManager.sendToUser).mock.calls.map((c) => c[1])).toEqual(['w-1', 'w-2'])
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ userId: 'w-1' }), expect.stringContaining('watcher email failed'))
    expect(sendTenantEmail).toHaveBeenCalledTimes(2)
  })
})

describe('permissions', () => {
  it('the internal chat read is refused without ticket.internalChat', async () => {
    await expect(Q.internalMessages(null, { entityType: 'incident', entityId: 'inc-1' }, asRole('end_user'))).rejects.toBeInstanceOf(GraphQLError)
  })
})
