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
 *
 * Ondata 5 «la personalizzazione dei CI diventa vera» (A-12 / A-6):
 * - `createCIType` e `addCIField` passano dalla PORTA sui nomi
 *   (`lib/metamodelNames.ts`), che legge prima l'elenco dei nomi già presi:
 *   per questo la Cypher della scrittura non è più la prima chiamata;
 * - `updateCIType`, `deleteCIType`, `addCIRelation` e `removeCIRelation`
 *   leggono l'ambito del tipo PRIMA di scrivere e verificano i contatori DOPO:
 *   «riuscito con zero righe» non esiste più.
 *
 * Rinegoziato in quest'ondata: il test che pinnava `invalidateSchema` dopo
 * `createCIType` resta, ma ora quell'azione ha un effetto (schema per tenant);
 * e `deleteCIType` su un tipo spedito dice «è spedito col prodotto» invece di
 * «I tipi base non possono essere eliminati» — lo stesso messaggio di tutte le
 * altre mutation, e vale anche per i tipi ITIL, che prima rispondevano `true`
 * senza eliminare niente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/schemaInvalidator.js', () => ({ invalidateSchema: vi.fn(), registerMetamodelCacheClearer: vi.fn() }))
// `@opengraphity/schema-generator` NON è più finto: la porta sui nomi (A-12)
// usa le sue regole vere, e finger `toPascalCase` con una versione che divide
// anche su spazi e trattini nasconderebbe esattamente il difetto che la regola
// `^[a-z][a-z0-9_]*$` esiste per impedire.

const { buildMetamodelMutations, buildCITypesResolver, buildBaseCITypeResolver, fetchCITypeById, requireAdmin } = await import('../ciTypeMetamodel.js')
const { withSession } = await import('../ci-utils.js')
const { invalidateSchema } = await import('../../../lib/schemaInvalidator.js')
const { runQueryOne } = await import('@opengraphity/neo4j')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, role: 'operator' }
const mutations = buildMetamodelMutations()

const TYPE_NODE = { properties: { id: 'ct-1', name: 'firewall', label: 'Firewall', icon: 'shield', color: '#000', active: true, scope: 'tenant', tenant_id: 'tenant-1' } }
const typeRecord = (over: Record<string, unknown> = {}) => ({
  get: (k: string) => ({ t: TYPE_NODE, fields: [], typeFields: [], baseFields: [], relations: [], systemRels: [], ...over })[k],
})

const row = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

/**
 * Contatori di scrittura, come li restituisce il driver
 * (`result.summary.counters.updates()`). Da quest'ondata le mutation del
 * metamodello li LEGGONO: «zero righe scritte» è un errore, non un successo.
 */
const WROTE   = { summary: { counters: { updates: () => ({ propertiesSet: 1, nodesCreated: 1, nodesDeleted: 1, relationshipsCreated: 1, relationshipsDeleted: 1 }) } } }
const WROTE_0 = { summary: { counters: { updates: () => ({ propertiesSet: 0, nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0 }) } } }
const res    = (records: unknown[] = []) => ({ records, ...WROTE })
const res0   = (records: unknown[] = []) => ({ records, ...WROTE_0 })

/**
 * Le query «di servizio» dell'ondata 1 (ambito del tipo, vocabolario da
 * agganciare, personalizzazioni del tenant) hanno una risposta di default
 * sensata, così i test che non le riguardano non devono accodarle. Le
 * risposte accodate con `reset([...])` vincono, nell'ordine.
 */
function defaultResponse(cypher: string): { records: unknown[] } {
  // Revisione delle otto ondate · A·3.7: il tipo di ARRIVO di una relazione
  // deve esistere (prima non era validato, e una relazione verso un tipo
  // inesistente entrava nel metamodello ed era inerte in silenzio).
  if (cypher.includes('RETURN collect(t.name) AS names')) {
    return res([row({ names: ['server', 'application', 'firewall', 'incident'] })])
  }
  if (cypher.includes('MATCH (e:EnumTypeDefinition {tenant_id: $tenantId})')) return res()   // nessuna personalizzazione
  if (cypher.includes('RETURN t.scope AS scope')) return res([row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })])
  if (cypher.includes('MATCH (e:EnumTypeDefinition {id: $enumTypeId})')) return res([row({ id: 'e-1', name: 'stato_rete', tenantId: 'tenant-1' })])
  if (cypher.includes('DETACH DELETE f')) return res([row({ name: 'stato' })])
  // Ondata 5: i nomi già presi (la porta, A-12) e i nomi di campo del tipo.
  if (cypher.includes("WHERE t.scope IN ['base', 'itil']")) return res(EXISTING_TYPE_ROWS)
  if (cypher.includes('collect(DISTINCT f.name) + collect(DISTINCT bf.name)')) return res([row({ names: ['os', 'name', 'status'] })])
  // Ondata 8 · D-17: la diagnosi del nome duplicato (solo nella via infelice di
  // `addCIRelation`); di default nessun omonimo.
  if (cypher.includes('HAS_RELATION]->(r:CIRelationDefinition {name: $name})')) return res()
  return res([typeRecord()])
}

