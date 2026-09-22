/**
 * The three read-only queries of the domain rules page that the main suite
 * does not reach: the critical service criticalities, the environment weight
 * of the change risk, and the impact analysis weights. They are one-liners,
 * but the one-liner carries the only contract that matters here: they read
 * the CALLER'S tenant. An admin of tenant A who saw tenant B's weights would
 * tune A's risk on numbers that do not apply to it — and never notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// No real driver: importing the real package opens a connection pool.
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => { throw new Error('no database in this test') }),
  runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
// Modules this resolver imports that would otherwise reach Redis or Neo4j at load.
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: vi.fn() }))
vi.mock('../../../lib/domainMatrix.js', () => ({
  DOMAIN_MATRIX_KINDS: [], domainVocabulary: vi.fn(), isDomainMatrixKind: vi.fn(), matrixInputValues: vi.fn(),
  matrixOutputValues: vi.fn(), loadDomainMatrix: vi.fn(), matrixKey: vi.fn(),
}))
vi.mock('../../../lib/changePolicy.js', () => ({ preApprovedChangeTypes: vi.fn(), setPreApprovedChangeTypes: vi.fn(), changeTypeVocabulary: vi.fn() }))
vi.mock('../../../lib/riskBands.js', () => ({ riskBandThresholds: vi.fn(), setRiskBandThresholds: vi.fn() }))
vi.mock('../../../lib/configurationIssues.js', () => ({ configurationIssues: vi.fn() }))

const criticalServiceCriticalities = vi.fn(async (tenantId: string) => (tenantId === 't1' ? ['high', 'critical'] : ['other']))
vi.mock('../../../services/serviceImpact/incident.js', () => ({
  criticalServiceCriticalities: (t: string) => criticalServiceCriticalities(t),
}))
const changeEnvironmentWeight = vi.fn(async (tenantId: string) => ({ weight: tenantId === 't1' ? 1.5 : 9, isDefault: false }))
vi.mock('../../../lib/changeEnvironmentWeight.js', () => ({
  changeEnvironmentWeight: (t: string) => changeEnvironmentWeight(t),
  setChangeEnvironmentWeight: vi.fn(),
}))
const impactAnalysisWeights = vi.fn(async (tenantId: string) => ({ direct: tenantId === 't1' ? 3 : 99, indirect: 1, isDefault: true }))
vi.mock('../../../lib/impactWeights.js', () => ({
  impactAnalysisWeights: (t: string) => impactAnalysisWeights(t),
  setImpactAnalysisWeights: vi.fn(),
}))

const { domainMatrixResolvers } = await import('../domainMatrix.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() } as never

beforeEach(() => { vi.clearAllMocks() })

describe('domain rule queries read the caller tenant', () => {
  it('criticalServiceCriticalities: the criticalities that make a service critical for THIS tenant', async () => {
    await expect(domainMatrixResolvers.Query.criticalServiceCriticalities(null, null, ctx)).resolves.toEqual(['high', 'critical'])
    expect(criticalServiceCriticalities).toHaveBeenCalledWith('t1')
  })

  it('changeEnvironmentWeight: the weight of this tenant, with its default flag', async () => {
    await expect(domainMatrixResolvers.Query.changeEnvironmentWeight(null, null, ctx)).resolves.toEqual({ weight: 1.5, isDefault: false })
    expect(changeEnvironmentWeight).toHaveBeenCalledWith('t1')
  })

  it('impactAnalysisWeights: the weights of this tenant', async () => {
    await expect(domainMatrixResolvers.Query.impactAnalysisWeights(null, null, ctx)).resolves.toEqual({ direct: 3, indirect: 1, isDefault: true })
    expect(impactAnalysisWeights).toHaveBeenCalledWith('t1')
  })

  it('a failure to read the weights propagates: no factory default is shown in its place', async () => {
    impactAnalysisWeights.mockRejectedValueOnce(new Error('corrupt impact weights'))
    await expect(domainMatrixResolvers.Query.impactAnalysisWeights(null, null, ctx)).rejects.toThrow('corrupt impact weights')
  })
})
