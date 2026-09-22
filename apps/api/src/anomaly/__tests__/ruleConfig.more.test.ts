/**
 * Anomaly rule configuration: the choices a tenant can make, how they are
 * read back and how they are saved.
 *
 * Why these behaviours matter for a user:
 *  - the options offered in the settings page come from THIS tenant's
 *    metamodel and severity vocabulary; if they came from anywhere else the
 *    admin would pick a CI type the scan cannot find;
 *  - a rule never saved must read as the factory seed AND say so
 *    (`isDefault`), otherwise the page cannot tell "untouched" from "chosen";
 *  - corrupt JSON on a stored rule must fail loud with the tenant and rule in
 *    the message, not silently fall back to the seed (house rule: no silent
 *    fallbacks) — a silent fallback would re-enable a rule the admin disabled;
 *  - every malformed input is a ValidationError with an i18n key, so the page
 *    can explain which field is wrong instead of showing "Internal error";
 *  - saving is scoped by tenant and rule key, and an unknown rule key is
 *    refused before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnomalyRuleOptions } from '../ruleConfig.js'

const fake = vi.hoisted(() => ({
  types: [] as Array<Record<string, unknown>>,
  impactPattern: 'DEPENDS_ON|HOSTED_ON',
  severities: ['critical', 'high'] as string[],
  stored: [] as Array<Record<string, unknown>>,
  runs: [] as Array<{ q: string; p: Record<string, unknown> }>,
  closed: 0,
  writeFails: false,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => {
    const tx = {
      run: async (q: string, p: Record<string, unknown>) => {
        fake.runs.push({ q, p })
        if (fake.writeFails && q.includes('MERGE')) throw new Error('neo4j down')
        return { records: fake.stored.map((row) => ({ get: (k: string) => row[k] })) }
      },
    }
    return {
      executeRead:  async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      executeWrite: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
      close: async () => { fake.closed += 1 },
    }
  },
}))
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => fake.types),
}))
vi.mock('../../lib/domainMatrix.js', () => ({
  domainVocabulary: vi.fn(async () => fake.severities),
}))
vi.mock('../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  impactRelPatternForTenant: vi.fn(async () => fake.impactPattern),
}))

const { loadMetamodel } = await import('@opengraphity/schema-generator')
const { domainVocabulary } = await import('../../lib/domainMatrix.js')
const {
  anomalyRuleOptions, assertAnomalyRuleSettings, anomalyRuleProblem, loadAnomalyRuleConfigs,
  saveAnomalyRuleConfig, isAnomalyRuleKey, FACTORY_ANOMALY_RULES, ANOMALY_RULE_KEYS,
} = await import('../ruleConfig.js')
const { ValidationError } = await import('../../lib/errors.js')

const options: AnomalyRuleOptions = {
  ciTypes: [
    { name: 'server', label: 'Server', neo4jLabel: 'Server' },
    { name: 'application', label: 'Application', neo4jLabel: 'Application' },
    { name: 'certificate', label: 'Certificate', neo4jLabel: 'Certificate' },
  ],
  relations: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'],
  incidentSeverities: ['critical'],
}

/** The i18n key of the ValidationError thrown by `fn`. */
function keyOf(fn: () => unknown): string {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    return String(((e as InstanceType<typeof ValidationError>).extensions['i18n'] as { key: string }).key)
  }
  throw new Error('expected a ValidationError')
}

beforeEach(() => {
  fake.types = []; fake.impactPattern = 'DEPENDS_ON|HOSTED_ON'; fake.severities = ['critical', 'high']
  fake.stored = []; fake.runs = []; fake.closed = 0; fake.writeFails = false
  vi.clearAllMocks()
})

describe('isAnomalyRuleKey', () => {
  it('accepts only the product rule keys', () => {
    expect(ANOMALY_RULE_KEYS.every(isAnomalyRuleKey)).toBe(true)
    expect(isAnomalyRuleKey('spof ')).toBe(false)
    expect(isAnomalyRuleKey(42)).toBe(false)
  })
})

