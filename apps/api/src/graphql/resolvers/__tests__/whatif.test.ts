/**
 * What-if — giro nel browser del 14 set 2026 (#59): il tipo dei CI impattati
 * era sempre «ConfigurationItem», i servizi si indovinavano dal nome
 * dell'etichetta (un database con un servizio dipendente diceva «0 services»),
 * il riepilogo era una frase italiana composta qui e l'audit aveva un catch muto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// CM-3: le relazioni delle traversate vengono dal tenant.
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE'),
  impactRelPatternForTenant:  vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE|PROTEGGE|REALIZES|ENABLED_BY'),
}))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getTerminalStepNames: vi.fn().mockResolvedValue(['closed']) }))

const { whatifResolvers } = await import('../whatif.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('AS lbl')) return { name: 'db-01', lbl: 'Database', env: 'production', status: 'active' }
    return { cnt: 0 }
  }) as never)
  vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('MATCH path =')) {
      expect(cypher).toContain("WHERE l <> 'ConfigurationItem'")
      return [{ id: 'app-1', name: 'crm', lbls: ['Application'], env: 'production', status: 'active', distance: 1, pathNames: ['crm', 'db-01'] }]
    }
    if (cypher.includes(':ServiceMap')) {
      expect(params['ciIds']).toEqual(['db-1', 'app-1'])
      // Lo stesso servizio compare per il bersaglio (distanza 0) e per l'app: vince il più vicino.
      return [
        { id: 'ba-1', name: 'Portale clienti', env: 'production', status: 'active', ciId: 'app-1' },
        { id: 'ba-1', name: 'Portale clienti', env: 'production', status: 'active', ciId: 'db-1' },
      ]
    }
    return []
  }) as never)
})

describe('whatIfAnalysis', () => {
  it('tipo vero dei CI impattati e servizi dalle mappe che includono il bersaglio o un impattato', async () => {
    const r = await whatifResolvers.Query.whatIfAnalysis(null, { ciId: 'db-1', action: 'impact' }, ctx)
    expect(r.impactedCIs[0]).toMatchObject({ id: 'app-1', type: 'Application' })
    expect(r.impactedServices).toEqual([expect.objectContaining({ id: 'ba-1', name: 'Portale clienti', type: 'BusinessApplication', impactLevel: 'critical', impactPath: ['db-01'] })])
  })

  it('il riepilogo dell\'API non è più in italiano', async () => {
    const r = await whatifResolvers.Query.whatIfAnalysis(null, { ciId: 'db-1', action: 'remove' }, ctx)
    expect(r.summary).toBe('Removing db-01 impacts 1 CIs, 1 services, 0 teams. Risk: 45/100.')
  })
})
