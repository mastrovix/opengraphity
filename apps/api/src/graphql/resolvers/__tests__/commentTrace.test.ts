/**
 * Verifica «Cosa resta cablato», ondata 6: l'autore modifica o cancella il
 * proprio commento, l'admin qualunque; la modifica e la cancellazione restano
 * visibili (chi e quando) e il testo di prima va nell'Audit Log. Prima la
 * modifica valeva solo per l'autore nei primi 15 minuti e la cancellazione era
 * fisica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { GraphQLContext } from '../../../context.js'

const h = vi.hoisted(() => ({ reads: [] as Array<Record<string, unknown>>, writes: [] as Array<{ q: string; p: Record<string, unknown> }> }))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: h.reads.map((r) => ({ get: (k: string) => r[k] })) }) })),
    executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: async (q: string, p: Record<string, unknown>) => {
      h.writes.push({ q, p })
      return { records: [{ get: (k: string) => ({ id: 'c1', body: p['body'] ?? '', isInternal: true, authorId: 'u-author', authorName: 'A', authorEmail: 'a@x', createdAt: 'T', updatedAt: 'T', editedAt: p['now'] ?? null, editedByName: 'A', deletedAt: null, deletedByName: null } as Record<string, unknown>)[k] }] }
    } })),
    close: vi.fn(),
  })),
  runQuery: vi.fn(),
}))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
vi.mock('../collaboration.js', () => ({ notifyMentions: vi.fn(), notifyWatchers: vi.fn(), autoWatch: vi.fn(), getEntityTitle: vi.fn() }))

const { updateComment, deleteComment } = await import('../comments.js')

const ctx = (userId: string, role: GraphQLContext['role']): GraphQLContext => ({ tenantId: 't1', userId, userEmail: `${userId}@x`, role, permissions: perms(role) })
const stored = (over: Record<string, unknown> = {}) => ({ authorId: 'u-author', text: 'testo di prima', deletedAt: null, isInternal: true, entityType: 'incident', entityId: 'i1', ...over })
const codeOf = async (p: Promise<unknown>) => p.then(() => null, (e: { extensions?: { code?: string } }) => e.extensions?.code ?? 'THROWN')

beforeEach(() => { h.reads = [stored()]; h.writes = []; audit.mockClear() })

describe('modifica di un commento', () => {
  it('l\'autore la fa senza limite di tempo; resta la traccia e il testo di prima va nell\'Audit Log', async () => {
    const out = await updateComment(null, { id: 'c1', body: '  testo nuovo ' }, ctx('u-author', 'operator'))
    expect(out.editedAt).not.toBeNull()
    expect(h.writes[0]!.q).toContain('c.edited_at = $now')
    expect(h.writes[0]!.q).toContain('c.edited_by_name')
    expect(h.writes[0]!.p).toMatchObject({ body: 'testo nuovo' })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'comment.edited', 'incident', 'i1', { commentId: 'c1', previousText: 'testo di prima' })
  })

  it('un altro operatore no; l\'admin sì; un commento cancellato non si modifica', async () => {
    expect(await codeOf(updateComment(null, { id: 'c1', body: 'x' }, ctx('u-other', 'operator')))).toBe('FORBIDDEN')
    expect(await codeOf(updateComment(null, { id: 'c1', body: 'x' }, ctx('u-admin', 'admin')))).toBeNull()
    h.reads = [stored({ deletedAt: 'T2' })]
    expect(await codeOf(updateComment(null, { id: 'c1', body: 'x' }, ctx('u-author', 'operator')))).toBe('BAD_USER_INPUT')
  })

  it('dal portale solo sulle proprie risposte pubbliche', async () => {
    expect(await codeOf(updateComment(null, { id: 'c1', body: 'x' }, ctx('u-author', 'end_user')))).toBe('NOT_FOUND')
    h.reads = [stored({ isInternal: false })]
    expect(await codeOf(updateComment(null, { id: 'c1', body: 'x' }, ctx('u-author', 'end_user')))).toBeNull()
  })
})

describe('cancellazione di un commento', () => {
  it('è una traccia, non una cancellazione fisica: testo vuoto, chi e quando, testo nell\'Audit Log', async () => {
    await deleteComment(null, { id: 'c1' }, ctx('u-author', 'operator'))
    expect(h.writes[0]!.q).not.toContain('DELETE c')
    expect(h.writes[0]!.q).toContain("c.text = ''")
    expect(h.writes[0]!.q).toContain('c.deleted_at = $now')
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'comment.deleted', 'incident', 'i1', { commentId: 'c1', deletedText: 'testo di prima' })
  })
})