describe('anomalyRuleOptions', () => {
  it('merges impact relations with metamodel relations, sorts by label, and drops types without a node label', async () => {
    fake.types = [
      { name: 'srv', label: 'Zeta server', neo4jLabel: 'Server', relations: [{ name: 'runs', relationshipType: 'RUNS_ON|HOSTED_ON' }] },
      { name: 'app', label: null, neo4jLabel: 'Application', relations: [] },
      { name: 'abstract', label: 'Abstract', neo4jLabel: '', relations: [{ name: 'x', relationshipType: 'CONNECTS_TO' }] },
    ]
    const out = await anomalyRuleOptions('t-acme')
    // No label: the type name stands in, so the picker never shows an empty row.
    expect(out.ciTypes).toEqual([
      { name: 'app', label: 'app', neo4jLabel: 'Application' },
      { name: 'srv', label: 'Zeta server', neo4jLabel: 'Server' },
    ])
    // Relations of an abstract type are still real relation types of the tenant.
    expect(out.relations).toEqual(['CONNECTS_TO', 'DEPENDS_ON', 'HOSTED_ON', 'RUNS_ON'])
    expect(out.incidentSeverities).toEqual(['critical', 'high'])
    // Both sources are read for the requested tenant only.
    expect(vi.mocked(loadMetamodel).mock.calls[0]?.[0]).toBe('t-acme')
    expect(vi.mocked(domainVocabulary)).toHaveBeenCalledWith('t-acme', 'severity')
  })

  it('a malformed relationship type in the metamodel fails loud instead of being skipped', async () => {
    fake.types = [{ name: 'srv', label: 'S', neo4jLabel: 'Server', relations: [{ name: 'bad', relationshipType: 'runs on' }] }]
    await expect(anomalyRuleOptions('t-acme')).rejects.toThrow(/bad/)
  })
})

describe('assertAnomalyRuleSettings: shape errors carry an i18n key', () => {
  const spof = FACTORY_ANOMALY_RULES.spof
  const unauthorized = FACTORY_ANOMALY_RULES.unauthorized_relation

  it('refuses non-objects', () => {
    expect(keyOf(() => assertAnomalyRuleSettings('spof', null, options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('spof', [], options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('spof', 'x', options))).toBe('errors.anomalyRule.shape')
  })

  it('refuses a non-boolean enabled and a severity outside the scale', () => {
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, enabled: 'yes' }, options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, severity: 3 }, options))).toBe('errors.anomalyRule.severity')
  })

  it('refuses lists that are not lists of non-empty names', () => {
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, ciTypes: 'server' }, options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, relations: [''] }, options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, relations: ['DEPENDS_ON', 'DEPENDS_ON'] }, options))).toBe('errors.anomalyRule.duplicate')
  })

  it('refuses a relation name that is not a valid relationship type even if listed', () => {
    const lax = { ...options, relations: [...options.relations, 'depends_on'] }
    expect(keyOf(() => assertAnomalyRuleSettings('spof', { ...spof, relations: ['depends_on'] }, lax))).toBe('errors.anomalyRule.unknownRelation')
  })

  it('treats missing optional lists as empty', () => {
    const out = assertAnomalyRuleSettings('orphan_ci', { enabled: false, severity: 'low' }, options)
    expect(out).toEqual({ enabled: false, severity: 'low', ciTypes: [], relations: [], threshold: null, incidentSeverities: [], forbidden: [] })
  })

  it('refuses incident severities on a rule that does not look at incidents', () => {
    expect(keyOf(() => assertAnomalyRuleSettings('orphan_ci', { ...FACTORY_ANOMALY_RULES.orphan_ci, incidentSeverities: ['critical'] }, options))).toBe('errors.anomalyRule.notApplicable')
  })

  it('forbidden relations: must be a list, only on the rule that uses them, fully known, no duplicates', () => {
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: 'x' }, options))).toBe('errors.anomalyRule.shape')
    expect(keyOf(() => assertAnomalyRuleSettings('orphan_ci', { ...FACTORY_ANOMALY_RULES.orphan_ci, forbidden: unauthorized.forbidden }, options))).toBe('errors.anomalyRule.notApplicable')
    // A null entry is reported as an unknown type, not a crash.
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: [null] }, options))).toBe('errors.anomalyRule.unknownCIType')
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: [{ fromType: 'router', relation: 'DEPENDS_ON', toType: 'server' }] }, options))).toBe('errors.anomalyRule.unknownCIType')
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: [{ fromType: 'server', relation: 'RUNS_ON', toType: 'application' }] }, options))).toBe('errors.anomalyRule.unknownRelation')
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: [{ fromType: 'server', relation: 7, toType: 'application' }] }, options))).toBe('errors.anomalyRule.unknownRelation')
    const one = { fromType: 'server', relation: 'DEPENDS_ON', toType: 'application' }
    expect(keyOf(() => assertAnomalyRuleSettings('unauthorized_relation', { ...unauthorized, forbidden: [one, { ...one }] }, options))).toBe('errors.anomalyRule.duplicate')
  })

  it('returns only the known fields, dropping anything extra the client sent', () => {
    const out = assertAnomalyRuleSettings('spof', { ...spof, isDefault: true, ruleKey: 'spof', junk: 1 }, options)
    expect(Object.keys(out).sort()).toEqual(['ciTypes', 'enabled', 'forbidden', 'incidentSeverities', 'relations', 'severity', 'threshold'])
  })
})

