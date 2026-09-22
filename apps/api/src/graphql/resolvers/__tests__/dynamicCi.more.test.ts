/**
 * The resolvers generated from the tenant's CI metamodel (resolvers/dynamic-ci.ts):
 * the parts dynamicCi.test.ts does not reach.
 *
 * Why these behaviours matter:
 *  - allCIs must map every row with ITS own type (a VM shown with printer
 *    fields is a wrong detail page) and drop rows whose label no active type
 *    declares, instead of returning half an object;
 *  - when the database fails, both read sessions must be closed and the error
 *    must reach the caller: a leaked session per failed request exhausts the
 *    pool, and a swallowed error shows an empty CMDB;
 *  - the CIBase interface must name the concrete type, and a CI whose type
 *    nobody declares any more must be an error that says so — the old
 *    fallback to "Application" showed a different thing without telling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
}))
vi.mock('../../../lib/cache.js', () => ({ cache: { get: vi.fn(() => undefined), set: vi.fn() } }))
vi.mock('../../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  impactRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON'),
}))
vi.mock('../ciMutations.js', () => ({
  buildCreateMutation: vi.fn(() => vi.fn()), buildUpdateMutation: vi.fn(() => vi.fn()), buildDeleteMutation: vi.fn(() => vi.fn()),
}))
vi.mock('../ciFieldResolvers.js', () => ({
  buildFieldResolvers: vi.fn(() => ({})),
  mapTeamProps: vi.fn((p: Record<string, unknown>) => ({ id: p['id'] })),
}))
vi.mock('../itilTypeResolvers.js', () => ({
  mapITILField: vi.fn(), fetchITILTypeById: vi.fn(),
  buildITILTypesResolver: vi.fn(() => vi.fn()), buildITILTypeFieldsResolver: vi.fn(() => vi.fn()),
  buildITILFieldValueCountResolver: vi.fn(() => vi.fn()), buildITILMutations: vi.fn(() => ({})),
}))
vi.mock('../ciTypeMetamodel.js', () => ({
  requireMetamodelPermission: vi.fn(), buildCITypesResolver: vi.fn(() => vi.fn()),
  buildBaseCITypeResolver: vi.fn(() => vi.fn()), buildMetamodelMutations: vi.fn(() => ({})),
  ciTypeDeletionImpact: vi.fn(), ciFieldValueCount: vi.fn(),
}))

const { buildDynamicCIResolvers } = await import('../dynamic-ci.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: new Set() } as never
const field = (name: string, isSystem = false) => ({ name, isSystem, fieldType: 'text' })
const TYPES = [
  { name: 'virtual_machine', neo4jLabel: 'VirtualMachine', fields: [field('id', true), field('ramGb')], relations: [] },
  { name: 'printer', neo4jLabel: 'Printer', fields: [field('id', true), field('tray')], relations: [] },
] as never as Parameters<typeof buildDynamicCIResolvers>[0]

const rec = (cols: Record<string, unknown>) => ({ get: (k: string) => cols[k] ?? null })

type Resolvers = {
  Query: Record<string, (a: unknown, b: never, c: never) => Promise<unknown>>
  CIBase: { __resolveType: (o: Record<string, unknown>) => string }
  VirtualMachine: { type: (p: Record<string, unknown>) => unknown }
}
const R = () => buildDynamicCIResolvers(TYPES) as unknown as Resolvers

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  txRun.mockResolvedValue({ records: [] })
})

describe('allCIs', () => {
  it('maps each row with its own type, snake_case props included, and drops unknown labels', async () => {
    txRun.mockImplementation(async (cypher: string) => (cypher.includes('count(n)')
      ? { records: [rec({ total: 3 })] }
      : { records: [
          rec({ props: { id: 'vm1', name: 'VM', ram_gb: 16, created_at: '2026-01-01T00:00:00.000Z' }, label: 'VirtualMachine' }),
          rec({ props: { id: 'p1', name: 'HP', tray: 2 }, label: 'Printer' }),
          rec({ props: { id: 'x' }, label: 'Ghost' }),
        ] }))
    const out = await R().Query['allCIs']!(null, {} as never, ctx) as { items: Array<Record<string, unknown>>; total: number }
    expect(out.total).toBe(3)
    expect(out.items).toHaveLength(2)
    expect(out.items[0]).toMatchObject({ id: 'vm1', type: 'virtual_machine', ramGb: 16, status: null, createdAt: '2026-01-01T00:00:00.000Z' })
    expect(out.items[0]).not.toHaveProperty('tray')
    expect(out.items[1]).toMatchObject({ id: 'p1', type: 'printer', tray: 2, createdAt: '' })
  })

  it('a null entry in ciTypes is skipped, not treated as an unknown type', async () => {
    await R().Query['allCIs']!(null, { ciTypes: [null, 'printer'] } as never, ctx)
    expect(String(txRun.mock.calls[0]![0])).toContain('n:Printer')
    expect(String(txRun.mock.calls[0]![0])).not.toContain('n:VirtualMachine')
  })

  it('a database failure closes both sessions and reaches the caller', async () => {
    txRun.mockRejectedValue(new Error('neo4j down'))
    await expect(R().Query['allCIs']!(null, {} as never, ctx)).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('the per-type list', () => {
  it('a database failure closes both sessions and reaches the caller', async () => {
    txRun.mockRejectedValue(new Error('neo4j down'))
    await expect(R().Query['printers']!(null, {} as never, ctx)).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('the detail by type', () => {
  it('returns the CI mapped with that type', async () => {
    txRun.mockResolvedValue({ records: [rec({ props: { id: 'p1', name: 'HP', tray: 1 } })] })
    expect(await R().Query['printer']!(null, { id: 'p1' } as never, ctx)).toMatchObject({ id: 'p1', type: 'printer', tray: 1 })
    expect(txRun.mock.calls[0]![1]).toEqual({ id: 'p1', tenantId: 't1' })
  })
})

describe('blastRadius', () => {
  it('an impacted node whose label no active type declares is dropped', async () => {
    txRun.mockResolvedValue({ records: [
      rec({ props: { id: 'p1' }, label: 'Printer', distance: 1, parentProps: null }),
      rec({ props: { id: 'g' }, label: 'Ghost', distance: 1, parentProps: null }),
    ] })
    const out = await R().Query['blastRadius']!(null, { id: 'root' } as never, ctx) as unknown[]
    expect(out).toHaveLength(1)
  })
})

describe('the type of a CI', () => {
  it('the generated type field prefers the stored type, then ciType, then the type name', () => {
    const typeOf = R().VirtualMachine.type
    expect(typeOf({ type: 'server' })).toBe('server')
    expect(typeOf({ ciType: 'vm' })).toBe('vm')
    expect(typeOf({})).toBe('virtual_machine')
  })

  it('CIBase resolves from __typename, ciType, the stored label, or the declared type name', () => {
    const resolve = R().CIBase.__resolveType
    expect(resolve({ __typename: 'Printer' })).toBe('Printer')
    expect(resolve({ ciType: 'printer' })).toBe('Printer')
    expect(resolve({ neo4j_label: 'VirtualMachine' })).toBe('VirtualMachine')
    expect(resolve({ type: 'virtual_machine' })).toBe('VirtualMachine')
  })

  it('a CI whose type no active type declares is an error naming it, not "Application"', () => {
    let err: GraphQLError | null = null
    try { R().CIBase.__resolveType({ type: 'mainframe' }) } catch (e) { err = e as GraphQLError }
    expect(err?.message).toContain('type="mainframe"')
    expect(err?.extensions['i18n']).toEqual({ key: 'errors.ci.unknownTypeOnRecord', params: { type: '"mainframe"' } })
  })
})
