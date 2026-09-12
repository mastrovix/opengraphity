/**
 * ciTypeMetamodel.ts — pin della Cypher del metamodello CMDB: le letture
 * includono i tipi base/sistema, le mutation sui tipi scrivono solo
 * `t.scope = 'tenant' AND t.tenant_id = $tenantId`; requireAdmin prima di
 * qualunque sessione; i tipi base non si eliminano.
 *
 * Ondata 1 «isolamento fra tenant» (A-5 / A-2): i campi si leggono solo se
 * spediti col prodotto (tenant `system`) o del tenant, i vocabolari agganciati
 * passano da `enumScopeClause` + le personalizzazioni del tenant, e le
 * mutation sui campi rifiutano i tipi spediti invece di riuscire a metà
 * (`addCIField`) o di non fare niente in silenzio (`removeCIField`).
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

const row = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

/**
 * Le query «di servizio» dell'ondata 1 (ambito del tipo, vocabolario da
 * agganciare, personalizzazioni del tenant) hanno una risposta di default
 * sensata, così i test che non le riguardano non devono accodarle. Le
 * risposte accodate con `reset([...])` vincono, nell'ordine.
 */
function defaultResponse(cypher: string): { records: unknown[] } {
  if (cypher.includes('MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})')) return { records: [] }   // nessuna personalizzazione
  if (cypher.includes('RETURN t.scope AS scope')) return { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] }
  if (cypher.includes('MATCH (e:EnumTypeDefinition {id: $enumTypeId})')) return { records: [row({ id: 'e-1', name: 'stato_rete', tenantId: 'tenant-1' })] }
  if (cypher.includes('DETACH DELETE f')) return { records: [row({ name: 'stato' })] }
  return { records: [typeRecord()] }
}