/** I tipi CI già presenti nello schema, come li legge `loadExistingCITypeNames`. */
const EXISTING_TYPE_ROWS = [
  row({ name: 'server', scope: 'base' }),
  row({ name: 'application', scope: 'base' }),
  row({ name: '__base__', scope: 'base' }),
  row({ name: 'incident', scope: 'itil' }),
]

const txRun = vi.fn()
const queue: Array<{ records: unknown[] }> = []

/**
 * Ondata 6 · A-8/D-10: `deleteCIType` e la disattivazione contano prima i CI
 * del tipo e i riferimenti al suo nome (`lib/ciTypeUsage.ts`, che legge con
 * `runQueryOne`). `usage()` è quella riga: senza argomenti dice «non è usato»,
 * ed è lo stato in cui i test di scopatura vogliono trovarsi.
 */
function usage(over: Record<string, number> = {}): void {
  vi.mocked(runQueryOne).mockResolvedValue({
    cis: 0, itil_relation_rules: 0, assessment_questions: 0, dynamic_ci_groups: 0,
    field_visibility_rules: 0, field_requirement_rules: 0, business_rules: 0,
    auto_triggers: 0, custom_widgets: 0, report_nodes: 0, ...over,
  } as never)
}

function reset(responses: Array<{ records: unknown[] }> = []) {
  vi.clearAllMocks()
  usage()
  queue.splice(0, queue.length, ...responses)
  // La guardia sul tipo di arrivo di una relazione (revisione · A·3.7) legge i
  // tipi disponibili prima di scrivere. È infrastruttura per questi test, non
  // la cosa che misurano: risponde sempre il router, così la coda resta
  // allineata alle scritture e nessun test va riscritto per una lettura in più.
  txRun.mockImplementation(async (cypher: string) =>
    (cypher.includes('RETURN collect(t.name) AS names')
      ? defaultResponse(cypher)
      : queue.shift() ?? defaultResponse(cypher)))
  const tx = { run: txRun }
  mockSession.executeRead.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
  mockSession.executeWrite.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx))
}
const call = (i: number) => ({ cypher: txRun.mock.calls[i]![0] as string, params: txRun.mock.calls[i]![1] as Record<string, unknown> })
/**
 * La Cypher che contiene questo frammento, invece del suo indice: le guardie
 * aggiunte dalle ondate inseriscono letture PRIMA della scrittura, e un test
 * che pinna «la chiamata numero 1» si rompe a ogni guardia nuova senza che ci
 * sia niente di sbagliato.
 */
