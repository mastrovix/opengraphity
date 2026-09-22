/**
 * Risk band thresholds as customer data (lib/riskBands.ts).
 *
 * Why these behaviours matter: the band of a change's aggregate risk score
 * feeds `deriveChangePriority`. If the thresholds were read by position, fell
 * back silently to invented numbers, or accepted a scale with a hole in it,
 * a change would open with a plausible and WRONG priority — no error
 * anywhere. Every path here must therefore either return the customer's own
 * scale or stop loudly, naming the tenant and what is wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeRead = vi.fn()
const executeWrite = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const domainVocabulary = vi.fn()
const assertDomainValue = vi.fn()
const invalidateSchema = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ executeRead, executeWrite, close }) }))
vi.mock('../domainMatrix.js', () => ({ domainVocabulary, assertDomainValue }))
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema, registerMetamodelCacheClearer: vi.fn() }))

const {
  factoryThresholdsFor, riskBandThresholds, riskBandOf, setRiskBandThresholds, clearRiskBandCache,
  FACTORY_RISK_THRESHOLDS, MAX_RISK_SCORE,
} = await import('../riskBands.js')

const tenantRow = (raw: unknown) => ({ records: [{ get: (k: string) => (k === 'raw' ? raw : null) }] })

/** Runs the transaction callback against a fake tx that answers with `result`. */
const readAnswers = (result: unknown) => {
  executeRead.mockImplementation(async (fn: (tx: { run: () => Promise<unknown> }) => Promise<unknown>) =>
    fn({ run: () => Promise.resolve(result) }))
}

const SHIPPED = ['low', 'medium', 'high']

beforeEach(() => {
  vi.clearAllMocks()
  clearRiskBandCache()
  domainVocabulary.mockResolvedValue(SHIPPED)
  assertDomainValue.mockResolvedValue(undefined)
})

describe('factoryThresholdsFor', () => {
  it('maps exactly three values onto the historical 30/60/100 split', () => {
    expect(FACTORY_RISK_THRESHOLDS).toEqual([30, 60, MAX_RISK_SCORE])
    expect(factoryThresholdsFor(['a', 'b', 'c'])).toEqual([
      { band: 'a', upTo: 30 }, { band: 'b', upTo: 60 }, { band: 'c', upTo: 100 },
    ])
  })

  it('invents nothing for a vocabulary that is not three values long', () => {
    // A fourth band would be unreachable with a positional split: the caller must say so.
    expect(factoryThresholdsFor(['a', 'b'])).toBeNull()
    expect(factoryThresholdsFor(['a', 'b', 'c', 'd'])).toBeNull()
  })
})

