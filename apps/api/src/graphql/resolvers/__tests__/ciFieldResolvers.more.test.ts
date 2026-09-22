/**
 * The per-CI field resolvers: owner group, support group, and the outgoing
 * dependencies.
 *
 * Why these behaviours matter:
 *  - Owner and support group decide who gets paged when the CI breaks. The
 *    query must stay inside the caller's tenant on BOTH ends (the CI and the
 *    team), otherwise a CI id guessed from another tenant would reveal its
 *    team.
 *  - When the list query already prefetched the groups (`_prefetched`), the
 *    resolver must not issue one query per row: that is the N+1 that made the
 *    CMDB list slow. A prefetched "no group" is null, not a second lookup.
 *  - A dependency whose label is not a CI type of this tenant (a stale label,
 *    a node of another feature) must be hidden rather than rendered with an
 *    undefined type.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

type Row = Record<string, unknown>
const rows: Row[] = []
const seen: Array<{ cypher: string; params: Record<string, unknown> }> = []
const withSession = vi.hoisted(() => vi.fn())
vi.mock('../ci-utils.js', () => ({ withSession }))

const { buildFieldResolvers, mapTeamProps } = await import('../ciFieldResolvers.js')

const rel = (relationshipType: string, direction: 'outgoing' | 'incoming', targetType: string) =>
  ({ relationshipType, direction, targetType })
const type = (name: string, neo4jLabel: string, relations: ReturnType<typeof rel>[]) =>
  ({ name, neo4jLabel, relations, fields: [], systemRelations: [] }) as unknown as CITypeWithDefinitions

const application = type('application', 'Application', [rel('RUNS_ON', 'outgoing', 'Server')])
const server = type('server', 'Server', [])
const TYPES = [application, server]
const ctx = { tenantId: 't1' } as never

beforeEach(() => {
  rows.length = 0
  seen.length = 0
  withSession.mockReset()
  withSession.mockImplementation(async (fn: (s: unknown) => unknown) => fn({
    executeRead: (work: (tx: unknown) => unknown) => work({
      run: (cypher: string, params: Record<string, unknown>) => {
        seen.push({ cypher, params })
        return Promise.resolve({ records: rows.map((r) => ({ get: (k: string) => r[k] })) })
      },
    }),
  }))
})

describe('mapTeamProps', () => {
  it('maps a full team and turns missing optionals into null', () => {
    expect(mapTeamProps({ id: 'tm1', tenant_id: 't1', name: 'Network', description: 'L2', type: 'resolver', created_at: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ id: 'tm1', tenantId: 't1', name: 'Network', description: 'L2', type: 'resolver', createdAt: '2026-01-01T00:00:00.000Z' })
    expect(mapTeamProps({ id: 'tm2', tenant_id: 't1', name: 'Ops' }))
      .toEqual({ id: 'tm2', tenantId: 't1', name: 'Ops', description: null, type: null, createdAt: null })
  })
})

describe.each([
  ['ownerGroup', 'OWNED_BY', '_ownerGroup'],
  ['supportGroup', 'SUPPORTED_BY', '_supportGroup'],
] as const)('%s', (field, relType, prefetchKey) => {
  const R = buildFieldResolvers(application, TYPES)

  it('uses the prefetched group without querying', async () => {
    const team = { id: 'tm1', tenantId: 't1', name: 'Net', description: null, type: null, createdAt: null }
    expect(await R[field]({ id: 'ci1', _prefetched: true, [prefetchKey]: team }, null, ctx)).toBe(team)
    expect(withSession).not.toHaveBeenCalled()
  })

  it('a prefetched "no group" is null, and still no query', async () => {
    expect(await R[field]({ id: 'ci1', _prefetched: true }, null, ctx)).toBeNull()
    expect(withSession).not.toHaveBeenCalled()
  })

  it('otherwise reads the team through the right edge, inside the tenant', async () => {
    rows.push({ p: { id: 'tm1', tenant_id: 't1', name: 'Net' } })
    expect(await R[field]({ id: 'ci1' }, null, ctx)).toMatchObject({ id: 'tm1', name: 'Net' })
    expect(seen[0]!.cypher).toContain(`[:${relType}]`)
    // Both ends are tenant-scoped: the CI and the team.
    expect(seen[0]!.cypher).toContain('(n {id: $id, tenant_id: $tenantId})')
    expect(seen[0]!.cypher).toContain('(t:Team {tenant_id: $tenantId})')
    expect(seen[0]!.params).toEqual({ id: 'ci1', tenantId: 't1' })
  })

  it('a CI without that group is null', async () => {
    expect(await R[field]({ id: 'ci1' }, null, ctx)).toBeNull()
  })
})

describe('dependencies (outgoing)', () => {
  it('lists declared outgoing edges with the CI fields the detail shows', async () => {
    rows.push({ props: { id: 's1', name: 'srv-01', status: 'active', environment: 'production', chain: 'A' }, label: 'Server', relation: 'RUNS_ON' })
    const out = await buildFieldResolvers(application, TYPES).dependencies({ id: 'app1' }, null, ctx)
    expect(out).toEqual([{ ci: { id: 's1', name: 'srv-01', type: 'server', status: 'active', environment: 'production', chain: 'A' }, relation: 'RUNS_ON' }])
    expect(seen[0]!.cypher).toContain('(n)-[rel]->(d)')
  })

  it('hides an edge towards a label that is not a CI type of this tenant', async () => {
    rows.push({ props: { id: 'x1', name: 'ghost' }, label: 'LegacyThing', relation: 'RUNS_ON' })
    expect(await buildFieldResolvers(application, TYPES).dependencies({ id: 'app1' }, null, ctx)).toEqual([])
  })

  it('hides an outgoing edge the metamodel does not declare', async () => {
    rows.push({ props: { id: 's1', name: 'srv-01' }, label: 'Server', relation: 'BACKS_UP' })
    expect(await buildFieldResolvers(application, TYPES).dependencies({ id: 'app1' }, null, ctx)).toEqual([])
  })

  it('types without a label are not sent to the query as an empty label', async () => {
    const unlabeled = type('draft', '', [])
    await buildFieldResolvers(application, [...TYPES, unlabeled]).dependencies({ id: 'app1' }, null, ctx)
    expect(seen[0]!.params['labels']).toEqual(['Application', 'Server'])
  })
})