const callWith = (needle: string) => {
  const hit = txRun.mock.calls.find((c) => (c[0] as string).includes(needle))
  if (!hit) throw new Error(`nessuna Cypher contiene «${needle}»; eseguite: ${String(txRun.mock.calls.length)}`)
  return { cypher: hit[0] as string, params: hit[1] as Record<string, unknown> }
}

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
    // call(0) è la porta sui nomi (A-12): l'elenco dei nomi già presi.
    expect(call(0).cypher).toContain("WHERE t.scope IN ['base', 'itil'] OR (t.scope = 'tenant' AND t.tenant_id = $tenantId)")
    const { cypher, params } = call(1)
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
    // call(0) è la lettura dell'ambito del tipo (A-6).
    expect(call(0).cypher).toContain('RETURN t.scope AS scope')
    const { cypher, params } = call(1)
    expect(cypher).toContain("WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId")
    expect(cypher).toContain('SET t += $updates')
    expect(cypher).not.toContain("'system'")
    expect(params).toEqual({ id: 'ct-1', tenantId: 'tenant-1', updates: { label: 'FW', active: false } })
  })

  // Rinegoziato (A-6): il messaggio è quello di tutte le altre mutation sui
  // tipi spediti, e ora vale anche per i tipi ITIL — che prima rispondevano
  // `true` senza eliminare niente.
  it.each(['base', 'itil'])('deleteCIType: tipo %s → errore PRIMA di qualunque DELETE', async (scope) => {
    reset([{ records: [row({ scope, name: 'server', label: 'Server' })] }])
    const err = await mutations.deleteCIType(null, { id: 'ct-base' }, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('spedito col prodotto')
    expect(err!.message).toContain('sparirebbe dalla CMDB di ogni cliente')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('deleteCIType: tipo del tenant → DETACH DELETE con t.scope = \'tenant\' AND t.tenant_id = $tenantId', async () => {
    reset([{ records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] }, res()])
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
    expect(call(1).params).toEqual({ id: 'ct-1', tenantId: 'tenant-1', updates: { chain_families: '["Application","Infrastructure"]' } })
  })

  it('updateCIType: una sola famiglia resta una sola famiglia (catena non ambigua)', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: ['Infrastructure'] } }, admin)
    expect((call(1).params['updates'] as Record<string, unknown>)['chain_families']).toBe('["Infrastructure"]')
  })

  it('updateCIType: nessuna famiglia = lista vuota scritta (non "campo non mandato")', async () => {
    await mutations.updateCIType(null, { id: 'ct-1', input: { chainFamilies: [] } }, admin)
    expect((call(1).params['updates'] as Record<string, unknown>)['chain_families']).toBe('[]')
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
    expect(call(1).cypher).toContain('t.chain_families   = $chainFamilies')
    expect(call(1).params['chainFamilies']).toBe('["Infrastructure"]')

    reset()
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall' } }, admin)
    expect(call(1).params['chainFamilies']).toBeNull()
  })

  // `removeCIField` è fuori da questo elenco dall'ondata 1: prima della
  // scrittura legge l'ambito del tipo, quindi la sua prima Cypher non è più
  // quella della cancellazione (ha i suoi test qui sotto).
  it.each(['addCIRelation', 'removeCIRelation'] as const)('%s: WHERE t.scope = \'tenant\' AND t.tenant_id = $tenantId', async (name) => {
    // `direction: 'out'` era la fixture: un valore che il dato vivo non ha
    // (sono `outgoing`/`incoming`) e che ora la guardia dei VALORI rifiuta —
    // revisione delle otto ondate · A·3.7, una relazione con una direzione
    // inventata entrava nel metamodello ed era inerte in silenzio.
    await mutations[name](null, { typeId: 'ct-1', relationId: 'r-1', input: { name: 'n', label: 'l', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing' } }, admin)
    // call(0) è la lettura dell'ambito del tipo (A-6). Fra quella e la
    // scrittura ora c'è anche la guardia sul tipo di arrivo (A·3.7), quindi la
    // scrittura si cerca per contenuto e non per indice.
    expect(call(0).cypher).toContain('RETURN t.scope AS scope')
    const { cypher, params } = callWith('CIRelationDefinition')
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
    // call(0) = ambito del tipo, call(1) = i nomi di campo già presi (porta
    // A-12), call(2) = il vocabolario da agganciare
    expect(call(1).cypher).toContain('collect(DISTINCT f.name) + collect(DISTINCT bf.name)')
    const { cypher, params } = call(3)
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
      { records: [row({ names: ['os'] })] },
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
      { records: [row({ names: ['os'] })] },
      { records: [] },
    ])
    await expect(mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'stato', label: 'Stato', fieldType: 'enum', enumTypeId: 'e-fantasma' } }, admin))
      .rejects.toThrow(/Il vocabolario e-fantasma non esiste/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('senza enum non si legge nessun vocabolario', async () => {
    reset()
    await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'noteInterne', label: 'Note', fieldType: 'string' } }, admin)
    expect(txRun.mock.calls.some((c) => String(c[0]).includes('RETURN e.id AS id, e.name AS name, e.tenant_id AS tenantId'))).toBe(false)
  })
})

