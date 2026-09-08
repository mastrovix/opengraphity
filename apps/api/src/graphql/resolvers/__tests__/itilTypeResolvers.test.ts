/**
 * itilTypeResolvers.ts — pin della Cypher: letture con
 * `t.scope = 'itil' AND t.tenant_id IN [$tenantId, 'system']`; i campi creati
 * hanno tenant_id del contesto; protezioni sui campi di sistema; requireAdmin
 * prima della sessione. Le mutation sui TIPI usano lo stesso predicato IN
 * [..., 'system'] (comportamento reale, pinnato + it.fails).
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

const { buildITILMutations, buildITILTypesResolver, buildITILTypeFieldsResolver, fetchITILTypeById } = await import('../itilTypeResolvers.js')
const { withSession } = await import('../ci-utils.js')
const { invalidateSchema } = await import('../../../lib/schemaInvalidator.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }

const requireAdmin = (ctx: GraphQLContext) => {
  if (ctx.role !== 'admin') throw new GraphQLError('Accesso negato: richiesto ruolo admin', { extensions: { code: 'FORBIDDEN' } })
}
const mutations = buildITILMutations(requireAdmin)

const TYPE_NODE = { properties: { id: 'it-1', name: 'incident', label: 'Incident', scope: 'itil', tenant_id: 'tenant-1', active: true } }
const FIELD = { properties: { id: 'f-1', name: 'impact', label: 'Impatto', field_type: 'enum', required: true, order: 1, is_system: true } }
const typeRecord = () => ({
  get: (k: string) => ({
    t: TYPE_NODE,
    fieldData: [{ f: FIELD, enumTypeId: 'e-1', enumTypeName: 'impact', enumTypeLabel: 'Impatto', enumTypeValues: ['low', 'high'] }],
    relations: [], systemRels: [],
  })[k],
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
const ITIL_SCOPE = "t.scope = 'itil' AND t.tenant_id IN [$tenantId, 'system']"

describe('letture ITIL — tenant + system', () => {
  beforeEach(() => reset())

  it('itilTypes: WHERE t.scope = \'itil\' AND t.tenant_id IN [$tenantId, \'system\'] AND t.active = true; campi con enum risolto', async () => {
    const out = await buildITILTypesResolver()(null, null, operator)
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE} AND t.active = true`)
    expect(params).toEqual({ tenantId: 'tenant-1' })
    expect(out[0]).toMatchObject({ id: 'it-1', name: 'incident' })
    expect(out[0]!.fields[0]).toMatchObject({ id: 'f-1', enumTypeId: 'e-1', enumTypeName: 'impact', enumValues: ['low', 'high'], isSystem: true })
  })

  it('itilTypeFields(typeId): stesso predicato, parametri typeId + tenantId', async () => {
    reset([{ records: [] }])
    await expect(buildITILTypeFieldsResolver()(null, { typeId: 'it-1' }, operator)).resolves.toEqual([])
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(params).toEqual({ typeId: 'it-1', tenantId: 'tenant-1' })
  })

  it('fetchITILTypeById: stesso predicato; tipo di altro tenant → "ITIL type non trovato"', async () => {
    reset([{ records: [] }])
    await expect(fetchITILTypeById('it-altrui', 'tenant-1')).rejects.toThrow('ITIL type non trovato')
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(params).toEqual({ id: 'it-altrui', tenantId: 'tenant-1' })
  })
})

describe('requireAdmin prima della sessione', () => {
  beforeEach(() => reset())

  it.each(Object.keys(buildITILMutations(requireAdmin)))('%s con operator → FORBIDDEN, nessuna sessione', async (name) => {
    const fn = mutations[name as keyof typeof mutations] as (p: unknown, a: never, c: GraphQLContext) => Promise<unknown>
    const err = await fn(null, { id: 'x', typeId: 'x', fieldId: 'x', input: { name: 'n', label: 'l' } } as never, operator).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('FORBIDDEN')
    expect(withSession).not.toHaveBeenCalled()
  })
})

describe('updateITILType', () => {
  beforeEach(() => reset())

  it('SET t += $updates solo dei campi passati; invalidateSchema del tenant; MATCH scopato al solo tenant (i tipi "system" sono in sola lettura)', async () => {
    await mutations.updateITILType(null, { id: 'it-1', input: { label: 'Incidente', validationScript: null } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain("MATCH (t:CITypeDefinition {id: $id, tenant_id: $tenantId}) WHERE t.scope = 'itil' SET t += $updates")
    expect(params).toEqual({ id: 'it-1', tenantId: 'tenant-1', updates: { label: 'Incidente', validation_script: null } })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('la mutation scrive SOLO con tenant_id = $tenantId (mai "system") — BUG multi-tenant: un admin di tenant può modificare label/icon/validation_script di un tipo ITIL condiviso (itilTypeResolvers.ts:208)', async () => {
    await mutations.updateITILType(null, { id: 'it-sys', input: { label: 'X' } }, admin)
    expect(call(0).cypher).not.toContain("'system'")
  })
})

describe('createITILField', () => {
  beforeEach(() => reset())

  it('enum senza enumTypeId → BAD_USER_INPUT senza sessione', async () => {
    const err = await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'enum' } }, admin).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect(withSession).not.toHaveBeenCalled()
  })

  it('campo creato con tenant_id = $tenantId, scope itil, is_system false; enum linkato solo se del tenant/sistema; enum_values inline azzerati se c\'è enumTypeId', async () => {
    await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'origine', label: 'Origine', fieldType: 'enum', enumTypeId: 'e-1', enumValues: ['a'] } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain("scope:             'itil'")
    expect(cypher).toContain('tenant_id:         $tenantId')
    expect(cypher).toContain('is_system:         false')
    expect(cypher).toContain("WHERE $enumTypeId IS NOT NULL AND e.tenant_id IN [$tenantId, 'system']")
    expect(params).toMatchObject({ typeId: 'it-1', tenantId: 'tenant-1', enumTypeId: 'e-1', enumValues: null, order: 99, required: false })
  })

  it('enum inline (senza enumTypeId, fieldType non enum) → enum_values serializzato', async () => {
    await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'string', enumValues: ['a', 'b'] } }, admin)
    expect(call(0).params['enumValues']).toBe('["a","b"]')
  })
})

describe('updateITILField / deleteITILField — protezione dei campi di sistema', () => {
  beforeEach(() => reset())

  it('updateITILField: name/field_type/required dei campi di sistema sono preservati in Cypher (CASE WHEN f.is_system)', async () => {
    await mutations.updateITILField(null, { typeId: 'it-1', fieldId: 'f-1', input: { name: 'hack', label: 'L', fieldType: 'string', required: false } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain('f.required          = CASE WHEN f.is_system = true THEN f.required ELSE $required END')
    expect(cypher).toContain('f.field_type        = CASE WHEN f.is_system = true THEN f.field_type ELSE $fieldType END')
    expect(cypher).toContain('f.name              = CASE WHEN f.is_system = true THEN f.name ELSE $name END')
    expect(cypher).toContain('OPTIONAL MATCH (f)-[oldRel:USES_ENUM]->(:EnumTypeDefinition)')
    expect(params).toMatchObject({ typeId: 'it-1', fieldId: 'f-1', tenantId: 'tenant-1', name: 'hack', enumTypeId: null })
  })

  it('deleteITILField: campo di sistema → errore, nessuna DELETE', async () => {
    reset([{ records: [{ get: () => true }] }])
    await expect(mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-1' }, admin)).rejects.toThrow('I campi di sistema non possono essere eliminati')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('deleteITILField: campo del tenant → DETACH DELETE scoped, invalidateSchema', async () => {
    reset([{ records: [{ get: () => false }] }, { records: [] }])
    await mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-2' }, admin)
    const { cypher, params } = call(1)
    expect(cypher).toContain('DETACH DELETE f')
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(params).toEqual({ typeId: 'it-1', fieldId: 'f-2', tenantId: 'tenant-1' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('deleteITILField: campo inesistente → "Campo non trovato" senza DELETE — BUG: `check.records[0]?.get(...)` dà undefined, il confronto è `=== null` → il DELETE (no-op) e il fetch vengono eseguiti (itilTypeResolvers.ts:376-377)', async () => {
    reset([{ records: [] }])
    await expect(mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-ghost' }, admin)).rejects.toThrow('Campo non trovato')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})
