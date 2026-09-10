/**
 * scripts/lib/seedServiceMaps.ts — seed demo delle mappe: una mappa per ogni
 * BusinessApplication del tenant senza mappa (query scopata, per nome), con
 * createServiceMap del motore (attore seed, profondità/relazioni degli
 * argomenti); un errore ferma il seed; argomenti validati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn() }))
vi.mock('../../services/serviceImpact/engine.js', () => ({ createServiceMap: vi.fn() }))

const { seedServiceMaps, listCandidates, parseSeedArgs, SEED_ACTOR } = await import('../lib/seedServiceMaps.js')
const { getSession, runQuery } = await import('@opengraphity/neo4j')
const { createServiceMap } = await import('../../services/serviceImpact/engine.js')
const { ScriptArgError } = await import('../lib/scriptArgs.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const created = (mapId: string, nodes: number[]) => ({
  mapId,
  proposal: { serviceName: 'S', maxDepth: 4, relationshipTypes: ['DEPENDS_ON'], nodes: nodes.map((level, i) => ({ ciId: `c${i}`, name: `c${i}`, labels: ['Server'], level, via: null, role: 'component', propagate: 'weighted', weight: 5, critical: false })) },
  evaluation: { mapId, health: 'operational', previousHealth: null, impactScore: 0, changed: true, stale: false, causes: [] },
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('seedServiceMaps', () => {
  it('una mappa per ogni BusinessApplication senza mappa (query scopata per tenant, per nome), attore seed, log per riga', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ id: 'ba-1', name: 'Billing' }, { id: 'ba-2', name: 'CRM' }] as never)
    vi.mocked(createServiceMap).mockResolvedValueOnce(created('m1', [1, 2, 2]) as never).mockResolvedValueOnce(created('m2', []) as never)
    const log = vi.fn()
    const r = await seedServiceMaps({ tenantId: 'c-one', maxDepth: 3, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'] }, log)
    expect(r.created).toEqual([{ serviceId: 'ba-1', mapId: 'm1' }, { serviceId: 'ba-2', mapId: 'm2' }])
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (ba:BusinessApplication {tenant_id: $tenantId})')
    expect(cypher).toContain('WHERE NOT EXISTS { (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId}) }')
    expect(cypher).toMatch(/ORDER BY ba\.name/)
    expect(params).toEqual({ tenantId: 'c-one' })
    expect(vi.mocked(createServiceMap).mock.calls).toEqual([
      [{ tenantId: 'c-one', serviceId: 'ba-1', maxDepth: 3, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], actorId: SEED_ACTOR }],
      [{ tenantId: 'c-one', serviceId: 'ba-2', maxDepth: 3, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], actorId: SEED_ACTOR }],
    ])
    expect(log.mock.calls[0]![0]).toBe('✓ Billing → mappa m1: 3 componenti (L1: 1, L2: 2), salute operational (0)')
    expect(log.mock.calls[1]![0]).toContain('0 componenti (nessuno)')
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('nessuna candidata → niente da fare (log), nessuna creazione; un errore di creazione ferma il seed', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    const log = vi.fn()
    await expect(seedServiceMaps({ tenantId: 'c-one', maxDepth: 4, relationshipTypes: ['DEPENDS_ON'] }, log)).resolves.toEqual({ created: [] })
    expect(createServiceMap).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Nessuna BusinessApplication senza mappa'))

    vi.mocked(runQuery).mockResolvedValueOnce([{ id: 'ba-1', name: 'A' }, { id: 'ba-2', name: 'B' }] as never)
    vi.mocked(createServiceMap).mockRejectedValueOnce(new Error('would exceed 500 nodes'))
    await expect(seedServiceMaps({ tenantId: 'c-one', maxDepth: 4, relationshipTypes: ['DEPENDS_ON'] }, vi.fn())).rejects.toThrow(/would exceed 500 nodes/)
    expect(createServiceMap).toHaveBeenCalledTimes(1)
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(listCandidates('t')).resolves.toEqual([])
  })

  it('parseSeedArgs: tenant obbligatorio, profondità e relazioni di default o dagli argomenti; valori non validi → ScriptArgError', () => {
    expect(parseSeedArgs(['--tenant=c-one'])).toEqual({ tenantId: 'c-one', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'] })
    expect(parseSeedArgs(['--tenant', 'c-one', '--max-depth=2', '--relationships=DEPENDS_ON, HOSTED_ON'])).toEqual({ tenantId: 'c-one', maxDepth: 2, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'] })
    expect(() => parseSeedArgs([])).toThrow(ScriptArgError)
    expect(() => parseSeedArgs(['--tenant=c-one', '--max-depth=due'])).toThrow(/--max-depth deve essere un intero/)
    expect(() => parseSeedArgs(['--tenant=c-one', '--relationships='])).toThrow(/--relationships vuoto/)
  })
})
