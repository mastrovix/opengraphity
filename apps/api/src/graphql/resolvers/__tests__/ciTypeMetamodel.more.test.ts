/**
 * ciTypeMetamodel.ts — the parts the main test file does not reach.
 *
 * Why they matter:
 * - the VALUES of the metamodel (field type, relation direction, cardinality,
 *   target type) are validated before any session: an unknown field type
 *   degrades the tenant's whole GraphQL schema, an invented direction leaves
 *   a relation inert in silence;
 * - per-language labels: a label without a language is refused, a blank one
 *   is dropped, never stored as an unreadable label;
 * - the two places that build a CI type (`mapCITypeNode` and the `ciTypes`
 *   list) map fields, relations and system relations the same way, sorted
 *   by order, with inherited `__base__` fields deduplicated by name;
 * - corrupt stored JSON (chain families, inline enum values) fails loudly
 *   instead of silently changing chain calculation or showing no values;
 * - `updateCIField` only touches a field of a type the tenant owns, attaches
 *   a dictionary only to an enum field, and never says «saved» on zero writes;
 * - the delete-confirmation queries (`ciFieldValueCount`,
 *   `ciTypeDeletionImpact`) are permission-gated and tenant-scoped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...orig, getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }
})

type Rec = Record<string, unknown>
type Result = { records: Array<{ get: (k: string) => unknown }>; summary: { counters: { updates: () => Rec } } }
const calls: Array<{ cypher: string; params: Rec }> = []
// Per-test answers, first matching needle wins; otherwise `defaults`.
let overrides: Array<[string, Result]> = []

const WROTE = { propertiesSet: 1, nodesCreated: 1, nodesDeleted: 0, relationshipsCreated: 1, relationshipsDeleted: 0 }
const NOTHING = { propertiesSet: 0, nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0 }
const res = (rows: Rec[] = [], counters: Rec = WROTE): Result => ({
  records: rows.map((r) => ({ get: (k: string) => (k in r ? r[k] : null) })),
  summary: { counters: { updates: () => counters } },
})

const TYPE_T = { properties: { id: 'ct-1', name: 'firewall', label: 'Firewall', scope: 'tenant', tenant_id: 'tenant-1', active: true } }
function defaults(cypher: string): Result {
  if (cypher.includes('RETURN t.scope AS scope')) return res([{ scope: 'tenant', name: 'firewall', label: 'Firewall' }])
  if (cypher.includes('MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})')) return res()
  if (cypher.includes('RETURN t.name AS name, t.neo4j_label AS label')) {
    return res([{ name: 'server', label: 'Server' }, { name: 'firewall', label: 'Firewall' }])
  }
  if (cypher.includes("WHERE t.scope IN ['base', 'itil']")) return res([{ name: 'server', scope: 'base' }])
  if (cypher.includes('RETURN count(t) AS n')) return res([{ n: 0 }])
  if (cypher.includes('collect(DISTINCT f.name) + collect(DISTINCT bf.name)')) return res([{ names: ['name', null] }])
  if (cypher.includes('HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition)') && cypher.includes('$id')) {
    return res([{ t: TYPE_T, fields: [], relations: [], systemRels: [] }])
  }
  return res()
}

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  close: vi.fn(),
}
const tx = {
  run: vi.fn(async (cypher: string, params: Rec) => {
    calls.push({ cypher, params })
    const hit = overrides.find(([needle]) => cypher.includes(needle))
    return hit ? hit[1] : defaults(cypher)
  }),
}
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)),
}))
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: vi.fn(), registerMetamodelCacheClearer: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ notifyCIGraphChanged: vi.fn(async () => 0) }))
vi.mock('../../../lib/triggerEngine.js', () => ({ invalidateTriggerCache: vi.fn() }))
vi.mock('../../../lib/rulesEngine.js', () => ({ invalidateRulesCache: vi.fn() }))
const IMPACT = { cis: 2, ticketCIs: 0, tickets: 0 }
vi.mock('../../../lib/ciTypeDeletion.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../lib/ciTypeDeletion.js')>()
  return { ...orig, loadCITypeDeletionImpact: vi.fn(async () => IMPACT) }
})
vi.mock('../../../lib/serviceMapRelationUsage.js', () => ({
  assertNoServiceMapFollows: vi.fn(async () => {}),
  serviceMapsBlockingRemoval: vi.fn(async () => ({ lost: [], name: '', maps: [{ id: 'm-1', name: 'Shop' }] })),
}))

const {
  buildMetamodelMutations, buildCITypesResolver, buildBaseCITypeResolver, fetchCITypeById,
  mapCITypeNode, assertChainFamilies, ciFieldValueCount, ciTypeDeletionImpact,
} = await import('../ciTypeMetamodel.js')
const { withSession } = await import('../ci-utils.js')
const { invalidateSchema } = await import('../../../lib/schemaInvalidator.js')
const { loadCITypeDeletionImpact } = await import('../../../lib/ciTypeDeletion.js')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'a@t.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, role: 'operator', permissions: perms('operator') }
const m = buildMetamodelMutations()
const find = (needle: string) => calls.find((c) => c.cypher.includes(needle))

async function errorOf(p: Promise<unknown>): Promise<GraphQLError> {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(GraphQLError)
  return e as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  overrides = []
})

describe('value gates run before any session', () => {
  it('addCIField: an unknown field type is refused, naming the allowed ones', async () => {
    const e = await errorOf(m.addCIField(null, { typeId: 'ct-1', input: { name: 'cost', label: 'Cost', fieldType: 'money' } }, admin))
    expect(e.extensions['code']).toBe('BAD_USER_INPUT')
    expect(e.message).toMatch(/unknown field type "money"/)
    expect(e.extensions['allowedFieldTypes']).toContain('string')
    expect(withSession).not.toHaveBeenCalled()
  })

  const relInput = (over: Rec = {}) => ({
    name: 'protects', label: 'Protects', relationshipType: 'PROTECTS', direction: 'outgoing', cardinality: 'many', targetType: 'server', ...over,
  })
  it('addCIRelation: an invented direction or cardinality is refused before writing', async () => {
    const dir = await errorOf(m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ direction: 'right' }) }, admin))
    expect(dir.message).toMatch(/unknown direction "right"/)
    const card = await errorOf(m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ cardinality: 'several' }) }, admin))
    expect(card.message).toMatch(/unknown cardinality "several"/)
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('addCIRelation: the target type is required, and a name is stored as its Neo4j label', async () => {
    const e = await errorOf(m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ targetType: '  ' }) }, admin))
    expect(e.message).toMatch(/the target type is required/)
    await m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ targetType: 'server' }) }, admin)
    // Why: edges are matched against CI labels, so the stored form must be the label.
    expect(find('CREATE (r:CIRelationDefinition')!.params).toMatchObject({ targetType: 'Server', tenantId: 'tenant-1', order: 0 })
  })

  it('addCIRelation: `any` is accepted as is, without reading the types', async () => {
    await m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ targetType: 'any', order: 3 }) }, admin)
    expect(find('RETURN t.name AS name, t.neo4j_label AS label')).toBeUndefined()
    expect(find('CREATE (r:CIRelationDefinition')!.params).toMatchObject({ targetType: 'any', order: 3 })
  })

  it('addCIRelation: an unknown target type is refused listing what exists', async () => {
    const e = await errorOf(m.addCIRelation(null, { typeId: 'ct-1', input: relInput({ targetType: 'router' }) }, admin))
    expect(e.message).toContain('Available: any, firewall, server.')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})

describe('per-language labels', () => {
  it('createCIType stores trimmed labels and drops blank ones', async () => {
    await m.createCIType(null, { input: { name: 'loadbalancer', label: 'LB', labels: [{ language: ' it ', label: ' Bilanciatore ' }, { language: 'en', label: '  ' }] } }, admin)
    const w = find('MERGE (t:CITypeDefinition')!
    expect(JSON.parse(String(w.params['labels']))).toEqual({ it: 'Bilanciatore' })
  })
  it('a label without a language is refused, nothing written', async () => {
    const e = await errorOf(m.createCIType(null, { input: { name: 'loadbalancer', label: 'LB', labels: [{ language: ' ', label: 'x' }] } }, admin))
    expect(e.message).toMatch(/a label without a language/)
    expect(withSession).not.toHaveBeenCalled()
  })
  it('updateCIType writes labels, icon and color when given', async () => {
    await m.updateCIType(null, { id: 'ct-1', input: { labels: [{ language: 'it', label: 'Muro' }], icon: 'shield', color: '#fff' } }, admin)
    const w = find('SET t += $updates')!
    expect(w.params).toMatchObject({ id: 'ct-1', tenantId: 'tenant-1', updates: { icon: 'shield', color: '#fff' } })
    expect(JSON.parse(String((w.params['updates'] as Rec)['labels']))).toEqual({ it: 'Muro' })
  })
})

describe('mapCITypeNode', () => {
  const field = (id: string, order: number | undefined, extra: Rec = {}) => ({
    f: { properties: { id, name: id, label: id.toUpperCase(), field_type: 'string', ...(order === undefined ? {} : { order }), ...extra } },
    enumId: null, enumName: null, enumValues: null,
  })

  it('maps fields sorted by order with documented defaults, and drops empty rows', () => {
    const out = mapCITypeNode(
      { id: 't', name: 'x', label: 'X' },
      [field('b', 2), field('a', 1, { required: true, enum_values: '["x","y"]' }), { f: null, enumId: null, enumName: null, enumValues: null }, field('c', undefined)],
      [], [],
    )
    expect(out.fields.map((f) => f.name)).toEqual(['c', 'a', 'b'])
    expect(out.fields[1]).toMatchObject({ required: true, enumValues: ['x', 'y'], isSystem: false, defaultValue: null, enumTypeId: null })
    // Defaults of a type without scope/tenant: it ships with the product.
    expect(out).toMatchObject({ active: true, scope: 'base', tenantId: 'system', chainFamilies: [], serviceRole: null, validationScript: null })
  })

  it('attached dictionary values win over inline ones', () => {
    const out = mapCITypeNode({ id: 't' }, [{ ...field('a', 1, { enum_values: ['inline'] }), enumId: 'e', enumName: 'n', enumValues: ['low'] }], [], [])
    expect(out.fields[0]).toMatchObject({ enumValues: ['low'], enumTypeId: 'e', enumTypeName: 'n' })
  })

  it('corrupt inline enum values fail loudly', () => {
    expect(() => mapCITypeNode({ id: 't' }, [field('a', 1, { enum_values: '{"a":1}' })], [], [])).toThrow(/not a valid JSON array/)
  })

  it('maps relations (sorted) and system relations, skipping empty ones', () => {
    const out = mapCITypeNode({ id: 't' }, [], [
      { id: 'r2', name: 'b', relationship_type: 'X', order: 2 }, {}, { id: 'r1', name: 'a', target_type: 'Server', cardinality: 'one', direction: 'incoming' },
    ], [{ id: 's1', name: 'owner', target_entity: 'Team' }, {}])
    expect(out.relations.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(out.relations[0]).toMatchObject({ targetType: 'Server', cardinality: 'one', direction: 'incoming', order: 0 })
    expect(out.systemRelations).toEqual([{ id: 's1', name: 'owner', label: undefined, relationshipType: undefined, targetEntity: 'Team', required: false, order: 0 }])
  })

  it('chain families: stored JSON is parsed; corrupt, non-array or odd types fail loudly', () => {
    expect(mapCITypeNode({ chain_families: '["infrastructure"]' }, [], [], []).chainFamilies).toEqual(['infrastructure'])
    expect(mapCITypeNode({ chain_families: ['application'] }, [], [], []).chainFamilies).toEqual(['application'])
    expect(() => mapCITypeNode({ chain_families: '{oops' }, [], [], [])).toThrow(/Corrupt chain_families JSON/)
    expect(() => mapCITypeNode({ chain_families: '"x"' }, [], [], [])).toThrow(/not an array \(got string\)/)
    expect(() => mapCITypeNode({ chain_families: 42 }, [], [], [])).toThrow(/unexpected type number/)
  })
})

describe('assertChainFamilies', () => {
  it('a non-list is refused, naming what arrived', () => {
    expect(() => assertChainFamilies('infrastructure' as never)).toThrow(/must be a list of families.*"infrastructure"/)
  })
})

describe('reads', () => {
  it('fetchCITypeById maps relations and system relations of the type', async () => {
    overrides = [['HAS_SYSTEM_RELATION]->(sr', res([{
      t: TYPE_T, fields: [],
      relations: [{ properties: { id: 'r1', name: 'protects', order: 1 } }, null],
      systemRels: [{ properties: { id: 's1', name: 'owner', required: true } }, null],
    }])]]
    const out = await fetchCITypeById('ct-1', 'tenant-1')
    expect(out.relations).toEqual([expect.objectContaining({ id: 'r1', name: 'protects' })])
    expect(out.systemRelations).toEqual([expect.objectContaining({ id: 's1', required: true })])
  })

  it('ciTypes: inherited __base__ fields come first by order and a same-name type field is not listed twice', async () => {
    const f = (id: string, name: string, order: number) => ({ f: { properties: { id, name, order, field_type: 'string' } }, enumId: null, enumName: null, enumValues: null })
    overrides = [['AND t.active = true', res([{
      t: { properties: { id: 'ct-1', name: 'firewall', active: true, chain_families: '["infrastructure"]' } },
      typeFields: [f('tf-os', 'os', 5), f('tf-name', 'name', 9)],
      baseFields: [f('bf-name', 'name', 0), f('bf-status', 'status', 1), { f: null, enumId: null, enumName: null, enumValues: null }],
      relations: [{ properties: { id: 'r1', name: 'protects', target_type: 'Server' } }, null],
      systemRels: [{ properties: { id: 's1', name: 'owner' } }, null],
    }])]]
    const [t] = await buildCITypesResolver()(null, null, operator) as Array<Record<string, unknown>>
    const fields = t!['fields'] as Array<Rec>
    expect(fields.map((x) => x['id'])).toEqual(['bf-name', 'bf-status', 'tf-os'])
    expect(fields[0]).toMatchObject({ required: false, defaultValue: null, isSystem: false, enumValues: [] })
    expect(t).toMatchObject({ scope: 'base', tenantId: 'system', chainFamilies: ['infrastructure'], serviceRole: null })
    expect(t!['relations']).toEqual([{ id: 'r1', name: 'protects', label: undefined, relationshipType: undefined, targetType: 'Server', cardinality: undefined, direction: undefined, order: 0 }])
    expect(t!['systemRelations']).toEqual([expect.objectContaining({ id: 's1', required: false, order: 0 })])
  })

  it('baseCIType: no __base__ at all is NOT_FOUND, not an empty type', async () => {
    overrides = [["MATCH (t:CITypeDefinition {name: '__base__'})", res()]]
    await expect(buildBaseCITypeResolver()(null, null, operator)).rejects.toThrow('__base__ not found')
  })
})

describe('delete-confirmation queries', () => {
  it('ciFieldValueCount: permission first, then the count of values of the tenant\'s own field', async () => {
    await expect(ciFieldValueCount(null, { typeId: 'ct-1', fieldId: 'f-1' }, operator)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(withSession).not.toHaveBeenCalled()
    overrides = [
      ['RETURN f.name AS name, t.neo4j_label AS label', res([{ name: 'rack', label: 'Firewall' }])],
      ['RETURN size(rows) AS count', res([{ count: 7, sample: [] }])],
    ]
    await expect(ciFieldValueCount(null, { typeId: 'ct-1', fieldId: 'f-1' }, admin)).resolves.toBe(7)
    expect(find('RETURN f.name AS name')!.params).toEqual({ typeId: 'ct-1', fieldId: 'f-1', tenantId: 'tenant-1' })
  })

  it('ciTypeDeletionImpact: the impact plus the service maps that would block the deletion', async () => {
    await expect(ciTypeDeletionImpact(null, { id: 'ct-1' }, operator)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    const out = await ciTypeDeletionImpact(null, { id: 'ct-1' }, admin)
    expect(out).toEqual({ ...IMPACT, blockingServiceMaps: [{ id: 'm-1', name: 'Shop' }] })
    expect(loadCITypeDeletionImpact).toHaveBeenCalledWith(session, 'tenant-1', 'ct-1', 'firewall', 'Firewall')
  })

  it('ciTypeDeletionImpact on a type shipped with the product is refused', async () => {
    overrides = [['RETURN t.scope AS scope', res([{ scope: 'base', name: 'server', label: null }])]]
    const e = await errorOf(ciTypeDeletionImpact(null, { id: 'base-1' }, admin))
    // Why: the label falls back to the name when the shipped type has none.
    expect(e.message).toContain('Type "server" (server) ships with the product')
  })
})

describe('addCIField — field names of a type with no readable metamodel row', () => {
  it('no row for the type names → only the gate on base names applies, the field is created', async () => {
    overrides = [
      ['collect(DISTINCT f.name) + collect(DISTINCT bf.name)', res()],
      ['CREATE (f:CIFieldDefinition', res([{ f: { properties: { id: 'f-new' } } }])],
    ]
    await m.addCIField(null, { typeId: 'ct-1', input: { name: 'rackUnit', label: 'Rack unit', fieldType: 'number' } }, admin)
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })
})

describe('updateCIField', () => {
  const upd = (input: Rec, ctx = admin) => m.updateCIField(null, { typeId: 'ct-1', fieldId: 'f-1', input }, ctx)
  const existing = (fieldType: string) => ['RETURN f.name AS name, f.field_type AS fieldType', res([{ name: 'state', fieldType, isSystem: false }])] as [string, Result]

  it('a field that is not on a type of this tenant is NOT_FOUND, nothing written', async () => {
    overrides = [['RETURN f.name AS name, f.field_type AS fieldType', res()]]
    const e = await errorOf(upd({ label: 'X' }))
    expect(e.extensions['code']).toBe('NOT_FOUND')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('a dictionary is attached only to an enum field', async () => {
    overrides = [existing('string')]
    const e = await errorOf(upd({ enumTypeId: 'e-1' }))
    expect(e.message).toMatch(/only an enum field uses a dictionary/)
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('a dictionary that does not exist is refused', async () => {
    overrides = [existing('enum'), ['MATCH (e:EnumTypeDefinition {id: $enumTypeId})', res()]]
    const e = await errorOf(upd({ enumTypeId: 'e-x' }))
    expect(e.message).toMatch(/Dictionary e-x does not exist/)
  })

  it('another tenant\'s dictionary is refused', async () => {
    overrides = [existing('enum'), ['MATCH (e:EnumTypeDefinition {id: $enumTypeId})', res([{ id: 'e-2', name: 'x', tenantId: 'tenant-2' }])]]
    await errorOf(upd({ enumTypeId: 'e-2' }))
    expect(session.executeWrite).not.toHaveBeenCalled()
  })

  it('writes only what was given (explicit null clears a script), scoped to the tenant, then invalidates the schema', async () => {
    overrides = [existing('enum'), ['MATCH (e:EnumTypeDefinition {id: $enumTypeId})', res([{ id: 'e-1', name: 'states', tenantId: 'tenant-1' }])]]
    await upd({ label: 'State', enumTypeId: 'e-1', validationScript: null, defaultValue: 'up' })
    const w = find('SET f.label')!
    expect(w.cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(w.params).toMatchObject({
      typeId: 'ct-1', fieldId: 'f-1', tenantId: 'tenant-1', enumTypeId: 'e-1', label: 'State', required: null,
      defaultValueGiven: true, defaultValue: 'up', validationGiven: true, validationScript: null,
      visibilityGiven: false, defaultScriptGiven: false, order: null,
    })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('zero writes is an error, not «saved»', async () => {
    overrides = [existing('string'), ['SET f.label', res([], NOTHING)]]
    const e = await errorOf(upd({ label: 'X' }))
    expect(e.message).toMatch(/nothing was written/)
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('a shipped type is refused before reading the field', async () => {
    overrides = [['RETURN t.scope AS scope', res([{ scope: 'base', name: 'server', label: 'Server' }])]]
    await errorOf(upd({ label: 'X' }))
    expect(find('RETURN f.name AS name, f.field_type')).toBeUndefined()
  })

  it('needs the metamodel permission', async () => {
    await expect(upd({ label: 'X' }, operator)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
  })
})

describe('removeCIRelation — incoming relations', () => {
  it('counts the edges pointing TO the type\'s CIs, and refuses while some exist', async () => {
    overrides = [
      ['rel.target_type AS targetType', res([{ label: 'Firewall', name: 'protectedBy', relationshipType: 'PROTECTS', direction: 'incoming', targetType: 'any' }])],
      ['startNode(e)', res([{ n: 4 }])],
    ]
    const e = await errorOf(m.removeCIRelation(null, { typeId: 'ct-1', relationId: 'r-1' }, admin))
    expect(e.message).toContain('4 PROTECTS link(s)')
    expect(find('startNode(e)')!.cypher).toContain('(other)-[e:PROTECTS]->(me)')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})
