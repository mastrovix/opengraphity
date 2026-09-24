/**
 * resolvers/ciRelationships.ts — Servizi monitorati, ondata 5 (mappa viva):
 * aggiungere o togliere una relazione fra CI avvisa il motore dei servizi
 * DOPO il commit, con entrambi i capi, e un errore della coda non fa fallire
 * la mutation (la notifica non lancia mai: services/serviceImpact/sync.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../../lib/cache.js', () => ({
  cache: { get: vi.fn(() => null), set: vi.fn(), invalidate: vi.fn() },
  // Il resolver costruisce le chiavi con la sorgente unica di lib/cache.ts
  // (`METAMODEL_CACHE_PREFIXES`): il finto deve esporla come il vero modulo.
  metamodelCacheKey: (prefix: string, tenantId: string) => `${prefix}:${tenantId}`,
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/chainCalculator.js', () => ({ calculateChain: vi.fn().mockResolvedValue(undefined), recalculateChainsFrom: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:Server)`),
}))

const { ciRelationshipResolvers } = await import('../ciRelationships.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { notifyCIGraphChanged } = await import('../../../services/serviceImpact/sync.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') as const }
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
    if (cypher.includes('AS declared')) return { declared: true }
    return { deleted: 1 }
  }) as never)
})

describe('addCIRelationship / removeCIRelationship: notifica ai servizi monitorati (ondata 5)', () => {
  it('aggiunta: notifica con ENTRAMBI i capi, dopo la scrittura della relazione', async () => {
    expect(await ciRelationshipResolvers.Mutation.addCIRelationship(null, { sourceId: 'app-3', targetId: 'srv-9', relationType: 'DEPENDS_ON' }, ctx)).toBe(true)
    expect(notifyCIGraphChanged).toHaveBeenCalledWith('t1', ['app-3', 'srv-9'], 'ci_relationship.added:DEPENDS_ON')
    expect(vi.mocked(notifyCIGraphChanged).mock.invocationCallOrder[0]!).toBeGreaterThan(session.executeWrite.mock.invocationCallOrder[0]!)
    // The chain flows downstream: the target and what lies below it are recomputed (review of 23 Sep 2026).
    const { recalculateChainsFrom } = await import('../../../lib/chainCalculator.js')
    expect(recalculateChainsFrom).toHaveBeenCalledWith('srv-9', 't1')
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

  /** Giro nel browser del 14 set 2026 (#56): la tabella a mano contraddiceva il metamodello. */
  it('una relazione non dichiarata dal metamodello fra i due tipi è rifiutata col suo nome, senza scrittura', async () => {
    vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('RETURN labels(s) AS sLabels')) return { sLabels: ['ConfigurationItem', 'Certificate'], tLabels: ['ConfigurationItem', 'Application'] }
      if (cypher.includes('AS declared')) {
        expect(params).toMatchObject({ relationType: 'HOSTED_ON', tenantId: 't1' })
        return { declared: false }
      }
      return null
    }) as never)
    const err = await ciRelationshipResolvers.Mutation.addCIRelationship(null, { sourceId: 'c', targetId: 'a', relationType: 'HOSTED_ON' }, ctx).then(() => null, (e: Error & { extensions?: Record<string, unknown> }) => e)
    expect(err?.message).toBe('HOSTED_ON from Certificate to Application is not declared in the metamodel')
    expect(err?.extensions?.['i18n']).toMatchObject({ key: 'errors.ci.relationNotDeclared' })
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('la dichiarazione si cerca in uscita dal tipo sorgente E in entrata sul tipo destinazione, tipi multipli compresi', async () => {
    await ciRelationshipResolvers.Mutation.addCIRelationship(null, { sourceId: 'app-3', targetId: 'srv-9', relationType: 'DEPENDS_ON' }, ctx)
    const cypher = String(vi.mocked(runQueryOne).mock.calls.find((c) => String(c[1]).includes('AS declared'))![1])
    expect(cypher).toContain("out.direction = 'outgoing'")
    expect(cypher).toContain("inc.direction = 'incoming'")
    expect(cypher).toContain("split(out.relationship_type, '|')")
    // Visto dal vivo: `RETURN outgoing + count(inc)` è rifiutato da Neo4j
    // (aggregazione mescolata a una chiave di raggruppamento implicita).
    expect(cypher).toMatch(/WITH outgoing, count\(inc\) AS incoming\s+RETURN outgoing \+ incoming > 0 AS declared/)
  })

  // ── Revisione del 15 set 2026 · CM-4 / CM-11 ─────────────────────────────
  it('CM-4: un arco si toglie anche se la sua definizione non c\'è più (prima «Invalid relation type», per sempre)', async () => {
    // Nessuna definizione dichiara PROTECTS: la rimozione non le legge nemmeno.
    expect(await ciRelationshipResolvers.Mutation.removeCIRelationship(null, { sourceId: 'fw-1', targetId: 'srv-9', relationType: 'PROTECTS' }, ctx)).toBe(true)
    expect(runQuery).not.toHaveBeenCalled()
    const del = vi.mocked(runQueryOne).mock.calls.find((c) => String(c[1]).includes('DELETE r'))!
    expect(String(del[1])).toContain('a:Application OR a:Server')
    expect(String(del[1])).toContain('b:Application OR b:Server')
  })

  it('CM-11: togliere un arco che non c\'è → NOT_FOUND, niente notifica né audit', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ deleted: 0 } as never)
    await expect(ciRelationshipResolvers.Mutation.removeCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'DEPENDS_ON' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(notifyCIGraphChanged).not.toHaveBeenCalled()
  })
})
