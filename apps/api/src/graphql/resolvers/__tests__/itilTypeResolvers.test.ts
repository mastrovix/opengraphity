/**
 * itilTypeResolvers.ts — pin della Cypher.
 *
 * Letture: tipo con `t.scope = 'itil' AND t.tenant_id IN [$tenantId, 'system']`,
 * CAMPI con `f.tenant_id IN [$tenantId, 'system']` (A1-2/A-4: prima non c'era
 * filtro sul campo, quindi un cliente vedeva — e l'interfaccia gli offriva di
 * modificare e cancellare — i campi custom di un altro), vocabolario con
 * `enumScopeClause` (A1-1/A-2/C-6).
 *
 * Scritture: solo sui campi DEL TENANT; un campo spedito è in sola lettura per
 * intero (etichetta, ordine e script compresi) e `updateITILType` su un tipo
 * spedito fallisce invece di essere un no-op silenzioso. I campi creati hanno
 * tenant_id del contesto. requireAdmin prima della sessione.
 *
 * **Rinegoziati nell'ondata 1** (pinnavano il comportamento difettoso):
 * - `updateITILType` «scrive SOLO con tenant_id = $tenantId (mai "system")»:
 *   era il no-op silenzioso sui 4 tipi spediti; adesso è un errore parlante. Il
 *   titolo diceva anche «un admin di tenant PUÒ modificare … un tipo ITIL
 *   condiviso» mentre l'asserzione pinnava il contrario: corretto.
 * - `updateITILField` «name/field_type/required … preservati (CASE WHEN
 *   f.is_system)»: le guardie coprivano solo quei tre e lasciavano scrivibili
 *   etichetta, ordine e i tre script sul nodo condiviso; adesso il campo
 *   spedito non si tocca affatto e i `CASE WHEN` non servono più.
 * - `deleteITILField` guardava `f.is_system`, non il proprietario: i campi
 *   custom di un altro cliente (is_system = false) erano cancellabili.
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
const ITIL_SCOPE  = "t.scope = 'itil' AND t.tenant_id IN [$tenantId, 'system']"
const FIELD_SCOPE = "f.tenant_id IN [$tenantId, 'system']"
const ENUM_SCOPE  = "WHERE enumDef.tenant_id IN [$tenantId, 'system']"
/** Riga di `assertFieldWritable` / `assertEnumTypeLinkable`. */
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })
const fieldRow = (over: Record<string, unknown> = {}) => ({ records: [rec({ name: 'origine', fieldTenantId: 'tenant-1', isSystem: false, ...over })] })
const enumRow  = (over: Record<string, unknown> = {}) => ({ records: [rec({ id: 'e-1', name: 'origine', tenantId: 'tenant-1', ...over })] })
/** Il primo `run` di ogni lettura è `loadTenantEnumOverrides` (nessuna personalizzazione). */
const noOverrides = { records: [] }
/** La CREATE di `createITILField` ritorna il campo nuovo (ondata 8 · D-17). */
const fieldCreated = { records: [rec({ f: { properties: { id: 'f-new' } } })] }

