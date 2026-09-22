/**
 * The change impact-analysis weights are customer data (Tenant.impact_analysis_weights).
 *
 * Why these behaviours matter:
 *  - an absent property must mean the factory weights (the numbers the code used
 *    before), flagged `isDefault`, otherwise every existing tenant's risk scores
 *    would change the day the feature shipped;
 *  - a stored value that is corrupt (bad JSON, out-of-range, unknown key) must
 *    fail loudly: a silently ignored weight would produce a risk level nobody chose;
 *  - saving must validate BEFORE writing and must invalidate the metamodel
 *    caches, or other processes keep scoring with the old weights;
 *  - the cache is per tenant: one customer's weights never leak into another's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txRun = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead:  (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  }),
}))
const invalidateSchema = vi.fn()
vi.mock('../schemaInvalidator.js', () => ({
  registerMetamodelCacheClearer: vi.fn(),
  invalidateSchema: (t: string) => invalidateSchema(t),
}))

const {
  FACTORY_IMPACT_WEIGHTS, assertImpactWeights, impactAnalysisWeights, setImpactAnalysisWeights, clearImpactWeightsCache,
} = await import('../impactWeights.js')

const rows = (raw: unknown) => ({ records: [{ get: () => raw }] })
const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
const catchErr = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)
const full = { ...FACTORY_IMPACT_WEIGHTS }

beforeEach(() => {
  txRun.mockReset()
  close.mockClear()
  invalidateSchema.mockClear()
  clearImpactWeightsCache()
})

describe('assertImpactWeights', () => {
  it('accepts a complete set and returns exactly the known keys', () => {
    expect(assertImpactWeights(full, 'x')).toEqual(full)
  })

  it('accepts Neo4j Integer-like values (toNumber) as numbers', () => {
    const out = assertImpactWeights({ ...full, productionCI: { toNumber: () => 33 } }, 'x')
    expect(out.productionCI).toBe(33)
  })

  it.each([null, 'text', 5, [1, 2]])('rejects a non-object (%j) with the shape key', (raw) => {
    expect(() => assertImpactWeights(raw, 'where')).toThrow(/must be an object/)
    try { assertImpactWeights(raw, 'where') } catch (e) { expect(errKey(e)).toBe('errors.impactWeights.shape') }
  })

  it('rejects unknown keys instead of silently dropping them', () => {
    let err: unknown
    try { assertImpactWeights({ ...full, bogus: 1, other: 2 }, 'w') } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.impactWeights.unknown')
    expect((err as Error).message).toContain('bogus, other')
  })

  it.each([
    ['missing key', { ...full, openIncident: undefined }],
    ['non-integer', { ...full, openIncident: 1.5 }],
    ['string number', { ...full, openIncident: '10' }],
    ['weight above 100', { ...full, openIncident: 101 }],
    ['negative weight', { ...full, openIncident: -1 }],
    // Windows start at 1 day: a zero-day window would look at nothing.
    ['zero-day window', { ...full, recentChangesDays: 0 }],
    ['window above a year', { ...full, recentIncidentsDays: 366 }],
  ])('rejects %s with the range key', (_label, raw) => {
    let err: unknown
    try { assertImpactWeights(raw, 'w') } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.impactWeights.range')
  })

  it('accepts the boundaries of each range', () => {
    expect(assertImpactWeights({ ...full, productionCI: 0, blastRadiusCap: 100, recentChangesDays: 1, recentIncidentsDays: 365 }, 'w'))
      .toMatchObject({ productionCI: 0, blastRadiusCap: 100, recentChangesDays: 1, recentIncidentsDays: 365 })
  })
})

describe('impactAnalysisWeights (loading)', () => {
  it('absent property → the factory weights, marked as default', async () => {
    txRun.mockResolvedValueOnce(rows(null))
    expect(await impactAnalysisWeights('t1')).toEqual({ ...FACTORY_IMPACT_WEIGHTS, isDefault: true })
    // The query is scoped to this tenant.
    expect(txRun.mock.calls[0]![1]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalled()
  })

  it('stored JSON → those weights, not default', async () => {
    const custom = { ...full, productionCI: 50 }
    txRun.mockResolvedValueOnce(rows(JSON.stringify(custom)))
    expect(await impactAnalysisWeights('t1')).toEqual({ ...custom, isDefault: false })
  })

  it('unknown tenant → an error, never the factory weights', async () => {
    txRun.mockResolvedValueOnce({ records: [] })
    await expect(impactAnalysisWeights('ghost')).rejects.toThrow(/Tenant ghost does not exist/)
    expect(close).toHaveBeenCalled()
  })

  it('corrupt JSON → a loud error naming the tenant', async () => {
    txRun.mockResolvedValueOnce(rows('{not json'))
    await expect(impactAnalysisWeights('t1')).rejects.toThrow(/Tenant t1: impact_analysis_weights is not valid JSON/)
  })

  it('stored but invalid weights → a validation error, not a partial set', async () => {
    txRun.mockResolvedValueOnce(rows(JSON.stringify({ ...full, failedChange: 999 })))
    expect(errKey(await catchErr(impactAnalysisWeights('t1')))).toBe('errors.impactWeights.range')
  })

  it('is cached per tenant: a second read does not hit the graph, another tenant does', async () => {
    txRun.mockResolvedValueOnce(rows(null)).mockResolvedValueOnce(rows(JSON.stringify({ ...full, productionCI: 1 })))
    await impactAnalysisWeights('t1')
    await impactAnalysisWeights('t1')
    const other = await impactAnalysisWeights('t2')
    expect(txRun).toHaveBeenCalledTimes(2)
    expect(other.productionCI).toBe(1)
  })
})

describe('setImpactAnalysisWeights', () => {
  it('validates before touching the graph', async () => {
    expect(errKey(await catchErr(setImpactAnalysisWeights('t1', { productionCI: 1 })))).toBe('errors.impactWeights.range')
    expect(txRun).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('writes the JSON on this tenant and invalidates the caches of every process', async () => {
    txRun.mockResolvedValueOnce({ records: [{ get: () => 't1' }] })
    const custom = { ...full, ongoingChange: 7 }
    expect(await setImpactAnalysisWeights('t1', custom)).toEqual({ ...custom, isDefault: false })
    const params = txRun.mock.calls[0]![1] as Record<string, unknown>
    expect(params['tenantId']).toBe('t1')
    expect(JSON.parse(String(params['json']))).toEqual(custom)
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(close).toHaveBeenCalled()
  })

  it('unknown tenant → not-found error and no invalidation', async () => {
    txRun.mockResolvedValueOnce({ records: [] })
    expect(errKey(await catchErr(setImpactAnalysisWeights('ghost', full)))).toBe('errors.notFound')
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})