describe('riskBandThresholds (loading)', () => {
  it('a tenant that does not exist is an error, not an empty scale', async () => {
    readAnswers({ records: [] })
    await expect(riskBandThresholds('ghost')).rejects.toThrow(/Tenant ghost does not exist/)
    expect(close).toHaveBeenCalled()
  })

  it('undeclared thresholds fall back to the factory split on the customer vocabulary', async () => {
    readAnswers(tenantRow(null))
    domainVocabulary.mockResolvedValue(['basso', 'medio', 'alto'])
    await expect(riskBandThresholds('t1')).resolves.toEqual([
      { band: 'basso', upTo: 30 }, { band: 'medio', upTo: 60 }, { band: 'alto', upTo: 100 },
    ])
    // Served from the cache on the second call: no second read.
    await riskBandThresholds('t1')
    expect(executeRead).toHaveBeenCalledTimes(1)
  })

  it('the cache is per tenant: one tenant\'s scale never answers for another', async () => {
    readAnswers(tenantRow(null))
    domainVocabulary.mockResolvedValueOnce(['a', 'b', 'c']).mockResolvedValueOnce(['x', 'y', 'z'])
    expect((await riskBandThresholds('t1'))[0]!.band).toBe('a')
    expect((await riskBandThresholds('t2'))[0]!.band).toBe('x')
    expect(executeRead).toHaveBeenCalledTimes(2)
  })

  it('undeclared thresholds with a vocabulary of four values stop with an i18n key', async () => {
    readAnswers(tenantRow(undefined))
    domainVocabulary.mockResolvedValue(['a', 'b', 'c', 'd'])
    const err = await riskBandThresholds('t1').catch((e: unknown) => e) as { message: string; extensions: Record<string, unknown> }
    expect(err.message).toMatch(/has 4 values \(a, b, c, d\), not three/)
    expect(err.extensions.i18n).toEqual({ key: 'errors.riskBand.notDeclared', params: { count: 4, bands: 'a, b, c, d' } })
  })

  it('declared thresholds are parsed from JSON and returned in order', async () => {
    readAnswers(tenantRow(JSON.stringify([{ band: 'low', upTo: 10 }, { band: 'medium', upTo: 50 }, { band: 'high', upTo: 100 }])))
    await expect(riskBandThresholds('t1')).resolves.toEqual([
      { band: 'low', upTo: 10 }, { band: 'medium', upTo: 50 }, { band: 'high', upTo: 100 },
    ])
  })

  it('accepts an already-decoded list as well as a JSON string', async () => {
    readAnswers(tenantRow([{ band: 'low', upTo: 100 }]))
    await expect(riskBandThresholds('t1')).resolves.toEqual([{ band: 'low', upTo: 100 }])
  })

  it.each([
    ['not JSON', '{nope', /risk_band_thresholds is not valid JSON/],
    ['not a list', '{"band":"low"}', /must be a non-empty list/],
    ['an empty list', '[]', /must be a non-empty list/],
    ['a non-object entry', '[1]', /a risk band is not an object/],
    ['a null entry', '[null]', /a risk band is not an object/],
    ['a band without a name', '[{"band":"","upTo":100}]', /a risk band has no name/],
    ['a non-integer threshold', '[{"band":"low","upTo":10.5}]', /threshold of "low" is not an integer/],
    ['a non-numeric threshold', '[{"band":"low","upTo":"100"}]', /threshold of "low" is not an integer/],
    ['thresholds that do not grow', '[{"band":"low","upTo":50},{"band":"medium","upTo":50}]', /thresholds must grow \(medium = 50 after 50\)/],
    ['a scale that stops before 100', '[{"band":"low","upTo":30},{"band":"medium","upTo":90}]', /stop at 90/],
  ])('a stored scale with %s is rejected naming the tenant', async (_label, raw, pattern) => {
    readAnswers(tenantRow(raw))
    await expect(riskBandThresholds('t9')).rejects.toThrow(pattern)
    await expect(riskBandThresholds('t9')).rejects.toThrow(/Tenant t9/)
  })

  it('a band removed from the dictionary is a stale-configuration error with its own key', async () => {
    readAnswers(tenantRow('[{"band":"gone","upTo":100}]'))
    const err = await riskBandThresholds('t1').catch((e: unknown) => e) as { message: string; extensions: Record<string, unknown> }
    expect(err.message).toMatch(/name "gone", which is not \(any more\) in the "risk_band" dictionary/)
    expect(err.extensions.i18n).toEqual({ key: 'errors.riskBand.stale', params: { band: 'gone', bands: 'low, medium, high' } })
  })

  it('a failed load is not cached: fixing the data takes effect on the next call', async () => {
    readAnswers(tenantRow('{nope'))
    await expect(riskBandThresholds('t1')).rejects.toThrow()
    readAnswers(tenantRow(null))
    await expect(riskBandThresholds('t1')).resolves.toHaveLength(3)
  })
})

