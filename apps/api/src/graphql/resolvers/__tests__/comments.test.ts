/**
 * THE GENERIC COMMENTS API — reading, adding, and who hears about a comment.
 *
 * commentTrace.test.ts pins edit/delete as a trace. This file pins the rest:
 * - the entity type is interpolated into the Cypher as a label, so only the
 *   commentable allowlist gets through;
 * - reading is scoped to the tenant and can hide internal notes (the portal
 *   must never see them);
 * - adding a comment to a ticket that does not exist in the tenant is a
 *   NOT_FOUND, not an orphan comment the author believes was published;
 * - a comment is an internal note unless the caller explicitly says otherwise;
 * - a failing notification never fails the comment (and never becomes an
 *   unhandled rejection, which on Node 24 kills the process);
 * - an internal note is announced to watchers as internal, so the portal user
 *   watching the ticket is not told about something they cannot read;
 * - from the portal, a closed ticket's conversation can no longer change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const h = vi.hoisted(() => ({
  readResults: [] as Array<{ records: Array<{ get: (k: string) => unknown }> }>,
  readCalls: [] as Array<{ q: string; p: Record<string, unknown> }>,
}))
const close = vi.fn().mockResolvedValue(undefined)
const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: async (fn: (tx: unknown) => unknown) => fn({
      run: async (q: string, p: Record<string, unknown>) => {
        h.readCalls.push({ q, p })
        return h.readResults.shift() ?? { records: [] }
      },
    }),
    executeWrite: async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: [] }) }),
    close,
  })),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const errorLog = vi.fn()
vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: (...a: unknown[]) => errorLog(...a) },
}))
const isEntityClosed = vi.fn()
vi.mock('../../../lib/workflowHelpers.js', () => ({ isEntityClosed: (...a: unknown[]) => isEntityClosed(...a) }))
const collab = vi.hoisted(() => ({
  autoWatch: vi.fn(), notifyMentions: vi.fn(), notifyWatchers: vi.fn(), getEntityTitle: vi.fn(),
}))
vi.mock('../collaboration.js', () => collab)

const C = await import('../comments.js')

const ctx = (role: string, userId = 'u1'): GraphQLContext =>
  ({ tenantId: 't1', userId, userEmail: `${userId}@x`, role, permissions: perms(role) }) as GraphQLContext

const row = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] })
const commentRow = (over: Record<string, unknown> = {}) => row({
  id: 'c1', body: 'hello', isInternal: null, authorId: 'u1', authorName: 'Ann', authorEmail: 'ann@x',
  createdAt: 'T1', updatedAt: 'T1', ...over,
})

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NO ERROR' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  h.readResults = []
  h.readCalls = []
  close.mockResolvedValue(undefined)
  runQuery.mockResolvedValue([{ comment: { id: 'c1' }, author: null }])
  collab.autoWatch.mockResolvedValue(undefined)
  collab.notifyMentions.mockResolvedValue(undefined)
  collab.notifyWatchers.mockResolvedValue(undefined)
  collab.getEntityTitle.mockResolvedValue('Printer on fire')
  isEntityClosed.mockResolvedValue(false)
})

describe('comments (query)', () => {
  it('reads the comments of a tenant ticket, internal ones included by default', async () => {
    h.readResults = [{ records: [commentRow(), commentRow({ id: 'c2', isInternal: true, editedAt: 'T2', editedByName: 'Bob' })] }]
    const out = await C.comments(null, { entityType: 'incident', entityId: 'i1' }, ctx('operator'))
    const { q, p } = h.readCalls[0]!
    expect(q).toContain('MATCH (e:Incident {id: $entityId, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)')
    expect(p).toEqual({ tenantId: 't1', entityId: 'i1', includeInternal: true })
    // A missing is_internal reads as a public reply; missing edit/delete markers are null, not undefined.
    expect(out[0]).toMatchObject({ id: 'c1', isInternal: false, editedAt: null, editedByName: null, deletedAt: null, deletedByName: null })
    expect(out[1]).toMatchObject({ id: 'c2', isInternal: true, editedAt: 'T2', editedByName: 'Bob' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('can hide internal notes', async () => {
    await C.comments(null, { entityType: 'problem', entityId: 'p1', includeInternal: false }, ctx('operator'))
    expect(h.readCalls[0]!.p['includeInternal']).toBe(false)
    expect(h.readCalls[0]!.q).toContain('$includeInternal = true OR c.is_internal = false')
  })

  it('rejects an entity type outside the allowlist before any query', async () => {
    expect(await code(() => C.comments(null, { entityType: 'User', entityId: 'x' }, ctx('operator')))).toBe('BAD_USER_INPUT')
    expect(h.readCalls).toHaveLength(0)
  })
})

describe('addComment', () => {
  it('writes an internal note by default, reads it back in the tenant, and audits it', async () => {
    h.readResults = [{ records: [commentRow({ isInternal: true })] }]
    const out = await C.addComment(null, { entityType: 'incident', entityId: 'i1', body: 'note' }, ctx('operator'))
    const params = runQuery.mock.calls[0]?.[2] as Record<string, unknown>
    expect(params).toMatchObject({ entityId: 'i1', tenantId: 't1', text: 'note', isInternal: true, authorId: 'u1' })
    expect(h.readCalls[0]!.p).toEqual({ commentId: 'c1', tenantId: 't1' })
    expect(out.id).toBe('c1')
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'comment.added', 'incident', 'i1', { commentId: 'c1', isInternal: true })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('isInternal: false makes it a public reply, and watchers are told it is public', async () => {
    h.readResults = [{ records: [commentRow({ isInternal: false })] }]
    await C.addComment(null, { entityType: 'incident', entityId: 'i1', body: 'reply', isInternal: false }, ctx('operator'))
    await flush()
    expect((runQuery.mock.calls[0]?.[2] as Record<string, unknown>)['isInternal']).toBe(false)
    expect(collab.notifyWatchers.mock.calls[0]?.[5]).toBe(false)
  })

  it('a ticket that is not in the tenant is NOT_FOUND and nothing is audited or notified', async () => {
    runQuery.mockResolvedValue([])
    expect(await code(() => C.addComment(null, { entityType: 'incident', entityId: 'other', body: 'x' }, ctx('operator')))).toBe('NOT_FOUND')
    await flush()
    expect(audit).not.toHaveBeenCalled()
    expect(collab.autoWatch).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('rejects a body over 10000 characters without opening a session', async () => {
    expect(await code(() => C.addComment(null, { entityType: 'incident', entityId: 'i1', body: 'x'.repeat(10_001) }, ctx('operator')))).toBe('BAD_REQUEST')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('rejects an entity type outside the allowlist', async () => {
    expect(await code(() => C.addComment(null, { entityType: 'tenant', entityId: 'x', body: 'x' }, ctx('operator')))).toBe('BAD_USER_INPUT')
    expect(runQuery).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a failing notification is logged and does not fail the comment', async () => {
    h.readResults = [{ records: [commentRow()] }]
    collab.autoWatch.mockRejectedValue(new Error('redis down'))
    await expect(C.addComment(null, { entityType: 'incident', entityId: 'i1', body: 'x' }, ctx('operator'))).resolves.toMatchObject({ id: 'c1' })
    await flush()
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(errorLog.mock.calls[0]?.[1]).toContain('NOT notified')
  })
})

describe('notifyCommentAudience', () => {
  it('the author becomes a watcher, the mentioned get the ticket title, watchers get the update', async () => {
    const body = 'ping @[Bob](u-bob) and @[Bob](u-bob) and @[Cy](u-cy)'
    await C.notifyCommentAudience(ctx('operator'), 'incident', 'i1', body, true)
    expect(collab.autoWatch).toHaveBeenCalledWith('t1', 'u1', 'i1')
    // Mentions are de-duplicated, and the phrase uses the ticket title, not its id.
    expect(collab.notifyMentions).toHaveBeenCalledWith('t1', 'u1@x', 'incident', 'i1', 'Printer on fire', ['u-bob', 'u-cy'], 'comment', body.slice(0, 200))
    expect(collab.notifyWatchers).toHaveBeenCalledWith('t1', 'incident', 'i1', { kind: 'comment', author: 'u1@x' }, 'u1', true)
  })

  it('without mentions nobody is mentioned (and the title is not even read)', async () => {
    await C.notifyCommentAudience(ctx('operator'), 'problem', 'p1', 'plain text')
    expect(collab.notifyMentions).not.toHaveBeenCalled()
    expect(collab.getEntityTitle).not.toHaveBeenCalled()
    // Default visibility is public.
    expect(collab.notifyWatchers.mock.calls[0]?.[5]).toBe(false)
  })
})

describe('edit/delete guards not covered elsewhere', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    records: [row({ authorId: 'u1', text: 'before', deletedAt: null, isInternal: false, entityType: 'incident', entityId: 'i1', ...over })],
  })

  it('a comment that does not exist in the tenant is NOT_FOUND', async () => {
    expect(await code(() => C.deleteComment(null, { id: 'nope' }, ctx('operator')))).toBe('NOT_FOUND')
    expect(h.readCalls[0]!.p['tenantId']).toBe('t1')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('from the portal, a closed ticket conversation can no longer be changed', async () => {
    h.readResults = [stored()]
    isEntityClosed.mockResolvedValue(true)
    expect(await code(() => C.deleteComment(null, { id: 'c1' }, ctx('end_user')))).toBe('BAD_USER_INPUT')
    expect(isEntityClosed.mock.calls[0]?.slice(1)).toEqual(['i1', 't1'])
    expect(audit).not.toHaveBeenCalled()
  })

  it('staff can still change a comment on a closed ticket (the closed check is portal-only)', async () => {
    h.readResults = [stored()]
    isEntityClosed.mockResolvedValue(true)
    await expect(C.deleteComment(null, { id: 'c1' }, ctx('operator'))).resolves.toBe(true)
    expect(isEntityClosed).not.toHaveBeenCalled()
  })

  it('deleting someone else\'s comment without the moderation permission is FORBIDDEN, with the delete-specific key', async () => {
    h.readResults = [stored({ authorId: 'someone-else' })]
    let err: GraphQLError | undefined
    try { await C.deleteComment(null, { id: 'c1' }, ctx('operator')) } catch (e) { err = e as GraphQLError }
    expect(err?.extensions?.['code']).toBe('FORBIDDEN')
    expect((err?.extensions?.['i18n'] as { key: string }).key).toBe('errors.comment.deleteForbidden')
  })

  it('an empty or whitespace-only edit is rejected before loading anything', async () => {
    expect(await code(() => C.updateComment(null, { id: 'c1', body: '   ' }, ctx('operator')))).toBe('BAD_USER_INPUT')
    expect(await code(() => C.updateComment(null, { id: 'c1', body: 'x'.repeat(10_001) }, ctx('operator')))).toBe('BAD_USER_INPUT')
    expect(h.readCalls).toHaveLength(0)
  })

  it('a missing text is audited as an empty string rather than "null"', async () => {
    h.readResults = [stored({ text: null })]
    await C.deleteComment(null, { id: 'c1' }, ctx('operator'))
    expect(audit.mock.calls[0]?.[4]).toEqual({ commentId: 'c1', deletedText: '' })
  })
})

describe('commentResolvers', () => {
  it('exposes the query and the three mutations', () => {
    expect(C.commentResolvers.Query.comments).toBe(C.comments)
    expect(Object.keys(C.commentResolvers.Mutation).sort()).toEqual(['addComment', 'deleteComment', 'updateComment'])
  })
})