const txRun = vi.fn()
const queue: Array<{ records: unknown[] }> = []
function reset(responses: Array<{ records: unknown[] }> = []) {
  vi.clearAllMocks()
  queue.splice(0, queue.length, ...responses)
  txRun.mockImplementation(async (cypher: string) => queue.shift() ?? defaultResponse(cypher))
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

  // A-5: il filtro dei CAMPI non è più `f.scope = 'base' OR …` — un campo
  // `scope = 'base'` con il tenant_id di un cliente (quello che `addCIField`
  // scriveva sul `__base__` condiviso) passava quel filtro ed entrava nel
  // metamodello di TUTTI. Ora lo scope spedito vale solo sul tenant 'system'.
  const FIELD_CLAUSE = (v: string) =>
    `WHERE (${v}.scope IN ['base', 'itil'] AND ${v}.tenant_id = 'system') OR (${v}.scope = 'tenant' AND ${v}.tenant_id = $tenantId)`

  it('ciTypes: WHERE (t.scope = \'base\' OR (t.scope = \'tenant\' AND t.tenant_id = $tenantId)), campi filtrati per tenant (anche quelli di __base__)', async () => {
    reset([{ records: [typeRecord()] }])
    const out = await buildCITypesResolver()(null, null, operator)
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE (t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId))")
    expect(cypher).toContain(FIELD_CLAUSE('f'))
    expect(cypher).toContain(FIELD_CLAUSE('bf'))
    expect(params).toEqual({ tenantId: 'tenant-1' })
    expect(out).toEqual([expect.objectContaining({ id: 'ct-1', name: 'firewall', fields: [], relations: [], systemRelations: [] })])
  })

  it('ciTypes: i vocabolari agganciati passano da enumScopeClause, sul tipo e su __base__', async () => {
    reset([{ records: [typeRecord()] }])
    await buildCITypesResolver()(null, null, operator)
    const { cypher } = call(0)
    expect(cypher).toContain("WHERE fEnum.tenant_id IN [$tenantId, 'system']")
    expect(cypher).toContain("WHERE bfEnum.tenant_id IN [$tenantId, 'system']")
  })

  it('ciTypes: il vocabolario del tenant con lo stesso nome vince su quello agganciato', async () => {
    const fieldRow = (over: Record<string, unknown> = {}) => ({
      f: { properties: { id: 'f-1', name: 'severity', label: 'Severità', field_type: 'enum', order: 1, enum_values: ['inline'] } },
      enumId: 'sys-1', enumName: 'severity', enumValues: ['low', 'high'], ...over,
    })
    reset([
      { records: [{ get: (k: string) => ({ t: TYPE_NODE, typeFields: [fieldRow()], baseFields: [], relations: [], systemRels: [] })[k] }] },
      { records: [row({ id: 'own-1', name: 'severity', values: ['bassa', 'alta'] })] },   // personalizzazione del tenant
    ])
    const out = await buildCITypesResolver()(null, null, operator) as Array<{ fields: Array<Record<string, unknown>> }>
    expect(out[0]!.fields[0]).toMatchObject({ enumTypeId: 'own-1', enumValues: ['bassa', 'alta'] })
  })

  it('baseCIType: __base__ del tenant o di sistema (tenant prima), un solo nodo, campi e vocabolari scopati', async () => {
    await buildBaseCITypeResolver()(null, null, operator)
    const { cypher, params } = call(0)
    expect(cypher).toContain("MATCH (t:CITypeDefinition {name: '__base__'})")
    expect(cypher).toContain("WHERE t.tenant_id = $tenantId OR t.tenant_id = 'system'")
    expect(cypher).toContain('ORDER BY t.tenant_id DESC')
    expect(cypher).toContain('LIMIT 1')
    expect(cypher).toContain(FIELD_CLAUSE('f'))
    expect(cypher).toContain("WHERE enumDef.tenant_id IN [$tenantId, 'system']")
    expect(params).toEqual({ tenantId: 'tenant-1' })
  })

  it('fetchCITypeById: base o tenant; tipo di altro tenant → "CIType non trovato"', async () => {
    reset([{ records: [] }])
    await expect(fetchCITypeById('ct-altrui', 'tenant-1')).rejects.toThrow('CIType non trovato')
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE t.scope = 'base' OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)")
    expect(cypher).toContain(FIELD_CLAUSE('f'))
    expect(cypher).toContain("WHERE enumDef.tenant_id IN [$tenantId, 'system']")
    expect(params).toEqual({ id: 'ct-altrui', tenantId: 'tenant-1' })
  })

  it('fetchCITypeById: le personalizzazioni si leggono solo per il tenant che le possiede', async () => {
    reset([{ records: [typeRecord()] }])
    await fetchCITypeById('ct-1', 'tenant-1')
    expect(call(1).cypher).toContain('MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})')
    expect(call(1).params).toEqual({ tenantId: 'tenant-1' })
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

  // ── B0-1 (A-7): «Salva impostazioni» del tipo CI ──────────────────────────
  // Il web manda `chainFamilies` da sempre; finché l'input GraphQL non lo
  // dichiarava, Apollo rifiutava la richiesta e il tab non salvava NULLA.
  // Qui si pinna il lato server: il valore arriva, è validato e finisce in
  // `chain_families` come JSON canonico (la Cypher del calcolo confronta la
  // stringa per intero, quindi l'ordine conta).

  it('updateCIType: chainFamilies validate e scritte in chain_families come JSON canonico', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: ['Infrastructure', 'Application'] } }, admin)
    expect(call(0).params).toEqual({ id: 'ct-1', tenantId: 'tenant-1', updates: { chain_families: '["Application","Infrastructure"]' } })
  })

  it('updateCIType: una sola famiglia resta una sola famiglia (catena non ambigua)', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: ['Infrastructure'] } }, admin)
    expect((call(0).params['updates'] as Record<string, unknown>)['chain_families']).toBe('["Infrastructure"]')
  })

  it('updateCIType: nessuna famiglia = lista vuota scritta (non "campo non mandato")', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: [] } }, admin)
    expect((call(0).params['updates'] as Record<string, unknown>)['chain_families']).toBe('[]')
  })

  it('updateCIType: famiglia inventata → BAD_USER_INPUT che la nomina, nessuna scrittura', async () => {
    const err = await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: ['Rete'] } }, admin)
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('"Rete"')
    expect((err as GraphQLError).message).toContain('Application, Infrastructure')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('updateCIType: famiglia ripetuta → BAD_USER_INPUT, nessuna scrittura', async () => {
    await expectCode(mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: ['Application', 'Application'] } }, admin), 'BAD_USER_INPUT')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('createCIType: chainFamilies scritte alla creazione; senza famiglie il parametro è null (proprietà assente)', async () => {
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall', chainFamilies: ['Infrastructure'] } }, admin)
    expect(call(0).cypher).toContain('t.chain_families   = $chainFamilies')
    expect(call(0).params['chainFamilies']).toBe('["Infrastructure"]')

    reset()
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall' } }, admin)
    expect(call(0).params['chainFamilies']).toBeNull()
  })

  // `removeCIField` è fuori da questo elenco dall'ondata 1: prima della
  // scrittura legge l'ambito del tipo, quindi la sua prima Cypher non è più
  // quella della cancellazione (ha i suoi test qui sotto).
  it.each(['addCIRelation', 'removeCIRelation'] as const)('%s: WHERE t.scope = \'tenant\' AND t.tenant_id = $tenantId', async (name) => {
    await mutations[name](null, { typeId: 'ct-1', relationId: 'r-1', input: { name: 'n', label: 'l', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'out' } }, admin)
    const { cypher, params } = call(0)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).not.toContain("'system'")
    expect(params['tenantId']).toBe('tenant-1')
  })
})

