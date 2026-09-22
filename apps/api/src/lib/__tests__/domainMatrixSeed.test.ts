/**
 * Seeding the domain matrices of a tenant.
 *
 * Why these behaviours matter:
 *  - The seed is what a new tenant starts with AND what the migration writes:
 *    "nothing changes on day one". For `import_severity` the seed must keep the
 *    25 historical synonyms (`P1`, `sev2`, …), otherwise a ticket import that
 *    worked yesterday turns `P1` into an error row today.
 *  - `service_impact` must be keyed by the real `service_criticality` values,
 *    or every service incident fails on its first day.
 *  - Seeding must never overwrite a matrix the admin already edited (ON CREATE
 *    only), and must report exactly which kinds it created.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../enumScope.js', () => ({ loadTenantEnumOverrides: vi.fn(), SYSTEM_TENANT: 'system' }))

const {
  IMPORT_SEVERITY_LEGACY_SYNONYMS, SERVICE_IMPACT_BY_CRITICALITY, IMPORT_SEVERITY_VALUES,
  domainMatrixSeedEntries, domainMatrixSeedInputValues, seedDomainMatrices,
} = await import('../domainMatrixSeed.js')
const { DOMAIN_MATRIX_KINDS, DOMAIN_MATRIX_SEEDS } = await import('../domainMatrix.js')

type Kind = keyof typeof DOMAIN_MATRIX_KINDS
const kinds = Object.keys(DOMAIN_MATRIX_KINDS) as Kind[]

describe('domainMatrixSeedEntries', () => {
  it('every kind except import_severity is exactly the core seed', () => {
    for (const k of kinds.filter((x) => x !== 'import_severity')) {
      expect(domainMatrixSeedEntries(k)).toBe(DOMAIN_MATRIX_SEEDS[k])
    }
  })

  it('import_severity is the union of legacy synonyms and core seed, and the core wins on shared keys', () => {
    const e = domainMatrixSeedEntries('import_severity')
    for (const [k, v] of Object.entries(IMPORT_SEVERITY_LEGACY_SYNONYMS)) {
      // The synonyms keep resolving as they did before the matrix existed.
      if (!(k in DOMAIN_MATRIX_SEEDS.import_severity)) expect(e[k]).toBe(v)
    }
    for (const [k, v] of Object.entries(DOMAIN_MATRIX_SEEDS.import_severity)) expect(e[k]).toBe(v)
    expect(e['p1']).toBe('critical')
    expect(e['sev2']).toBe('high')
    expect(IMPORT_SEVERITY_VALUES).toEqual(Object.keys(e))
  })

  it('service_impact is keyed by the shipped service_criticality values', () => {
    expect(domainMatrixSeedEntries('service_impact')).toEqual(SERVICE_IMPACT_BY_CRITICALITY)
  })
})

describe('domainMatrixSeedInputValues', () => {
  it('splits composite keys into one distinct value list per input dimension', () => {
    const cols = domainMatrixSeedInputValues('priority')
    expect(cols).toHaveLength(DOMAIN_MATRIX_KINDS.priority.inputs.length)
    const keys = Object.keys(DOMAIN_MATRIX_SEEDS.priority)
    expect(new Set(cols[0])).toEqual(new Set(keys.map((k) => k.split('|')[0])))
    expect(new Set(cols[1])).toEqual(new Set(keys.map((k) => k.split('|')[1])))
    // No duplicates: each value appears once per dimension.
    expect(cols[0]!.length).toBe(new Set(cols[0]).size)
  })

  it('single-input kinds return the seed keys as the only column', () => {
    expect(domainMatrixSeedInputValues('import_severity')).toEqual([IMPORT_SEVERITY_VALUES])
  })
})

describe('seedDomainMatrices', () => {
  it('writes every kind with ON CREATE only, and returns just the kinds actually created', async () => {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
    const session = {
      run: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
        calls.push({ cypher, params })
        // `priority` already exists (the admin edited it): MERGE matched, nothing created.
        const created = params['kind'] !== 'priority'
        return { records: [{ get: (k: string) => (k === 'wasCreated' ? created : null) }] }
      }),
    }
    const created = await seedDomainMatrices(session as never, 't1')

    expect(calls.map((c) => c.params['kind'])).toEqual(kinds)
    expect(created).toEqual(kinds.filter((k) => k !== 'priority'))
    for (const c of calls) {
      // Never an unconditional SET: an edited matrix must survive a re-run.
      expect(c.cypher).toContain('ON CREATE SET m.entries = $entries')
      expect(c.cypher).not.toMatch(/ON MATCH/)
      expect(c.params['tenantId']).toBe('t1')
      expect(JSON.parse(c.params['entries'] as string)).toEqual(domainMatrixSeedEntries(c.params['kind'] as Kind))
    }
  })

  it('an empty answer counts as not created', async () => {
    const session = { run: vi.fn(async () => ({ records: [] })) }
    await expect(seedDomainMatrices(session as never, 't1')).resolves.toEqual([])
  })
})
