/**
 * Lo schema GraphQL per tenant (ondata 5, A-1: il perno del programma).
 *
 * Prima c'era UNO schema, costruito all'avvio per il tenant `'system'`: i tipi
 * creati dal disegnatore non arrivavano mai all'API. Qui si pinna il
 * comportamento nuovo:
 *  - ogni tenant ha il suo schema, e due tenant non si vedono i tipi;
 *  - la cache è limitata e sfratta il meno usato di recente;
 *  - se lo schema di un tenant NON si assembla (un tipo che collide) si serve
 *    lo schema SICURO — senza i tipi del cliente — così l'amministratore può
 *    ancora cancellare il tipo che rompe, e la cosa si vede (contatore + stato
 *    `degraded`, non un silenzio);
 *  - invalidare fa rigenerare, e il log non afferma più il falso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

const loadMetamodel   = vi.fn()
const loadITILTypes   = vi.fn()
const registerCITypes = vi.fn()

vi.mock('@opengraphity/schema-generator', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/schema-generator')>()
  return { ...orig, loadMetamodel, loadITILTypes }
})
vi.mock('../ciTypeFromLabels.js', () => ({ registerCITypes }))
vi.mock('../../graphql/resolvers/index.js', () => ({ buildResolvers: () => ({}) }))

const { getSchemaForTenant, getSchemaState, regenerateSchema } = await import('../schemaCache.js')
const { invalidateSchema } = await import('../schemaInvalidator.js')

/** Un tipo CI nella forma esatta di `CITypeWithDefinitions`. */
function ciType(name: string, scope: 'base' | 'tenant' = 'tenant'): CITypeWithDefinitions {
  const pascal = name.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return {
    id: `t-${name}`, name, label: name, icon: 'box', color: 'var(--color-brand)',
    scope, tenantId: scope === 'tenant' ? 'c-one' : 'system', active: true,
    neo4jLabel: pascal, validationScript: null, chainFamilies: [],
    fields: [{
      id: `f-${name}`, name: 'etichetta', label: 'Etichetta', fieldType: 'string',
      required: false, defaultValue: null, enumValues: [], order: 1,
      scope, tenantId: scope === 'tenant' ? 'c-one' : 'system',
      validationScript: null, visibilityScript: null, defaultScript: null, isSystem: false,
    }],
    relations: [], systemRelations: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  loadITILTypes.mockResolvedValue([])
  loadMetamodel.mockImplementation(async (tenantId: string) =>
    tenantId === 'c-one' ? [ciType('sede')] : tenantId === 'c-two' ? [ciType('filiale')] : [])
  invalidateSchema('c-one'); invalidateSchema('c-two'); invalidateSchema('system')
})

describe('uno schema per tenant', () => {
  it('i tipi di un tenant stanno nel SUO schema e non in quello di un altro', async () => {
    const one = await getSchemaForTenant('c-one')
    const two = await getSchemaForTenant('c-two')
    expect(one.getType('Sede')).toBeDefined()
    expect(one.getType('Filiale')).toBeUndefined()
    expect(two.getType('Filiale')).toBeDefined()
    expect(two.getType('Sede')).toBeUndefined()
    expect(Object.is(one, two)).toBe(false)
  })

  it('la seconda richiesta riusa lo stesso oggetto (nessuna rigenerazione)', async () => {
    const a = await getSchemaForTenant('c-one')
    const b = await getSchemaForTenant('c-one')
    expect(Object.is(b, a)).toBe(true)
    expect(loadMetamodel).toHaveBeenCalledTimes(1)
  })

  it('due richieste insieme per un tenant nuovo generano UN solo schema', async () => {
    const [a, b] = await Promise.all([getSchemaForTenant('c-one'), getSchemaForTenant('c-one')])
    expect(Object.is(a, b)).toBe(true)
    expect(loadMetamodel).toHaveBeenCalledTimes(1)
  })

  it('invalidare fa rigenerare, e l\'oggetto è nuovo', async () => {
    const a = await getSchemaForTenant('c-one')
    invalidateSchema('c-one')
    const b = await getSchemaForTenant('c-one')
    expect(Object.is(b, a)).toBe(false)
    expect(loadMetamodel).toHaveBeenCalledTimes(2)
  })

  it('regenerateSchema ricostruisce anche senza invalidare', async () => {
    const a = await getSchemaForTenant('c-one')
    expect(Object.is(await regenerateSchema('c-one'), a)).toBe(false)
  })
})