// ── A-5: i campi non si aggiungono né si togliono ai tipi spediti ───────────
// `addCIField` su `__base__` scriveva un campo `scope: 'base'`, `is_system:
// true` col tenant_id di chi cliccava: entrava nel metamodello di OGNI
// cliente, quindi nella query dinamica di OGNI tipo, dove l'SDL non lo
// dichiara → `Cannot query field "<campo>" on type "<Tipo>"` per tutti. E
// `removeCIField` (che vuole `t.scope = 'tenant'`) non lo annullava: no-op
// silenzioso. Qui si pinna il rifiuto a voce alta, in entrambe le direzioni.

describe('campi sui tipi spediti col prodotto (A-5)', () => {
  const shipped = (name = '__base__') => ({ records: [row({ scope: 'base', name, label: name })] })

  it('addCIField su un tipo spedito → BAD_USER_INPUT che dice perché e cosa fare, nessuna scrittura', async () => {
    reset([shipped()])
    const err = await mutations.addCIField(null, { typeId: 'base-sys', input: { name: 'costo_annuo', label: 'Costo annuo', fieldType: 'string' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err).toBeInstanceOf(GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('__base__')
    expect(err!.message).toContain('spedito col prodotto')
    expect(err!.message).toMatch(/romperebbe la pagina di dettaglio di tutti i CI/)
    expect(err!.message).toMatch(/Crea un tuo tipo CI/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('addCIField: il tipo inesistente (o di un altro cliente) → CIType non trovato', async () => {
    reset([{ records: [] }])
    await expect(mutations.addCIField(null, { typeId: 'ct-altrui', input: { name: 'x', label: 'X', fieldType: 'string' } }, admin))
      .rejects.toThrow('CIType non trovato')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('removeCIField su un tipo spedito → errore invece del no-op silenzioso', async () => {
    reset([shipped('server')])
    const err = await mutations.removeCIField(null, { typeId: 'base-sys', fieldId: 'f-1' }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('server')
    expect(err!.message).toContain('togliere un campo da qui lo toglierebbe a ogni cliente')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('removeCIField sul proprio tipo: cancella solo un campo SUO e lo verifica', async () => {
    reset()
    await mutations.removeCIField(null, { typeId: 'ct-1', fieldId: 'f-1' }, admin)
    expect(call(0).cypher).toContain('RETURN t.scope AS scope')
    const { cypher, params } = call(1)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).toContain("AND f.scope = 'tenant' AND f.tenant_id = $tenantId")
    expect(cypher).toContain('DETACH DELETE f')
    expect(params).toEqual({ typeId: 'ct-1', fieldId: 'f-1', tenantId: 'tenant-1' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('removeCIField: niente cancellato (campo spedito o di un altro) → errore, non «fatto»', async () => {
    reset([
      { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] },
      { records: [] },
    ])
    const err = await mutations.removeCIField(null, { typeId: 'ct-1', fieldId: 'f-sistema' }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('f-sistema')
    expect(err!.message).toMatch(/in sola lettura/)
    expect(invalidateSchema).not.toHaveBeenCalled()
  })
})

describe('addCIField', () => {
  beforeEach(() => reset())

  it('fieldType enum senza enumTypeId → BAD_USER_INPUT senza sessione', async () => {
    await expectCode(mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum' } }, admin), 'BAD_USER_INPUT')
    expect(withSession).not.toHaveBeenCalled()
  })

  it('il campo è creato sul tipo del tenant, con scope tenant e is_system false', async () => {
    await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum', enumTypeId: 'e-1' } }, admin)
    // call(0) = ambito del tipo, call(1) = il vocabolario da agganciare
    const { cypher, params } = call(2)
    expect(cypher).toContain('CREATE (f:CIFieldDefinition {')
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).toContain('tenant_id:         $tenantId')
    expect(cypher).toContain("scope:             'tenant'")
    expect(cypher).toContain('is_system:         false')
    expect(cypher).not.toContain('__base__')
    expect(params).toMatchObject({ typeId: 'ct-1', tenantId: 'tenant-1', enumTypeId: 'e-1', fieldType: 'enum', required: false, order: 0 })
  })

  it('il vocabolario di un ALTRO cliente non si aggancia: errore che lo dice, nessuna scrittura', async () => {
    reset([
      { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] },
      { records: [row({ id: 'e-9', name: 'severity', tenantId: 'tenant-2' })] },
    ])
    const err = await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum', enumTypeId: 'e-9' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toMatch(/appartiene a un altro cliente/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('vocabolario inesistente → errore, non un campo enum senza valori', async () => {
    reset([
      { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] },
      { records: [] },
    ])
    await expect(mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum', enumTypeId: 'e-fantasma' } }, admin))
      .rejects.toThrow(/Il vocabolario e-fantasma non esiste/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('senza enum non si legge nessun vocabolario', async () => {
    reset()
    await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'note_interne', label: 'Note', fieldType: 'string' } }, admin)
    expect(txRun.mock.calls.some((c) => String(c[0]).includes('RETURN e.id AS id, e.name AS name, e.tenant_id AS tenantId'))).toBe(false)
  })
})
