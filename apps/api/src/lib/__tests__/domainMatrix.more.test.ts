/**
 * DOMAIN MATRICES — THE PARTS `domainMatrix.test.ts` DOES NOT REACH.
 *
 * Here the fake session actually RUNS the query callbacks, so the Cypher and
 * its parameters are observed as Neo4j would receive them. Pinned:
 *  - the admissible values of a matrix: a product SCALE when the dimension has
 *    one (service health, environment risk, CI health), otherwise the
 *    customer's vocabulary — mixing them up would let the matrix editor offer
 *    values the formula cannot use, or hide the customer's renamed values;
 *  - a stored matrix that is corrupt (no entries, not an object, a non-string
 *    cell) is an error that names the matrix, never a silent empty matrix
 *    that would map every ticket to "no priority";
 *  - vocabularies: the tenant's own wins, the shipped one otherwise, and a
 *    name that exists nowhere is an error, not an empty list;
 *  - the declared DEFAULT of a vocabulary: the tenant's declaration wins over
 *    the shipped one, and "not declared" is null (so callers must decide).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  queue: [] as Array<Array<Record<string, unknown>>>,
  runs: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  closes: 0,
  overrides: new Map<string, { id: string; name: string; values: string[] }>(),
  logError: vi.fn(),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      run: async (cypher: string, params: Record<string, unknown>) => {
        h.runs.push({ cypher, params })
        const rows = h.queue.shift() ?? []
        return { records: rows.map((m) => ({ get: (k: string) => (k in m ? m[k] : null) })) }
      },
    }),
    close: async () => { h.closes++ },
  }),
}))
vi.mock('../enumScope.js', () => ({ loadTenantEnumOverrides: async () => h.overrides }))
vi.mock('../logger.js', () => {
  const child = () => ({ error: h.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child })
  return { logger: child() }
})

const {
  matrixInputValues, matrixOutputValues, loadDomainMatrix, domainVocabulary, domainVocabularyDefault, clearDomainCaches,
} = await import('../domainMatrix.js')

beforeEach(() => {
  clearDomainCaches()
  h.queue = []; h.runs = []; h.closes = 0; h.overrides = new Map(); h.logError.mockClear()
})

describe('matrix input and output values', () => {
  it('a dimension with a product scale uses the scale, without reading any vocabulary', async () => {
    expect(await matrixInputValues('t1', 'service_urgency')).toEqual([['degraded', 'down']])
    expect(await matrixOutputValues('t1', 'environment_risk')).toEqual(['0', '1', '2', '3'])
    expect(await matrixOutputValues('t1', 'ci_health')).toEqual(['operational', 'degraded', 'down'])
    expect(h.runs).toEqual([])
  })

  it('other dimensions use the customer vocabulary, one per input in order', async () => {
    h.overrides = new Map([
      ['impact', { id: 'e1', name: 'impact', values: ['huge', 'small'] }],
      ['urgency', { id: 'e2', name: 'urgency', values: ['now', 'later'] }],
      ['priority', { id: 'e3', name: 'priority', values: ['p1', 'p2'] }],
    ])
    expect(await matrixInputValues('t1', 'priority')).toEqual([['huge', 'small'], ['now', 'later']])
    expect(await matrixOutputValues('t1', 'priority')).toEqual(['p1', 'p2'])
  })
})

describe('loadDomainMatrix — a corrupt stored matrix is an error that names it', () => {
  it.each([
    ['no entries', null, /node without `entries`/],
    ['a JSON array', '["high"]', /must be a key → value object/],
    ['a JSON scalar', '42', /must be a key → value object/],
    ['invalid JSON', '{nope', /is not valid JSON/],
    ['a non-string cell', { 'high|high': 3 }, /cell "high\|high" is not a string \(number\)/],
  ])('%s', async (_label, entries, message) => {
    h.queue = [[{ entries, updatedAt: null }]]
    await expect(loadDomainMatrix('t1', 'priority')).rejects.toThrow(message)
    expect(h.logError).toHaveBeenCalledOnce()
    // The session is released even when the matrix cannot be read.
    expect(h.closes).toBe(1)
  })

  it('accepts entries stored as an object as well as a JSON string, scoped to tenant and kind', async () => {
    h.queue = [[{ entries: { 'high|high': 'p1' }, updatedAt: '2026-09-01' }]]
    const m = await loadDomainMatrix('t1', 'priority')
    expect(m).toEqual({ kind: 'priority', entries: { 'high|high': 'p1' }, isDefault: false, updatedAt: '2026-09-01' })
    expect(h.runs[0]!.params).toEqual({ tenantId: 't1', kind: 'priority' })
  })
})

describe('domainVocabulary', () => {
  it('the tenant\'s own vocabulary wins, and the shipped one is not even read', async () => {
    h.overrides = new Map([['severity', { id: 'e', name: 'severity', values: ['sev1'] }]])
    expect(await domainVocabulary('t1', 'severity')).toEqual(['sev1'])
    expect(h.runs).toEqual([])
  })

  it('falls back to the shipped vocabulary, stored either as a list or as JSON', async () => {
    h.queue = [[{ values: ['low', 'high'] }], [{ values: '["a","b"]' }]]
    expect(await domainVocabulary('t1', 'severity')).toEqual(['low', 'high'])
    expect(await domainVocabulary('t1', 'urgency')).toEqual(['a', 'b'])
    expect(h.runs[0]!.params).toEqual({ name: 'severity' })
    expect(h.runs[0]!.cypher).toContain("tenant_id: 'system'")
  })

  it('a vocabulary that exists nowhere is an error, not an empty list', async () => {
    await expect(domainVocabulary('t1', 'severty')).rejects.toThrow(/Dictionary "severty" does not exist/)
    expect(h.closes).toBe(1)
  })
})

describe('domainVocabularyDefault', () => {
  it('the tenant\'s declared default wins over the shipped one, whatever the row order', async () => {
    h.queue = [[{ tenantId: 'system', defaultValue: 'active' }, { tenantId: 't1', defaultValue: 'in_service' }]]
    expect(await domainVocabularyDefault('t1', 'ci_status')).toBe('in_service')
    expect(h.runs[0]!.params).toEqual({ name: 'ci_status', tenantId: 't1' })
  })

  it('without a tenant declaration, the shipped default applies', async () => {
    h.queue = [[{ tenantId: 'system', defaultValue: 'active' }]]
    expect(await domainVocabularyDefault('t1', 'ci_status')).toBe('active')
  })

  it.each([
    ['no vocabulary at all', []],
    ['an empty declaration', [{ tenantId: 't1', defaultValue: '' }]],
    ['no declaration', [{ tenantId: 't1', defaultValue: null }]],
  ])('%s means "not declared" (null)', async (_label, rows) => {
    h.queue = [rows]
    expect(await domainVocabularyDefault('t1', 'ci_status')).toBeNull()
    expect(h.closes).toBe(1)
  })
})