describe('riskBandOf', () => {
  it('an unassessed risk has no band (it is a separate matrix, not "low")', async () => {
    await expect(riskBandOf('t1', null)).rejects.toThrow(/unassessed risk has no band/)
    await expect(riskBandOf('t1', undefined)).rejects.toThrow(/unassessed risk has no band/)
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('picks the first band whose upper bound includes the score (bounds inclusive)', async () => {
    readAnswers(tenantRow(null))
    expect(await riskBandOf('t1', 0)).toBe('low')
    expect(await riskBandOf('t1', 30)).toBe('low')
    expect(await riskBandOf('t1', 31)).toBe('medium')
    expect(await riskBandOf('t1', 60)).toBe('medium')
    expect(await riskBandOf('t1', 100)).toBe('high')
  })

  it('honours a four-band customer scale, the case the positional code ignored', async () => {
    domainVocabulary.mockResolvedValue(['a', 'b', 'c', 'd'])
    readAnswers(tenantRow(JSON.stringify([
      { band: 'a', upTo: 20 }, { band: 'b', upTo: 40 }, { band: 'c', upTo: 70 }, { band: 'd', upTo: 100 },
    ])))
    expect(await riskBandOf('t1', 85)).toBe('d')
  })

  it('a score beyond the scale is reported rather than clamped to the top band', async () => {
    readAnswers(tenantRow(null))
    await expect(riskBandOf('t1', 101)).rejects.toThrow(/score 101 is beyond the last threshold \(100\) of tenant t1/)
  })
})

describe('setRiskBandThresholds', () => {
  const good = [{ band: 'low', upTo: 25 }, { band: 'medium', upTo: 75 }, { band: 'high', upTo: 100 }]

  const writeAnswers = (result: unknown) => {
    const run = vi.fn().mockResolvedValue(result)
    executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => Promise<unknown>) => fn({ run }))
    return run
  }

  const keyOf = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x) as { extensions?: { code?: string; i18n?: { key: string } } }
    expect(e.extensions?.code).toBe('BAD_USER_INPUT')
    return e.extensions?.i18n?.key
  }

  it('saves a valid scale, invalidates the metamodel caches and returns it', async () => {
    const run = writeAnswers({ records: [{}] })
    await expect(setRiskBandThresholds('t1', good)).resolves.toEqual(good)
    // The stored value is the JSON the loader parses back: a round trip must be lossless.
    const params = run.mock.calls[0]![1] as { tenantId: string; value: string }
    expect(params.tenantId).toBe('t1')
    expect(JSON.parse(params.value)).toEqual(good)
    // Without the invalidation the worker would keep computing priorities on the old scale.
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(close).toHaveBeenCalled()
  })

  it('a tenant that does not exist is reported and nothing is invalidated', async () => {
    writeAnswers({ records: [] })
    expect(await keyOf(setRiskBandThresholds('ghost', good))).toBe('errors.notFound')
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('an empty scale is refused', async () => {
    expect(await keyOf(setRiskBandThresholds('t1', []))).toBe('errors.riskBand.atLeastOne')
  })

  it('every band must be a value of the customer vocabulary', async () => {
    assertDomainValue.mockRejectedValueOnce(new Error('not in risk_band'))
    await expect(setRiskBandThresholds('t1', good)).rejects.toThrow('not in risk_band')
    expect(executeWrite).not.toHaveBeenCalled()
  })

  it('a band may appear only once', async () => {
    expect(await keyOf(setRiskBandThresholds('t1', [{ band: 'low', upTo: 10 }, { band: 'low', upTo: 100 }])))
      .toBe('errors.riskBand.duplicate')
  })

  it.each([[-1], [10.5], [Number.NaN]])('a threshold of %s is refused', async (upTo) => {
    expect(await keyOf(setRiskBandThresholds('t1', [{ band: 'low', upTo }, { band: 'high', upTo: 100 }])))
      .toBe('errors.riskBand.threshold')
  })

  it('thresholds must strictly grow', async () => {
    expect(await keyOf(setRiskBandThresholds('t1', [{ band: 'low', upTo: 60 }, { band: 'medium', upTo: 30 }, { band: 'high', upTo: 100 }])))
      .toBe('errors.riskBand.notGrowing')
  })

  it('the last band must reach exactly 100, or high scores would have no band', async () => {
    expect(await keyOf(setRiskBandThresholds('t1', [{ band: 'low', upTo: 30 }, { band: 'high', upTo: 90 }])))
      .toBe('errors.riskBand.lastMustReachMax')
    expect(executeWrite).not.toHaveBeenCalled()
  })
})