describe('letture ITIL — tenant + system', () => {
  beforeEach(() => reset())

  it('itilTypes: tipo + CAMPO + vocabolario tutti scopati al tenant; campi con enum risolto', async () => {
    reset([noOverrides])
    const out = await buildITILTypesResolver()(null, null, operator)
    const { cypher, params } = call(1)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE} AND t.active = true`)
    expect(cypher).toContain(`WHERE ${FIELD_SCOPE}`)     // A1-2: i campi di un altro cliente non compaiono
    expect(cypher).toContain(ENUM_SCOPE)                 // A1-1: né il suo vocabolario
    expect(params).toEqual({ tenantId: 'tenant-1' })
    expect(out[0]).toMatchObject({ id: 'it-1', name: 'incident' })
    expect(out[0]!.fields[0]).toMatchObject({ id: 'f-1', enumTypeId: 'e-1', enumTypeName: 'impact', enumValues: ['low', 'high'], isSystem: true })
  })

  it('itilTypeFields(typeId): stessi tre predicati, parametri typeId + tenantId', async () => {
    reset([noOverrides, { records: [] }])
    await expect(buildITILTypeFieldsResolver()(null, { typeId: 'it-1' }, operator)).resolves.toEqual([])
    const { cypher, params } = call(1)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain(`WHERE ${FIELD_SCOPE}`)
    expect(cypher).toContain(ENUM_SCOPE)
    expect(params).toEqual({ typeId: 'it-1', tenantId: 'tenant-1' })
  })

  it('fetchITILTypeById: stessi tre predicati; tipo di altro tenant → "ITIL type non trovato"', async () => {
    reset([noOverrides, { records: [] }])
    await expect(fetchITILTypeById('it-altrui', 'tenant-1')).rejects.toThrow('ITIL type non trovato')
    const { cypher, params } = call(1)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain(`WHERE ${FIELD_SCOPE}`)
    expect(cypher).toContain(ENUM_SCOPE)
    expect(params).toEqual({ id: 'it-altrui', tenantId: 'tenant-1' })
  })

  // A1-1: la precedenza è «vocabolario del tenant > agganciato di sistema >
  // enum_values inline». Il nucleo è lib/enumScope.ts; qui si pinna che il
  // resolver lo applica davvero prima di mappare.
  it('il vocabolario del tenant con lo stesso nome vince su quello agganciato', async () => {
    reset([
      { records: [rec({ id: 'own-1', name: 'impact', values: ['basso', 'alto'] })] },  // loadTenantEnumOverrides
      { records: [typeRecord()] },
    ])
    const out = await buildITILTypesResolver()(null, null, operator)
    expect(out[0]!.fields[0]).toMatchObject({ enumTypeId: 'own-1', enumValues: ['basso', 'alto'] })
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

  it('tipo del tenant: SET t += $updates solo dei campi passati; invalidateSchema del tenant', async () => {
    reset([
      { records: [rec({ name: 'incident', typeTenantId: 'tenant-1' })] },   // check
      { records: [] },                                                      // SET
      noOverrides, { records: [typeRecord()] },                             // fetchITILTypeById
    ])
    await mutations.updateITILType(null, { id: 'it-1', input: { label: 'Incidente', validationScript: null } }, admin)
    const { cypher, params } = call(1)
    expect(cypher).toContain("MATCH (t:CITypeDefinition {id: $id, tenant_id: $tenantId}) WHERE t.scope = 'itil' SET t += $updates")
    expect(params).toEqual({ id: 'it-1', tenantId: 'tenant-1', updates: { label: 'Incidente', validation_script: null } })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  // RINEGOZIATO (A1-2): prima il MATCH scopato al solo tenant non trovava i 4
  // tipi spediti, non scriveva niente e la mutation restituiva il tipo come se
  // avesse scritto. Adesso si ferma e lo dice.
  it('tipo spedito col prodotto → errore parlante, nessuna scrittura', async () => {
    reset([{ records: [rec({ name: 'incident', typeTenantId: 'system' })] }])
    await expect(mutations.updateITILType(null, { id: 'it-sys', input: { label: 'X' } }, admin))
      .rejects.toThrow(/Il tipo "incident" è spedito col prodotto/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('tipo inesistente o di un altro cliente → NOT_FOUND, nessuna scrittura', async () => {
    reset([{ records: [] }])
    const err = await mutations.updateITILType(null, { id: 'it-altrui', input: { label: 'X' } }, admin).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
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
    // Ondata 8 · D-17: la CREATE ritorna il campo creato — zero righe ora vuol
    // dire «il tipo ha già un campo con questo nome», non «riuscito».
    reset([enumRow(), fieldCreated, noOverrides, { records: [typeRecord()] }])
    await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'origine', label: 'Origine', fieldType: 'enum', enumTypeId: 'e-1', enumValues: ['a'] } }, admin)
    const { cypher, params } = call(1)
    expect(cypher).toContain('dup.name = $name')
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain("scope:             'itil'")
    expect(cypher).toContain('tenant_id:         $tenantId')
    expect(cypher).toContain('is_system:         false')
    expect(cypher).toContain("WHERE $enumTypeId IS NOT NULL AND e.tenant_id IN [$tenantId, 'system']")
    expect(params).toMatchObject({ typeId: 'it-1', tenantId: 'tenant-1', enumTypeId: 'e-1', enumValues: null, order: 99, required: false })
  })

  it('enum inline (senza enumTypeId, fieldType non enum) → enum_values serializzato, nessuna lettura del vocabolario', async () => {
    reset([fieldCreated, noOverrides, { records: [typeRecord()] }])
    await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'string', enumValues: ['a', 'b'] } }, admin)
    expect(call(0).params['enumValues']).toBe('["a","b"]')
  })

  // A1-1: il campo nuovo è DEL TENANT anche su un tipo condiviso, quindi il
  // vocabolario del tenant si può agganciare; quello di un altro cliente no.
  it('vocabolario di un altro cliente → rifiutato con il messaggio, nessuna CREATE', async () => {
    reset([enumRow({ name: 'severity', tenantId: 'tenant-altrui' })])
    await expect(mutations.createITILField(null, { typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'enum', enumTypeId: 'e-altrui' } }, admin))
      .rejects.toThrow(/appartiene a un altro cliente/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  // Ondata 8 · D-17: due campi omonimi sullo stesso tipo e `loadMetamodel` ne
  // scarta uno in silenzio (vince quello con `order` minore) mentre il
  // disegnatore ne mostra due. La chiave naturale è (tipo, nome) e passa per
  // HAS_FIELD: un vincolo di nodo non la esprime, la guardia sta nella CREATE.
  it('nome già presente sul tipo (la guardia morde, zero righe) → rifiuto esplicito, schema non invalidato', async () => {
    reset([enumRow(), { records: [] }])
    const err = await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'origine', label: 'Origine', fieldType: 'enum', enumTypeId: 'e-1' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err).not.toBeNull()
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('ha già un campo «origine»')
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('vocabolario inesistente → NOT_FOUND, nessuna CREATE', async () => {
    reset([{ records: [] }])
    const err = await mutations.createITILField(null, { typeId: 'it-1', input: { name: 'x', label: 'X', fieldType: 'enum', enumTypeId: 'e-ghost' } }, admin).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})

describe('updateITILField / deleteITILField — solo i campi del tenant (A1-2 / A-4)', () => {
  beforeEach(() => reset())

  // RINEGOZIATO: prima i `CASE WHEN f.is_system` coprivano solo
  // name/field_type/required e lasciavano scrivibili etichetta, ordine e i tre
  // script su un nodo condiviso da tutti i clienti (uno `visibility_script`
  // scritto da un cliente girava nel contesto degli altri). Adesso un campo
  // spedito non si modifica affatto, e il rifiuto lo dice.
  it('updateITILField su un campo spedito → errore che nomina etichetta/ordine/script, nessuna scrittura', async () => {
    reset([fieldRow({ name: 'impact', fieldTenantId: 'system', isSystem: true })])
    await expect(mutations.updateITILField(null, { typeId: 'it-1', fieldId: 'f-1', input: { name: 'hack', label: 'L', fieldType: 'string' } }, admin))
      .rejects.toThrow(/Il campo "impact" è spedito col prodotto.*nemmeno l'etichetta, l'ordine o gli script/s)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('updateITILField su un campo del tenant: SET senza CASE WHEN, MATCH vincolato a f.tenant_id', async () => {
    reset([fieldRow(), enumRow(), { records: [] }, noOverrides, { records: [typeRecord()] }])
    await mutations.updateITILField(null, { typeId: 'it-1', fieldId: 'f-2', input: { name: 'origine', label: 'L', fieldType: 'enum', enumTypeId: 'e-1', required: true } }, admin)
    const { cypher, params } = call(2)
    expect(cypher).toContain('MATCH (t:CITypeDefinition {id: $typeId})-[:HAS_FIELD]->(f:CIFieldDefinition {id: $fieldId, tenant_id: $tenantId})')
    expect(cypher).not.toContain('CASE WHEN f.is_system')
    expect(params).toMatchObject({ typeId: 'it-1', fieldId: 'f-2', tenantId: 'tenant-1', name: 'origine', enumTypeId: 'e-1' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('updateITILField: vocabolario di un altro cliente sul proprio campo → rifiutato, nessuna scrittura', async () => {
    reset([fieldRow(), enumRow({ tenantId: 'tenant-altrui' })])
    await expect(mutations.updateITILField(null, { typeId: 'it-1', fieldId: 'f-2', input: { name: 'origine', label: 'L', fieldType: 'enum', enumTypeId: 'e-altrui' } }, admin))
      .rejects.toThrow(/appartiene a un altro cliente/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  // RINEGOZIATO: la guardia era su `f.is_system`, e i campi custom creati da un
  // cliente hanno `is_system = false` → erano cancellabili da qualunque altro.
  it('deleteITILField: campo spedito → errore, nessuna DELETE', async () => {
    reset([fieldRow({ name: 'impact', fieldTenantId: 'system', isSystem: true })])
    await expect(mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-1' }, admin))
      .rejects.toThrow(/spedito col prodotto/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('deleteITILField: campo di un ALTRO cliente → "Campo non trovato", nessuna DELETE (non si conferma che esiste)', async () => {
    reset([fieldRow({ fieldTenantId: 'tenant-altrui' })])
    const err = await mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-altrui' }, admin).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).message).toBe('Campo non trovato')
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('deleteITILField: campo del tenant → DETACH DELETE vincolato a f.tenant_id, invalidateSchema', async () => {
    reset([fieldRow(), { records: [] }, noOverrides, { records: [typeRecord()] }])
    await mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-2' }, admin)
    const { cypher, params } = call(1)
    expect(cypher).toContain('DETACH DELETE f')
    expect(cypher).toContain('{id: $fieldId, tenant_id: $tenantId}')
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(params).toEqual({ typeId: 'it-1', fieldId: 'f-2', tenantId: 'tenant-1' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('deleteITILField: campo inesistente → "Campo non trovato" senza DELETE', async () => {
    reset([{ records: [] }])
    await expect(mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-ghost' }, admin)).rejects.toThrow('Campo non trovato')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('la lettura di controllo scopa sia il tipo sia il campo', async () => {
    reset([fieldRow(), { records: [] }, noOverrides, { records: [typeRecord()] }])
    await mutations.deleteITILField(null, { typeId: 'it-1', fieldId: 'f-2' }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain(`WHERE ${ITIL_SCOPE}`)
    expect(cypher).toContain(`AND ${FIELD_SCOPE}`)
    expect(params).toEqual({ typeId: 'it-1', fieldId: 'f-2', tenantId: 'tenant-1' })
  })
})