describe('lo schema sicuro quando quello del tenant non si assembla', () => {
  it('un nome che non è un identificatore GraphQL → schema sicuro, stato degradato, e lo schema resta interrogabile', async () => {
    // `2fa` produce `type 2fa`, che non è un nome GraphQL valido: qui
    // `makeExecutableSchema` lancia davvero. Senza rete questo tenant
    // resterebbe senza API **e senza la mutation per rimediare**, che vive
    // nello stesso schema. Con la rete: schema base + ITIL, e l'amministratore
    // può cancellare il tipo.
    loadMetamodel.mockResolvedValue([ciType('2fa'), ciType('sede')])
    const state = await getSchemaState('c-one')
    expect(state.degraded).toBe(true)
    // Il motivo NOMINA il tipo colpevole e dice cosa fare: il generatore
    // valida i nomi prima di interpolarli (A5-1), quindi qui non arriva più un
    // errore di sintassi GraphQL crudo che non dice di chi è la colpa.
    expect(state.reason).toMatch(/«2fa»/)
    expect(state.reason).toMatch(/eliminalo o rinominalo/i)
    expect(state.schema.getType('Sede')).toBeUndefined()   // nessun tipo del cliente
    expect(state.schema.getQueryType()).toBeDefined()      // ma l'API risponde
    expect(state.schema.getType('Incident')).toBeDefined() // e il prodotto è tutto lì
  })

  /**
   * CORREZIONE alla diagnosi del rapporto A-12, verificata direttamente su
   * @graphql-tools/schema: un tipo con il NOME che collide **non** fa lanciare
   * l'assemblaggio — viene MERGE, in silenzio. Un tipo CI chiamato `incident`
   * inietta i suoi campi nel tipo `Incident` del prodotto.
   *
   * Quindi la rete dello schema sicuro NON copre questo caso: l'unica difesa è
   * la validazione dei nomi in SCRITTURA. Questo test esiste per impedire che
   * qualcuno la consideri ridondante «perché tanto lo schema se ne accorge».
   */
  it('un tipo con lo stesso nome di uno base NON fa fallire l\'assemblaggio: viene fuso in silenzio (per questo la validazione in scrittura è obbligatoria)', async () => {
    loadMetamodel.mockResolvedValue([ciType('incident')])
    const state = await getSchemaState('c-two')
    expect(state.degraded).toBe(false)
    const incident = state.schema.getType('Incident') as { getFields(): Record<string, unknown> }
    // i campi del prodotto e quello del cliente convivono nello stesso tipo
    expect(Object.keys(incident.getFields())).toContain('etichetta')
  })

  it('con i tipi spediti la costruzione riesce e lo stato non è degradato', async () => {
    loadMetamodel.mockResolvedValue([ciType('server', 'base')])
    const state = await getSchemaState('c-two')
    expect(state.degraded).toBe(false)
    expect(state.reason).toBeNull()
  })
})

describe('la cache è limitata', () => {
  it('oltre il limite sfratta il meno usato di recente e lo ricostruisce alla richiesta dopo', async () => {
    const { config } = await import('../config.js')
    const max = config.graphqlSchemaCacheMax
    loadMetamodel.mockImplementation(async (tenantId: string) => [ciType(`tipo_${String(tenantId).replace(/[^a-z0-9]/gi, '_')}`)])

    for (let i = 0; i < max + 2; i++) await getSchemaForTenant(`t-${i}`)
    const builds = loadMetamodel.mock.calls.length
    // il primo tenant è stato sfrattato: richiederlo genera una costruzione in più
    await getSchemaForTenant('t-0')
    expect(loadMetamodel.mock.calls.length).toBe(builds + 1)
    // l'ultimo invece è ancora in cache
    const last = await getSchemaForTenant(`t-${max + 1}`)
    expect(Object.is(await getSchemaForTenant(`t-${max + 1}`), last)).toBe(true)
  })
})