describe('anomalyRuleProblem', () => {
  it('re-throws anything that is not a validation problem: a bug must not look like a bad setting', () => {
    const cfg = { ruleKey: 'orphan_ci' as const, ...FACTORY_ANOMALY_RULES.orphan_ci, isDefault: true, updatedAt: null }
    const broken = { ciTypes: null, relations: [], incidentSeverities: [] } as unknown as AnomalyRuleOptions
    expect(() => anomalyRuleProblem(cfg, broken)).toThrow(TypeError)
  })
})

describe('loadAnomalyRuleConfigs', () => {
  it('returns every rule in product order; unsaved ones are the factory seed flagged as default', async () => {
    const saved = { ...FACTORY_ANOMALY_RULES.spof, enabled: false, threshold: 9 }
    fake.stored = [{ ruleKey: 'spof', settings: JSON.stringify(saved), updatedAt: '2026-09-01T00:00:00.000Z' }]
    const out = await loadAnomalyRuleConfigs('t-acme')
    expect(out.map((c) => c.ruleKey)).toEqual([...ANOMALY_RULE_KEYS])
    expect(out.find((c) => c.ruleKey === 'spof')).toEqual({ ruleKey: 'spof', ...saved, isDefault: false, updatedAt: '2026-09-01T00:00:00.000Z' })
    expect(out.find((c) => c.ruleKey === 'orphan_ci')).toEqual({ ruleKey: 'orphan_ci', ...FACTORY_ANOMALY_RULES.orphan_ci, isDefault: true, updatedAt: null })
    expect(fake.runs[0]?.p).toEqual({ tenantId: 't-acme' })
    expect(fake.closed).toBe(1)
  })

  it('a stored rule without an update date reads as null, not "undefined"', async () => {
    fake.stored = [{ ruleKey: 'orphan_ci', settings: JSON.stringify(FACTORY_ANOMALY_RULES.orphan_ci), updatedAt: undefined }]
    const out = await loadAnomalyRuleConfigs('t-acme')
    expect(out.find((c) => c.ruleKey === 'orphan_ci')?.updatedAt).toBeNull()
  })

  it('corrupt JSON fails loud naming tenant and rule, and the session is still closed', async () => {
    fake.stored = [{ ruleKey: 'spof', settings: '{not json', updatedAt: null }]
    await expect(loadAnomalyRuleConfigs('t-acme')).rejects.toThrow(/Tenant t-acme: AnomalyRuleConfig spof is not valid JSON/)
    expect(fake.closed).toBe(1)
  })
})

describe('saveAnomalyRuleConfig', () => {
  beforeEach(() => {
    fake.types = [
      { name: 'server', label: 'Server', neo4jLabel: 'Server', relations: [] },
      { name: 'application', label: 'Application', neo4jLabel: 'Application', relations: [] },
    ]
    fake.impactPattern = 'DEPENDS_ON'
  })

  it('refuses an unknown rule key before reading or writing anything', async () => {
    await expect(saveAnomalyRuleConfig('t-acme', 'bogus', {})).rejects.toMatchObject({
      extensions: { i18n: { key: 'errors.anomalyRule.unknownRule', params: { rule: 'bogus' } } },
    })
    expect(fake.runs).toEqual([])
  })

  it('refuses invalid settings against the tenant metamodel without writing', async () => {
    await expect(saveAnomalyRuleConfig('t-acme', 'spof', { ...FACTORY_ANOMALY_RULES.spof, relations: ['HOSTED_ON'] }))
      .rejects.toThrow(/HOSTED_ON/)
    expect(fake.runs).toEqual([])
  })

  it('writes the validated settings under tenant and rule key, and returns them as non-default', async () => {
    const input = { ...FACTORY_ANOMALY_RULES.spof, threshold: 3, extra: 'dropped' }
    const out = await saveAnomalyRuleConfig('t-acme', 'spof', input)
    expect(out).toMatchObject({ ruleKey: 'spof', threshold: 3, isDefault: false })
    expect(out.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const write = fake.runs.find((r) => r.q.includes('MERGE'))!
    expect(write.p).toMatchObject({ tenantId: 't-acme', ruleKey: 'spof', now: out.updatedAt })
    // Only the validated fields reach the graph: junk from the client does not persist.
    expect(JSON.parse(String(write.p['settings']))).not.toHaveProperty('extra')
    expect(fake.closed).toBe(1)
  })

  it('closes the session even when the write fails', async () => {
    fake.writeFails = true
    await expect(saveAnomalyRuleConfig('t-acme', 'orphan_ci', FACTORY_ANOMALY_RULES.orphan_ci)).rejects.toThrow('neo4j down')
    expect(fake.closed).toBe(1)
  })
})
