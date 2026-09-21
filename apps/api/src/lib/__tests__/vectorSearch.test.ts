/**
 * Revisione totale · B-12: l'indice vettoriale è cross-tenant, quindi i K
 * vicini più prossimi possono essere TUTTI di altri clienti. Prima il K era
 * fisso (`limit * 4 + 10`, o 15/30 nei servizi) e il filtro sul tenant veniva
 * applicato dopo: un cliente piccolo in un'installazione con clienti grandi
 * riceveva una lista vuota, senza errore e senza spiegazione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({ runQuery: (...a: unknown[]) => runQuery(...a) }))
const info = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ info, warn: vi.fn(), error: vi.fn() }) } }))

const { vectorSearchForTenant, firstK, K_MAX } = await import('../vectorSearch.js')

const session = {} as never
const base = { index: 'idx', embedding: [0.1, 0.2], tenantId: 'tenant-1', returns: 'node.id AS id', what: 'test' }

/** I K usati, nell'ordine in cui la ricerca li ha provati. */
const usedK = () => runQuery.mock.calls.map((c) => (c[2] as { k: number }).k)

beforeEach(() => { runQuery.mockReset(); info.mockReset() })

describe('vectorSearchForTenant', () => {
  it('trovati subito i risultati del tenant: un solo giro, con il K di partenza', async () => {
    runQuery.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const rows = await vectorSearchForTenant(session, { ...base, limit: 3 })
    expect(rows).toHaveLength(3)
    expect(usedK()).toEqual([firstK(3)])
    expect(info).not.toHaveBeenCalled()
  })

  it('i vicini globali sono di altri tenant: K cresce finché i risultati bastano', async () => {
    runQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'a' }])
    const rows = await vectorSearchForTenant(session, { ...base, limit: 1 })
    expect(rows).toEqual([{ id: 'a' }])
    const ks = usedK()
    expect(ks).toHaveLength(2)
    expect(ks[1]!).toBeGreaterThan(ks[0]!)
  })

  it('tetto di K: si smette di allargare, si restituisce quel che c\'è e lo si scrive nel log', async () => {
    runQuery.mockResolvedValue([])
    const rows = await vectorSearchForTenant(session, { ...base, limit: 5 })
    expect(rows).toEqual([])
    expect(usedK().at(-1)).toBe(K_MAX)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]![1]).toMatch(/tetto di K/)
  })

  it('il tenant è sempre nel WHERE, il K e il limite viaggiano come parametri, le condizioni del chiamante sono in AND', async () => {
    runQuery.mockResolvedValueOnce([{ id: 'a' }])
    await vectorSearchForTenant(session, {
      ...base, limit: 1, where: 'node.id <> $selfId', extra: 'OPTIONAL MATCH (node)-[:ASSIGNED_TO_TEAM]->(team:Team)',
      params: { selfId: 'x' },
    })
    const [, cypher, params] = runQuery.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('WHERE node.tenant_id = $tenantId AND node.id <> $selfId')
    expect(cypher).toContain('CALL db.index.vector.queryNodes($index, $k, $embedding)')
    expect(cypher).toContain('OPTIONAL MATCH (node)-[:ASSIGNED_TO_TEAM]->(team:Team)')
    expect(cypher).toContain('LIMIT toInteger($vectorLimit)')
    expect(params).toMatchObject({ tenantId: 'tenant-1', selfId: 'x', vectorLimit: 1 })
  })
})
