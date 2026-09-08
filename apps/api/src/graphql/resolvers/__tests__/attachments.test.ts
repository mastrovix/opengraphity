/**
 * attachments.ts (GraphQL) — deleteAttachment: fuori tenant → NOT_FOUND senza
 * scrittura né unlink; non-owner non-admin → FORBIDDEN; owner/admin → nodo
 * rimosso + file cancellato; lista allegati scoped per tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('fs/promises', () => ({ unlink: vi.fn().mockResolvedValue(undefined) }))

const { attachmentResolvers } = await import('../attachments.js')
const { getSession } = await import('@opengraphity/neo4j')
const { unlink } = await import('fs/promises')
const { logger } = await import('../../../lib/logger.js')

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

function fakeSession(readResults: Array<{ records: unknown[] }>) {
  const reads = [...readResults]
  const txRun = vi.fn()
  const s = {
    txRun,
    executeRead:  vi.fn().mockImplementation(async (fn: (tx: { run: typeof txRun }) => unknown) => {
      txRun.mockResolvedValueOnce(reads.shift() ?? { records: [] })
      return fn({ run: txRun })
    }),
    executeWrite: vi.fn().mockImplementation(async (fn: (tx: { run: typeof txRun }) => unknown) => {
      txRun.mockResolvedValueOnce({ records: [] })
      return fn({ run: txRun })
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const operator: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator' }
const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }

describe('deleteAttachment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('allegato di un altro tenant (lookup vuoto) → NOT_FOUND, nessuna scrittura, nessun unlink, sessione chiusa', async () => {
    const s = fakeSession([{ records: [] }])

    const err = await attachmentResolvers.Mutation.deleteAttachment(null, { id: 'att-altrui' }, operator).then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect(s.txRun).toHaveBeenCalledOnce()
    expect(s.txRun.mock.calls[0]![0]).toContain('MATCH (a:Attachment {id: $id, tenant_id: $tenantId})')
    expect(s.txRun.mock.calls[0]![1]).toEqual({ id: 'att-altrui', tenantId: 'tenant-1' })
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('utente diverso dall\'uploader e non admin → FORBIDDEN, nessuna scrittura né unlink', async () => {
    const s = fakeSession([{ records: [rec({ uploadedBy: 'user-2', storagePath: '/data/att/x.pdf' })] }])

    const err = await attachmentResolvers.Mutation.deleteAttachment(null, { id: 'att-1' }, operator).then(() => null, (e: unknown) => e)

    expect((err as GraphQLError).extensions['code']).toBe('FORBIDDEN')
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  })

  it('uploader → DETACH DELETE scoped per tenant + unlink dello storage_path → true', async () => {
    const s = fakeSession([{ records: [rec({ uploadedBy: 'user-1', storagePath: '/data/att/x.pdf' })] }])

    const out = await attachmentResolvers.Mutation.deleteAttachment(null, { id: 'att-1' }, operator)

    expect(out).toBe(true)
    expect(s.executeWrite).toHaveBeenCalledOnce()
    const del = s.txRun.mock.calls[1]!
    expect(del[0]).toContain('MATCH (a:Attachment {id: $id, tenant_id: $tenantId})')
    expect(del[0]).toContain('DETACH DELETE a')
    expect(del[1]).toEqual({ id: 'att-1', tenantId: 'tenant-1' })
    expect(unlink).toHaveBeenCalledWith('/data/att/x.pdf')
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('admin non uploader → può cancellare', async () => {
    const s = fakeSession([{ records: [rec({ uploadedBy: 'user-2', storagePath: '/data/att/y.pdf' })] }])

    await expect(attachmentResolvers.Mutation.deleteAttachment(null, { id: 'att-2' }, admin)).resolves.toBe(true)
    expect(s.executeWrite).toHaveBeenCalledOnce()
    expect(unlink).toHaveBeenCalledWith('/data/att/y.pdf')
  })

  it('unlink fallito → nodo comunque rimosso, true, warning loggato (best-effort dichiarato)', async () => {
    fakeSession([{ records: [rec({ uploadedBy: 'user-1', storagePath: '/data/att/gone.pdf' })] }])
    vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    await expect(attachmentResolvers.Mutation.deleteAttachment(null, { id: 'att-1' }, operator)).resolves.toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ id: 'att-1', storagePath: '/data/att/gone.pdf' }), '[attachment] file delete failed')
  })
})

describe('attachments(entityType, entityId) — lista scoped per tenant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('query con tenant_id/entity_type/entity_id dal contesto e mapping con downloadUrl', async () => {
    const s = fakeSession([{ records: [rec({
      id: 'att-1', filename: 'log.txt', mimeType: 'text/plain', sizeBytes: { toNumber: () => 1234 },
      uploadedBy: 'user-1', uploadedAt: '2026-01-01T00:00:00Z', description: null,
    })] }])

    const out = await attachmentResolvers.Query.attachments(null, { entityType: 'incident', entityId: 'inc-1' }, operator)

    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $entityType, entity_id: $entityId})')
    expect(params).toEqual({ tenantId: 'tenant-1', entityType: 'incident', entityId: 'inc-1' })
    expect(out).toEqual([{
      id: 'att-1', filename: 'log.txt', mimeType: 'text/plain', sizeBytes: 1234,
      uploadedBy: 'user-1', uploadedAt: '2026-01-01T00:00:00Z', description: null, downloadUrl: '/api/attachments/att-1',
    }])
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('entità di un altro tenant → lista vuota (mai i suoi allegati)', async () => {
    fakeSession([{ records: [] }])
    await expect(attachmentResolvers.Query.attachments(null, { entityType: 'incident', entityId: 'inc-altrui' }, operator)).resolves.toEqual([])
  })
})
