/**
 * resolvers/ciRelationships.ts — the guards before a relation is written.
 *
 * The relation type is interpolated into the Cypher text, so its format check
 * is the only thing between user input and query injection. A DEPENDS_ON cycle
 * would make impact and chain calculations loop or double count. Relation
 * types declared by the metamodel (including `A|B` lists) must be accepted,
 * or custom relations the customer defined could never be drawn.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
const cacheGet = vi.fn((_k: string): string[] | null => null)
const cacheSet = vi.fn()
vi.mock('../../../lib/cache.js', () => ({
  cache: { get: (k: string) => cacheGet(k), set: (...a: unknown[]) => cacheSet(...a), invalidate: vi.fn() },
  metamodelCacheKey: (prefix: string, tenantId: string) => `${prefix}:${tenantId}`,
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/chainCalculator.js', () => ({ calculateChain: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application)`),
}))

const { ciRelationshipResolvers: R } = await import('../ciRelationships.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') }
const txRun = vi.fn().mockResolvedValue({ records: [] })
const session = {
  close: vi.fn().mockResolvedValue(undefined),
  executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work({ run: txRun })),
}

type Answers = { endpoints?: unknown; declared?: boolean; hasCycle?: boolean }
function answer(a: Answers = {}) {
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('RETURN labels(s) AS sLabels')) return 'endpoints' in a ? a.endpoints : { sLabels: ['Application'], tLabels: ['Server'] }
    if (cypher.includes('hasCycle')) return { hasCycle: a.hasCycle ?? false }
    if (cypher.includes('AS declared')) return { declared: a.declared ?? true }
    return { deleted: 1 }
  }) as never)
}

async function failure(p: Promise<unknown>): Promise<Error & { extensions?: Record<string, unknown> }> {
  return p.then(() => { throw new Error('expected a rejection') }, (e: Error & { extensions?: Record<string, unknown> }) => e)
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheGet.mockReturnValue(null)
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQuery).mockResolvedValue([] as never)
  answer()
})

describe('relation type format (it ends up in the query text)', () => {
  it.each(['depends_on', 'DEPENDS-ON', 'X]->(y) DETACH DELETE y //', '1ABC', ''])('refuses %j before touching the database', async (relationType) => {
    const err = await failure(R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType }, ctx))
    expect(err.extensions?.['i18n']).toMatchObject({ key: 'errors.ciRelation.invalidFormat' })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('removal applies the same format check', async () => {
    const err = await failure(R.Mutation.removeCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'x) DELETE (y' }, ctx))
    expect(err.extensions?.['i18n']).toMatchObject({ key: 'errors.ciRelation.invalidFormat' })
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('allowed relation types come from the metamodel', () => {
  it('a `A|B` definition allows each listed type, and the set is cached per tenant', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ t: 'REALIZES | ENABLED_BY' }, { t: null }] as never)
    expect(await R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'ENABLED_BY' }, ctx)).toBe(true)
    const [key, cached] = cacheSet.mock.calls[0] as [string, string[]]
    expect(key).toBe('allowed_rel_types:t1')
    expect(cached).toEqual(expect.arrayContaining(['DEPENDS_ON', 'REALIZES', 'ENABLED_BY']))
  })

  it('a cached set is used without querying the metamodel again', async () => {
    cacheGet.mockReturnValue(['CUSTOM_REL'])
    expect(await R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'CUSTOM_REL' }, ctx)).toBe(true)
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('endpoints and cycles', () => {
  it('a missing endpoint (or one of another tenant) is NotFound, nothing written', async () => {
    answer({ endpoints: null })
    const err = await failure(R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'other-tenant', relationType: 'HOSTED_ON' }, ctx))
    expect(err.extensions?.['code']).toBe('NOT_FOUND')
    expect(session.executeWrite).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('a DEPENDS_ON that closes a cycle is refused, nothing written', async () => {
    answer({ hasCycle: true })
    const err = await failure(R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'DEPENDS_ON' }, ctx))
    expect(err.extensions?.['i18n']).toEqual({ key: 'errors.ciRelation.cycle' })
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('the cycle check only runs for DEPENDS_ON', async () => {
    answer({ hasCycle: true })
    expect(await R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'HOSTED_ON' }, ctx)).toBe(true)
  })

  it('an undeclared relation between untyped nodes names them sensibly', async () => {
    // Only the base label, or no label at all: the message must still read.
    answer({ endpoints: { sLabels: ['ConfigurationItem'], tLabels: [] }, declared: false })
    const err = await failure(R.Mutation.addCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'HOSTED_ON' }, ctx))
    expect(err.message).toBe('HOSTED_ON from ConfigurationItem to ? is not declared in the metamodel')
  })
})

describe('removal', () => {
  it('removing a relation that does not exist is NotFound, not a silent true', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ deleted: 0 } as never)
    const err = await failure(R.Mutation.removeCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'HOSTED_ON' }, ctx))
    expect(err.extensions?.['code']).toBe('NOT_FOUND')
  })

  it('a null row counts as nothing removed', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    const err = await failure(R.Mutation.removeCIRelationship(null, { sourceId: 'a', targetId: 'b', relationType: 'HOSTED_ON' }, ctx))
    expect(err.extensions?.['code']).toBe('NOT_FOUND')
  })
})
