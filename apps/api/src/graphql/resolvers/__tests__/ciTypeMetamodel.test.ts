/**
 * ciTypeMetamodel.ts — pin della Cypher del metamodello CMDB: le letture
 * includono i tipi base/sistema, le mutation sui tipi scrivono solo
 * `t.scope = 'tenant' AND t.tenant_id = $tenantId`; requireAdmin prima di
 * qualunque sessione; i tipi base non si eliminano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: vi.fn() }))
vi.mock('@opengraphity/schema-generator', () => ({
  toPascalCase: (s: string) => s.split(/[_\s-]+/).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(''),
}))

const { buildMetamodelMutations, buildCITypesResolver, buildBaseCITypeResolver, fetchCITypeById, requireAdmin } = await import('../ciTypeMetamodel.js')
const { withSession } = await import('../ci-utils.js')
const { invalidateSchema } = await import('../../../lib/schemaInvalidator.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }
const mutations = buildMetamodelMutations()

const TYPE_NODE = { properties: { id: 'ct-1', name: 'firewall', label: 'Firewall', icon: 'shield', color: '#000', active: true, scope: 'tenant', tenant_id: 'tenant-1' } }
const typeRecord = (over: Record<string, unknown> = {}) => ({
  get: (k: string) => ({ t: TYPE_NODE, fields: [], typeFields: [], baseFields: [], relations: [], systemRels: [], ...over })[k],
})

const txRun = vi.fn()
const queue: Array<{ records: unknown[] }> = []
function reset(responses: Array<{ records: unknown[] }> = []) {
  vi.clearAllMocks()
  queue.splice(0, queue.length, ...responses)
  txRun.mockImplementation(async () => queue.shift() ?? { records: [typeRecord()] })
  const tx = { run: txRun }
  mockSession.executeRead.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
  mockSession.executeWrite.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
}
const call = (i: number) => ({ cypher: txRun.mock.calls[i]![0] as string, params: txRun.mock.calls[i]![1] as Record<string, unknown> })

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
}

describe('requireAdmin — prima di qualunque sessione', () => {
  beforeEach(() => reset())

  it('requireAdmin: operator → FORBIDDEN, admin passa', () => {
    expect(() => requireAdmin(admin)).not.toThrow()
    expect(() => requireAdmin(operator)).toThrow(GraphQLError)
  })

  it.each(Object.keys(buildMetamodelMutations()))('%s con operator → FORBIDDEN senza aprire sessioni', async (name) => {
    const fn = mutations[name as keyof typeof mutations] as (p: unknown, a: never, c: GraphQLContext) => Promise<unknown>
    await expectCode(fn(null, { id: 'x', typeId: 'x', fieldId: 'x', relationId: 'x', input: { name: 'n', label: 'l' } } as never, operator), 'FORBIDDEN')
    expect(withSession).not.toHaveBeenCalled()
  })
})

describe('letture — tipi base/sistema + tipi del tenant', () => {
  beforeEach(() => reset())

  it('ciTypes: WHERE (t.scope = \'base\' OR (t.scope = \'tenant\' AND t.tenant_id = $tenantId)), campi filtrati allo stesso modo', async () => {
    reset([{ records: [typeRecord()] }])
    const out = await buildCITypesResolver()(null, null, operator)
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))")
    expect(cypher).toContain("WHERE f.scope = 'base' OR (f.scope = 'tenant' AND f.tenant_id = $tenantId)")
    expect(params).toEqual({ tenantId: 'tenant-1' })
    expect(out).toEqual([expect.objectContaining({ id: 'ct-1', name: 'firewall', fields: [], relations: [], systemRelations: [] })])
  })

  it('baseCIType: __base__ del tenant o di sistema (tenant prima), un solo nodo', async () => {
    await buildBaseCITypeResolver()(null, null, operator)
    const { cypher, params } = call(0)
    expect(cypher).toContain("MATCH (t:CITypeDefinition {name: '__base__'})")
    expect(cypher).toContain("WHERE t.tenant_id = $tenantId OR t.tenant_id = 'system'")
    expect(cypher).toContain('ORDER BY t.tenant_id DESC')
    expect(cypher).toContain('LIMIT 1')
    expect(params).toEqual({ tenantId: 'tenant-1' })
  })

  it('fetchCITypeById: base o tenant; tipo di altro tenant → "CIType non trovato"', async () => {
    reset([{ records: [] }])
    await expect(fetchCITypeById('ct-altrui', 'tenant-1')).rejects.toThrow('CIType non trovato')
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)")
    expect(params).toEqual({ id: 'ct-altrui', tenantId: 'tenant-1' })
  })
})

describe('mutation sui tipi — scrivono SOLO tipi del tenant', () => {
  beforeEach(() => reset())

  it('createCIType: MERGE {name, tenant_id: $tenantId} con scope tenant, mai "system"; poi invalidateSchema(tenant)', async () => {
    const out = await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall' } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain('MERGE (t:CITypeDefinition {name: $name, tenant_id: $tenantId})')
    expect(cypher).toContain("t.scope            = 'tenant'")
    expect(cypher).not.toContain("'system'")
    expect(params).toMatchObject({ name: 'firewall', tenantId: 'tenant-1', label: 'Firewall', icon: 'box', color: '#0284c7', neo4jLabel: 'Firewall' })
    expect(vi.mocked(withSession).mock.calls[0]![1]).toBe(true)
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
    expect(out).toMatchObject({ id: 'ct-1', name: 'firewall' })
  })

  it('updateCIType: SET solo dei campi passati, WHERE t.scope = \'tenant\' AND t.tenant_id = $tenantId', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { label: 'FW', active: false } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).toContain('SET t += $updates')
    expect(cypher).not.toContain("'system'")
    expect(params).toEqual({ id: 'ct-1', tenantId: 'tenant-1', updates: { label: 'FW', active: false } })
  })

  it('deleteCIType: tipo base → errore PRIMA di qualunque DELETE', async () => {
    reset([{ records: [{ get: () => 'base' }] }])
    await expect(mutations.deleteCIType(null, { id: 'ct-base' }, admin)).rejects.toThrow('I tipi base non possono essere eliminati')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('deleteCIType: tipo del tenant → DETACH DELETE con t.scope = \'tenant\' AND t.tenant_id = $tenantId', async () => {
    reset([{ records: [{ get: () => 'tenant' }] }, { records: [] }])
    await expect(mutations.deleteCIType(null, { id: 'ct-1' }, admin)).resolves.toBe(true)
    const { cypher, params } = call(1)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).toContain('DETACH DELETE t, f, rel, sr')
    expect(params).toEqual({ id: 'ct-1', tenantId: 'tenant-1' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it.each(['removeCIField', 'addCIRelation', 'removeCIRelation'] as const)('%s: WHERE t.scope = \'tenant\' AND t.tenant_id = $tenantId', async (name) => {
    await mutations[name](null, { typeId: 'ct-1', fieldId: 'f-1', relationId: 'r-1', input: { name: 'n', label: 'l', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'out' } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).not.toContain("'system'")
    expect(params['tenantId']).toBe('tenant-1')
  })
})

describe('addCIField', () => {
  beforeEach(() => reset())

  it('fieldType enum senza enumTypeId → BAD_USER_INPUT senza sessione', async () => {
    await expectCode(mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum' } }, admin), 'BAD_USER_INPUT')
    expect(withSession).not.toHaveBeenCalled()
  })

  it('il campo è creato con tenant_id = $tenantId e l\'enum linkato solo se del tenant o di sistema', async () => {
    await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum', enumTypeId: 'e-1' } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain('CREATE (f:CIFieldDefinition {')
    expect(cypher).toContain('tenant_id:         $tenantId')
    expect(cypher).toContain("WHERE $enumTypeId IS NOT NULL AND e.tenant_id IN [$tenantId, 'system']")
    expect(params).toMatchObject({ typeId: 'ct-1', tenantId: 'tenant-1', enumTypeId: 'e-1', fieldType: 'enum', required: false, order: 0 })
  })

  it('comportamento REALE: il MATCH del tipo accetta anche tenant_id "system" (campi aggiunti a __base__ di sistema)', async () => {
    await mutations.addCIField(null, { typeId: 'base-sys', input: { name: 'x', label: 'X', fieldType: 'string' } }, admin)
    expect(call(0).cypher).toContain("WHERE t.tenant_id IN [$tenantId, 'system']")
  })

  it.todo('addCIField su un tipo di sistema → Forbidden/Validation — GAP multi-tenant: il campo (scope base, is_system=true) è agganciato al __base__ condiviso e ciTypes lo legge senza filtro tenant (ciTypeMetamodel.ts:366-378, 151)')
})
