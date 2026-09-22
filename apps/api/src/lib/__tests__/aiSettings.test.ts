/**
 * The per-organization AI switches (lib/aiSettings.ts).
 *
 * Why these behaviours matter: a switch that is off must stop the call BEFORE
 * any ticket text leaves for the model — a customer who turned "triage" off
 * and still sees its tickets sent out has been lied to. The reading side is
 * tolerant (a tenant saved before a feature existed keeps the factory value),
 * the writing side is strict (a client that does not know a feature must not
 * turn it off silently). A corrupt stored value must fail loudly and name the
 * tenant, never fall back to "all on". And saving must invalidate the cache,
 * or the organization keeps the old switches until the TTL expires.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => {})
const getSession = vi.fn(() => ({ close }))
const invalidateSchema = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...(a as [])),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))
vi.mock('../schemaInvalidator.js', () => ({
  invalidateSchema: (...a: unknown[]) => invalidateSchema(...a),
  registerMetamodelCacheClearer: vi.fn(),
}))

const {
  aiSettings, aiFeatureEnabled, assertAIFeature, aiDisabledError, assertAISettings,
  setAISettings, clearAISettingsCache, FACTORY_AI_SETTINGS, AI_FEATURES,
} = await import('../aiSettings.js')

const allOn = () => Object.fromEntries(AI_FEATURES.map((f) => [f, true])) as Record<string, boolean>
const valid = (over: Record<string, unknown> = {}) => ({ features: allOn(), clusterMinSimilarity: 0.8, clusterMinSize: 4, ...over })
const i18nKey = (fn: () => unknown): string | null => {
  try { fn(); return null } catch (e) { return (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key ?? (e as Error).message }
}

beforeEach(() => {
  clearAISettingsCache()
  runQueryOne.mockReset()
  close.mockClear()
  getSession.mockClear()
  invalidateSchema.mockClear()
})

describe('reading the settings of a tenant', () => {
  it('a tenant that never saved anything gets the factory values, marked as default', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: null })
    const s = await aiSettings('t1')
    expect(s.isDefault).toBe(true)
    expect(s.features).toEqual(FACTORY_AI_SETTINGS.features)
    expect(s.clusterMinSimilarity).toBe(0.72)
    // The factory object must not be shared: a caller mutating its copy would change every tenant.
    s.features.triage = false
    expect(FACTORY_AI_SETTINGS.features.triage).toBe(true)
    expect(close).toHaveBeenCalled()
  })

  it('the lookup is scoped to the tenant id', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: null })
    await aiSettings('tenant-A')
    expect(runQueryOne.mock.calls[0]?.[2]).toEqual({ tenantId: 'tenant-A' })
  })

  it('a feature saved before it existed reads as its factory value (tolerant read)', async () => {
    const legacy = { features: { triage: false, assistant: true, reportAnalysis: true, postIncident: true, kbArticles: true, embeddings: true }, clusterMinSimilarity: 0.8, clusterMinSize: 4 }
    runQueryOne.mockResolvedValueOnce({ raw: JSON.stringify(legacy) })
    const s = await aiSettings('t1')
    expect(s.isDefault).toBe(false)
    expect(s.features.triage).toBe(false)
    expect(s.features.formDesigner).toBe(true)           // factory: on
    expect(s.features.platformSelfAnalysis).toBe(false)  // factory: off
  })

  it('a missing tenant is an error, not "all on"', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(aiSettings('ghost')).rejects.toThrow(/ghost/)
    expect(close).toHaveBeenCalled()
  })

  it('corrupt JSON fails loudly naming the tenant', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: '{not json' })
    await expect(aiSettings('t-bad')).rejects.toThrow(/Tenant t-bad: ai_settings is not valid JSON/)
  })

  it('a failed load is not cached: the next call retries', async () => {
    runQueryOne.mockResolvedValueOnce({ raw: '{not json' }).mockResolvedValueOnce({ raw: null })
    await expect(aiSettings('t1')).rejects.toThrow()
    await expect(aiSettings('t1')).resolves.toMatchObject({ isDefault: true })
  })
})

describe('the switch in front of every model call', () => {
  it('an enabled feature passes, a disabled one throws AI_DISABLED naming it', async () => {
    const features = { ...allOn(), triage: false }
    runQueryOne.mockResolvedValueOnce({ raw: JSON.stringify(valid({ features })) })
    await expect(aiFeatureEnabled('t1', 'assistant')).resolves.toBe(true)
    await expect(assertAIFeature('t1', 'assistant')).resolves.toBeUndefined()
    const err = await assertAIFeature('t1', 'triage').catch((e: unknown) => e) as { extensions: Record<string, unknown> }
    expect(err.extensions['code']).toBe('AI_DISABLED')
    expect(err.extensions['feature']).toBe('triage')
    // Only one DB read: the cache serves the following checks.
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('the error carries an i18n key so the client can say it in its own language', () => {
    const e = aiDisabledError('embeddings')
    expect(e.message).toContain('"embeddings"')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.ai.disabled', params: { feature: 'embeddings' } })
  })
})

describe('assertAISettings (strict on write)', () => {
  it('accepts a full valid object and rounds the similarity to two decimals', () => {
    expect(assertAISettings(valid({ clusterMinSimilarity: 0.8349 })).clusterMinSimilarity).toBe(0.83)
  })

  it('rejects a missing features object', () => {
    expect(i18nKey(() => assertAISettings(null))).toBe('errors.aiSettings.shape')
    expect(i18nKey(() => assertAISettings({ features: 'yes' }))).toBe('errors.aiSettings.shape')
  })

  it('a missing switch is rejected on write even though it would be tolerated on read', () => {
    const features = allOn(); delete features['formDesigner']
    expect(i18nKey(() => assertAISettings(valid({ features })))).toBe('errors.aiSettings.shape')
    expect(assertAISettings(valid({ features }), { tollerante: true }).features.formDesigner).toBe(true)
  })

  it('a present but non-boolean switch is rejected even when tolerant', () => {
    const features = { ...allOn(), triage: 'off' }
    expect(i18nKey(() => assertAISettings(valid({ features }), { tollerante: true }))).toBe('errors.aiSettings.shape')
  })

  it('similarity and group size must stay inside their ranges', () => {
    for (const sim of [0.49, 1, Number.NaN, '0.8']) {
      expect(i18nKey(() => assertAISettings(valid({ clusterMinSimilarity: sim })))).toBe('errors.aiSettings.similarity')
    }
    for (const size of [1, 21, 3.5, '3']) {
      expect(i18nKey(() => assertAISettings(valid({ clusterMinSize: size })))).toBe('errors.aiSettings.size')
    }
  })
})

describe('setAISettings', () => {
  it('writes the validated JSON on the tenant and invalidates the caches', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 't1' })
    const out = await setAISettings('t1', valid())
    expect(out.isDefault).toBe(false)
    const params = runQueryOne.mock.calls[0]?.[2] as { tenantId: string; json: string }
    expect(params.tenantId).toBe('t1')
    expect(JSON.parse(params.json)).toEqual({ features: allOn(), clusterMinSimilarity: 0.8, clusterMinSize: 4 })
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(close).toHaveBeenCalled()
  })

  it('an invalid input never reaches the database', async () => {
    await expect(setAISettings('t1', valid({ clusterMinSize: 0 }))).rejects.toThrow()
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('a missing tenant is an error and nothing is invalidated', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(setAISettings('ghost', valid())).rejects.toThrow(/ghost/)
    expect(invalidateSchema).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })
})