// ── A-12: la PORTA sui nomi ───────────────────────────────────────────────────
// La validazione dei nomi deve esistere PRIMA che lo schema per tenant faccia
// arrivare i tipi personalizzati all'API. Il caso da cui parte è il campo
// chiamato `tenantId`: `toSnakeCase` lo porta a `tenant_id`, non è fra i campi
// esclusi dagli input, e la scrittura del CI copia i campi del metamodello
// DOPO aver impostato il cliente proprietario — il CI nascerebbe nel cliente
// scelto da chi chiama l'API.
//
// E per i NOMI DI TIPO questa è l'unica difesa che esiste: due tipi GraphQL
// omonimi non fanno lanciare `makeExecutableSchema`, vengono fusi in silenzio
// (pinnato in `lib/__tests__/metamodelNames.test.ts`).

describe('createCIType — la porta sui nomi di tipo (A-12)', () => {
  beforeEach(() => reset())

  const create = (name: string) =>
    mutations.createCIType(null, { input: { name, label: 'Qualcosa' } }, admin)

  it.each(['server', 'application', 'incident'])('rifiuta «%s»: nome già preso, nessuna scrittura', async (name) => {
    const err = await create(name).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain(`«${name}»`)
    expect(err!.message).toContain('già preso')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it.each(['2fa_token', 'my-type', 'Load Balancer'])('rifiuta «%s»: non è un identificatore', async (name) => {
    const err = await create(name).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('^[a-z][a-z0-9_]*$')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('il rifiuto dice cosa scrivere invece', async () => {
    const err = await create('2fa_token').then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('«fa2_token»')
  })

  it('rifiuta un nome che il cliente ha già usato, dicendo che è suo', async () => {
    reset([{ records: [...EXISTING_TYPE_ROWS, row({ name: 'firewall', scope: 'tenant' })] }])
    const err = await create('firewall').then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('un tuo tipo CI')
  })

  it('un nome libero passa e la label resta quella scelta', async () => {
    await expect(create('load_balancer')).resolves.toMatchObject({ name: 'firewall' })
    expect(call(1).params).toMatchObject({ name: 'load_balancer', neo4jLabel: 'LoadBalancer' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })

  it('la porta legge anche i tipi ITIL: stanno nello stesso schema', async () => {
    await create('load_balancer')
    expect(call(0).cypher).toContain("t.scope IN ['base', 'itil']")
    expect(call(0).params).toEqual({ tenantId: 'tenant-1' })
  })
})

describe('addCIField — la porta sui nomi di campo (A-12)', () => {
  beforeEach(() => reset())

  const add = (name: string) =>
    mutations.addCIField(null, { typeId: 'ct-1', input: { name, label: 'Etichetta', fieldType: 'string' } }, admin)

  it('tenantId: rifiutato, e il messaggio dice che il CI nascerebbe in un altro cliente', async () => {
    const err = await add('tenantId').then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('tenant_id')
    expect(err!.message).toContain('il CI nascerebbe nel cliente scelto dal chiamante')
    expect(err!.message).toContain('Firewall')          // il tipo, per nome visualizzato
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it.each(['id', 'nameKey', 'healthSource', 'discoverySourceId'])('rifiuta «%s»: proprietà del prodotto', async (name) => {
    const err = await add(name).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it.each(['Centro di costo', 'cost_center', '2fa'])('rifiuta «%s»: non è camelCase', async (name) => {
    const err = await add(name).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('^[a-z][A-Za-z0-9]*$')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('rifiuta un campo già presente sul tipo (o eredidato da __base__)', async () => {
    // `os` è fra i campi che la lettura restituisce per questo tipo.
    const err = await add('os').then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('esiste già')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it.each(['name', 'status', 'description'])('rifiuta «%s»: è un campo base di ogni CI', async (name) => {
    const err = await add(name).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('esiste già su ogni CI')
  })

  it('un nome camelCase libero passa', async () => {
    await add('costCenter')
    expect(call(2).params).toMatchObject({ name: 'costCenter' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-1')
  })
})

// ── A-6: «Salvato» quando non è stato salvato niente ─────────────────────────
// `updateCIType`, `addCIRelation` e `removeCIRelation` hanno tutte
// `WHERE t.scope = 'tenant' AND t.tenant_id = $tenantId`: sui tipi spediti col
// prodotto eseguivano zero righe senza lanciare, e rispondevano con
// `fetchCITypeById`, che su quei tipi TROVA il nodo. Il disegnatore faceva il
// toast di successo su `onCompleted`, che scatta anche a zero righe.

describe('le mutation sui tipi non dicono più «fatto» a zero righe (A-6)', () => {
  const shippedType = (name = 'server') => ({ records: [row({ scope: 'base', name, label: name })] })

  it.each([
    ['updateCIType',     { id: 'ct-1', input: { label: 'X' } },                          'sola lettura'],
    ['addCIRelation',    { typeId: 'ct-1', input: { name: 'n', label: 'l', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing' } }, 'in sola lettura'],
    ['removeCIRelation', { typeId: 'ct-1', relationId: 'r-1' },                          'in sola lettura'],
  ] as const)('%s su un tipo spedito → errore prima di scrivere', async (name, args) => {
    reset([shippedType()])
    const fn = mutations[name] as (p: unknown, a: unknown, c: GraphQLContext) => Promise<unknown>
    const err = await fn(null, args, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('spedito col prodotto')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it.each([
    ['updateCIType',     { id: 'ct-1', input: { label: 'X' } }],
    ['addCIRelation',    { typeId: 'ct-1', input: { name: 'n', label: 'l', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing' } }],
    ['removeCIRelation', { typeId: 'ct-1', relationId: 'r-1' }],
    ['deleteCIType',     { id: 'ct-1' }],
  ] as const)('%s con contatori a zero → errore, non «salvato»', async (name, args) => {
    reset([
      { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] },
      res0(),
    ])
    const fn = mutations[name] as (p: unknown, a: unknown, c: GraphQLContext) => Promise<unknown>
    const err = await fn(null, args, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err, `${name} ha risposto «fatto» con zero scritture`).not.toBeNull()
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('non è stato scritto niente')
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('updateCIType senza nessun campo da modificare lo dice, invece di accusare il tipo', async () => {
    reset()
    const err = await mutations.updateCIType(null, { id: 'ct-1', input: {} }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('nessun campo da modificare')
    expect(withSession).not.toHaveBeenCalled()
  })

  it('se il driver non dà i contatori si lancia: «avrà scritto» sarebbe il fallback di prima', async () => {
    reset([
      { records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] },
      { records: [] },   // nessun summary
    ])
    await expect(mutations.updateCIType(null, { id: 'ct-1', input: { label: 'X' } }, admin))
      .rejects.toThrow(/non ha restituito i contatori/)
  })
})

// ── A-6: DI CHI è il tipo ────────────────────────────────────────────────────

describe('scope e tenantId sono esposti (A-6)', () => {
  beforeEach(() => reset())

  it('ciTypes li restituisce: senza questi il disegnatore non sa quali azioni hanno effetto', async () => {
    const out = await buildCITypesResolver()(null, null, admin) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ scope: 'tenant', tenantId: 'tenant-1' })
  })

  it('fetchCITypeById li restituisce', async () => {
    await expect(fetchCITypeById('ct-1', 'tenant-1')).resolves.toMatchObject({ scope: 'tenant', tenantId: 'tenant-1' })
  })

  it('un tipo spedito col prodotto si riconosce da scope/tenantId', async () => {
    const shipped = { properties: { id: 'ct-b', name: 'server', label: 'Server', scope: 'base', tenant_id: 'system', active: true } }
    reset([{ records: [{ get: (k: string) => ({ t: shipped, fields: [], relations: [], systemRels: [] })[k] }] }])
    await expect(fetchCITypeById('ct-b', 'tenant-1')).resolves.toMatchObject({ scope: 'base', tenantId: 'system' })
  })
})

// ── Ondata 6 · A-8 / D-10: un tipo in uso non si cancella né si disattiva ────
// Prima `deleteCIType` faceva `DETACH DELETE` senza contare niente e
// `active = false` aveva lo stesso effetto sulle letture: i CI restavano nel
// grafo, con le loro relazioni, e non comparivano più da nessuna parte.

describe('il tipo in uso non si cancella (A-8 / D-10)', () => {
  const tenantType = () => ({ records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] })

  it('deleteCIType con CI di quel tipo → si ferma col NUMERO, e non scrive niente', async () => {
    reset([tenantType()])
    usage({ cis: 12 })
    const err = await mutations.deleteCIType(null, { id: 'ct-1' }, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('12 CI di tipo Firewall')
    expect(err!.message).toContain('non è stato eliminato')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('il messaggio elenca anche chi cita il tipo per nome (regole, gruppi, widget, report)', async () => {
    reset([tenantType()])
    usage({ cis: 3, itil_relation_rules: 2, dynamic_ci_groups: 1, report_nodes: 4 })
    const err = await mutations.deleteCIType(null, { id: 'ct-1' }, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('2 regole di relazione ITIL')
    expect(err!.message).toContain('1 gruppi dinamici')
    expect(err!.message).toContain('4 nodi dei template di report')
  })

  it('nessun CI ma riferimenti appesi → si ferma comunque, dicendo quali', async () => {
    reset([tenantType()])
    usage({ custom_widgets: 1, assessment_questions: 5 })
    const err = await mutations.deleteCIType(null, { id: 'ct-1' }, admin).then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('nessun CI di questo tipo')
    expect(err!.message).toContain('1 widget della dashboard')
    expect(err!.message).toContain('5 domande di assessment')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('disattivare è come cancellare, per chi legge: `active: false` con CI → rifiutato', async () => {
    reset([tenantType()])
    usage({ cis: 7 })
    const err = await mutations.updateCIType(null, { id: 'ct-1', input: { active: false } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.message).toContain('non è stato disattivato')
    expect(err!.message).toContain('7 CI di tipo Firewall')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('riattivare (o cambiare etichetta) non conta nessun CI: la guardia è solo sulla disattivazione', async () => {
    reset([tenantType(), res()])
    usage({ cis: 7 })
    await expect(mutations.updateCIType(null, { id: 'ct-1', input: { active: true, label: 'FW' } }, admin)).resolves.toBeTruthy()
    expect(mockSession.executeWrite).toHaveBeenCalled()
  })
})

// ── Ondata 6 · A-10: il ruolo nella mappa del servizio è del TIPO ────────────

describe('serviceRole (A-10)', () => {
  it('createCIType lo scrive; omesso, lo propone dalle famiglie di catena', async () => {
    reset()
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall', chainFamilies: ['Application'] } }, admin)
    expect(call(1).cypher).toContain('t.service_role     = $serviceRole')
    expect(call(1).params['serviceRole']).toBe('component')

    reset()
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall' } }, admin)
    expect(call(1).params['serviceRole']).toBe('infrastructure')

    reset()
    await mutations.createCIType(null, { input: { name: 'firewall', label: 'Firewall', serviceRole: 'certificate' } }, admin)
    expect(call(1).params['serviceRole']).toBe('certificate')
  })

  it('updateCIType lo scrive, e `null` lo rimette in mano al prodotto', async () => {
    reset([{ records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] }, res()])
    await mutations.updateCIType(null, { id: 'ct-1', input: { serviceRole: 'component' } }, admin)
    expect((call(1).params['updates'] as Record<string, unknown>)['service_role']).toBe('component')

    reset([{ records: [row({ scope: 'tenant', name: 'firewall', label: 'Firewall' })] }, res()])
    await mutations.updateCIType(null, { id: 'ct-1', input: { serviceRole: null } }, admin)
    expect((call(1).params['updates'] as Record<string, unknown>)['service_role']).toBeNull()
  })

  it('un ruolo inventato → BAD_USER_INPUT che lo nomina, nessuna scrittura; `entry` non si dichiara', async () => {
    reset()
    for (const bad of ['entry', 'rete', '']) {
      const err = await mutations.updateCIType(null, { id: 'ct-1', input: { serviceRole: bad } }, admin)
        .then(() => null, (e: unknown) => e as GraphQLError)
      expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
      expect(err!.message).toContain('component, infrastructure, certificate')
    }
    expect(txRun).not.toHaveBeenCalled()
  })

  it('ciTypes e fetchCITypeById lo espongono', async () => {
    reset()
    const out = await buildCITypesResolver()(null, null, admin) as Array<Record<string, unknown>>
    expect(out[0]).toHaveProperty('serviceRole')
    await expect(fetchCITypeById('ct-1', 'tenant-1')).resolves.toHaveProperty('serviceRole')
  })
})

// ── Ondata 6 · C-3: il tipo di relazione è validato ─────────────────────────

describe('addCIRelation valida il tipo di relazione (C-3)', () => {
  const relInput = (relationshipType: unknown) => ({
    typeId: 'ct-1',
    input: { name: 'bilancia', label: 'Bilancia', relationshipType, targetType: 'application', cardinality: 'many', direction: 'outgoing' },
  })

  it('un identificatore valido passa, e la definizione nasce CON un proprietario', async () => {
    reset([{ records: [row({ scope: 'tenant', name: 'load_balancer', label: 'Bilanciatore' })] }, res()])
    await mutations.addCIRelation(null, relInput('BILANCIA'), admin)
    // Per contenuto e non per indice: fra la lettura dell'ambito e la
    // scrittura c'è ora anche la guardia sul tipo di arrivo (A·3.7).
    const created = callWith('CREATE (r:CIRelationDefinition')
    expect(created.params['relationshipType']).toBe('BILANCIA')
    expect(created.cypher).toContain('tenant_id:         $tenantId')
    expect(created.cypher).toContain("scope:             'tenant'")
  })

  it.each(['bilancia', 'BILANCIA UNO', 'BILANCIA-1', '', 'Bilancia', 42, null])('%s → rifiutato prima di scrivere', async (bad) => {
    reset([{ records: [row({ scope: 'tenant', name: 'load_balancer', label: 'Bilanciatore' })] }])
    await expect(mutations.addCIRelation(null, relInput(bad), admin)).rejects.toThrow(/non è un tipo di relazione valido/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })
})

// ── Ondata 8 · D-17: campi e relazioni di un tipo hanno nomi unici ──────────
// La chiave naturale di un campo e di una relazione è (tipo, nome) e passa per
// `HAS_FIELD`/`HAS_RELATION`: un vincolo di NODO non la esprime (`status`
// esiste su quasi ogni tipo), quindi l'unicità è applicata dalla mutation. Il
// controllo stava in una transazione e la scrittura in un'altra: due «Salva»
// ravvicinati passavano entrambi, e `loadMetamodel` scartava poi uno dei due
// campi in silenzio mentre il disegnatore continuava a mostrarne due.

describe('nomi unici nel metamodello di un tipo (D-17)', () => {
  it('addCIField: la CREATE porta la guardia sul nome, nello stesso pattern', async () => {
    reset()
    await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'costCenter', label: 'Centro di costo', fieldType: 'string' } }, admin)
    const write = txRun.mock.calls.map(c => c[0] as string).find(c => c.includes('CREATE (f:CIFieldDefinition'))!
    expect(write).toContain('AND NOT EXISTS { (t)-[:HAS_FIELD]->(:CIFieldDefinition {name: $name}) }')
  })

  it('addCIField: guardia scattata (zero righe) → rifiuto esplicito, e lo schema NON viene invalidato', async () => {
    // solo la CREATE torna a vuoto: le letture di servizio restano quelle di default
    reset()
    txRun.mockImplementation(async (cypher: string) =>
      cypher.includes('CREATE (f:CIFieldDefinition') ? res0() : defaultResponse(cypher))
    const err = await mutations.addCIField(null, { typeId: 'ct-1', input: { name: 'costCenter', label: 'X', fieldType: 'string' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err).not.toBeNull()
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('ha già un campo «costCenter»')
    expect(invalidateSchema).not.toHaveBeenCalled()
  })

  it('addCIRelation: la CREATE porta la guardia, e a zero righe la diagnosi nomina il duplicato', async () => {
    reset()
    await mutations.addCIRelation(null, { typeId: 'ct-1', input: { name: 'bilancia', label: 'B', relationshipType: 'BILANCIA', targetType: 'application', cardinality: 'many', direction: 'outgoing' } }, admin)
    const write = txRun.mock.calls.map(c => c[0] as string).find(c => c.includes('CREATE (r:CIRelationDefinition'))!
    expect(write).toContain('AND NOT EXISTS { (t)-[:HAS_RELATION]->(:CIRelationDefinition {name: $name}) }')

    reset()
    txRun.mockImplementation(async (cypher: string) =>
      cypher.includes('CREATE (r:CIRelationDefinition') ? res0()
      : cypher.includes('HAS_RELATION]->(r:CIRelationDefinition {name: $name})') ? res([row({ id: 'r-esistente' })])
      : defaultResponse(cypher))
    const err = await mutations.addCIRelation(null, { typeId: 'ct-1', input: { name: 'bilancia', label: 'B', relationshipType: 'BILANCIA', targetType: 'application', cardinality: 'many', direction: 'outgoing' } }, admin)
      .then(() => null, (e: unknown) => e as GraphQLError)
    expect(err!.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err!.message).toContain('ha già una relazione «bilancia»')
    expect(invalidateSchema).not.toHaveBeenCalled()
  })
})
