/**
 * resolvers/ciRelationships.ts — Servizi monitorati, ondata 5 (mappa viva):
 * aggiungere o togliere una relazione fra CI avvisa il motore dei servizi
 * DOPO il commit, con entrambi i capi, e un errore della coda non fa fallire
 * la mutation (la notifica non lancia mai: services/serviceImpact/sync.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../../lib/cache.js', () => ({ cache: { get: vi.fn(() => null), set: vi.fn(), invalidate: vi.fn() } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/chainCalculator.js', () => ({ calculateChain: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(1) }))

const { ciRelationshipResolvers } = await import('../ciRelationships.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { notifyCIGraphChanged } = await import('../../../services/serviceImpact/sync.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin' as const }
const txRun = vi.fn().mockResolvedValue({ records: [] })
const session = {
  close: vi.fn().mockResolvedValue(undefined),
  executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work({ run: txRun })),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQuery).mockResolvedValue([] as never)   // nessun tipo dal metamodello: restano i tipi di base
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('RETURN labels(s) AS sLabels')) return { sLabels: ['Application'], tLabels: ['Server'] }
    if (cypher.includes('hasCycle')) return { hasCycle: false }
    return { deleted: true }
  }) as never)
})

describe('addCIRelationship / removeCIRelationship: notifica ai servizi monitorati (ondata 5)', () => {
  it('aggiunta: notifica con ENTRAMBI i capi, dopo la scrittura della relazione', async () => {
    expect(await ciRelationshipResolvers.Mutation.addCIRelationship(null, { sourceId: 'app-3', targetId: 'srv-9', relationType: 'DEPENDS_ON' }, ctx)).toBe(true)
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('t1', ['app-3', 'srv-9'], 'ci_relationship.added:DEPENDS_ON')
    expect(vi.mocked(notifyCIGraphChanged).mock.invocationCallOrder[0]!).toBeGreaterThan(session.executeWrite.mock.invocationCallOrder[0]!)
  })

  it('rimozione: stessa notifica (una relazione tolta fa uscire dei componenti)', async () => {
    expect(await ciRelationshipResolvers.Mutation.removeCIRelationship(null, { sourceId: 'app-3', targetId: 'srv-9', relationType: 'HOSTED_ON' }, ctx)).toBe(true)
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('t1', ['app-3', 'srv-9'], 'ci_relationship.removed:HOSTED_ON')
  })

  it('relazione rifiutata (tipo non ammesso): nessuna notifica, nessuna scrittura', async () => {
    await expect(ciRelationshipResolvers.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'MANGIA' }, ctx)).rejects.toThrow(/Invalid relation type/)
    expect(notifyCIGraphChanged).not.toHaveBeenCalled()
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})
