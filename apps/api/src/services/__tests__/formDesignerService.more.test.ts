/**
 * The AI form designer (services/formDesignerService.ts): the parts that
 * formDesignerService.test.ts does not reach — adding fields to an EXISTING
 * catalog item, the names the model must not propose, and a vocabulary that
 * cannot be read.
 *
 * Why these behaviours matter:
 *  - adding to an existing item must read that item INSIDE the tenant and tell
 *    the model which fields are already there; an item of another tenant must
 *    be "not found", never designed on;
 *  - a new field named like a built-in column of ServiceRequest (created_at,
 *    status…) would shadow it; those names must reach the proposal filter;
 *  - a vocabulary that fails to load removes that option from the proposal
 *    instead of failing the whole design;
 *  - the workflows offered to the model are the tenant's own, by name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError, buildSchema } from 'graphql'

const CONFIG_WITH_SHAPE: Record<string, unknown> = {
  anthropicModel: 'fake-model',
  keycloakPublicUrls: ['http://kc.localhost'],
  keycloakAppClientIds: ['opengrafo-web'],
  keycloakUrl: 'http://kc:8080',
}
vi.mock('../../lib/config.js', () => ({
  config: new Proxy({}, {
    get: (_t, key: string) => (key in CONFIG_WITH_SHAPE ? CONFIG_WITH_SHAPE[key] : `fake-${key}`),
    has: () => true,
  }),
}))
const logError = vi.fn()
const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a), debug: noop, child: () => l }
  return { logger: l }
})
vi.mock('../../lib/aiSettings.js', () => ({ assertAIFeature: vi.fn(async () => undefined) }))

const messagesCreate = vi.fn()
vi.mock('../../lib/aiClient.js', () => ({
  getAnthropic: () => ({ messages: { create: messagesCreate } }),
  leggiJSONDalModello: vi.fn(() => ({})),
  bloccoDiContesto: vi.fn((c: unknown) => ({ type: 'text', text: JSON.stringify(c) })),
  registraChiamataFallita: vi.fn(),
  registraDurata: vi.fn(),
  registraScarti: vi.fn(),
}))

const runQuery = vi.fn()
// A full mock, not a partial one: the real module opens a driver on import.
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: vi.fn(async () => null),
}))

const assertCatalogForm = vi.fn()
vi.mock('../../lib/catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalogForm.js')>()),
  formFields: vi.fn(async () => [{ name: 'plate', fieldType: 'text', label: 'Plate', formula: '  ' }]),
  assertCatalogForm: (...a: unknown[]) => assertCatalogForm(...a),
}))
vi.mock('../../lib/catalogFormLimits.js', () => ({
  catalogFormLimits: vi.fn(async () => ({ maxLibraryFields: 50, maxFieldsPerForm: 20, maxTableRows: 10 })),
}))
vi.mock('../../lib/scriptingPlan.js', () => ({ getScriptingPlan: vi.fn(async () => ({ plan: 'pro', enabled: false })) }))

const loadVocabularyEntries = vi.fn()
vi.mock('../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: (...a: unknown[]) => loadVocabularyEntries(...a) }))
vi.mock('../../lib/systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'English') }))

// The tenant's GraphQL schema: ServiceRequest has camelCase fields that are
// stored as snake_case properties.
const getSchemaForTenant = vi.fn()
vi.mock('../../lib/schemaCache.js', () => ({ getSchemaForTenant: (...a: unknown[]) => getSchemaForTenant(...a) }))

const validaProposta = vi.fn()
vi.mock('../../lib/formDesignProposal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/formDesignProposal.js')>()),
  validaProposta: (...a: unknown[]) => validaProposta(...a),
}))

const { proponiModulo } = await import('../formDesignerService.js')

const PROPOSAL = {
  voce: null, sezioni: [{ id: 'extra', titleIt: 'Extra', titleEn: 'Extra', columns: 1, items: [] }],
  campiNuovi: [], vocabolariNuovi: [], scartati: [], note: [],
}
const EXISTING_FORM = {
  version: 1, revision: 3,
  sections: [{ id: 'main', title: { it: 'Dati', en: 'Data' }, items: [{ field: 'plate' }] }],
}

/** Routes the catalog reads by query text. */
function catalog(opts: { item?: { name: string; form: unknown } | null } = {}) {
  runQuery.mockImplementation(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    if (cypher.includes('ServiceCatalogItem')) {
      // Tenant scoping: the item is only found inside the requesting tenant.
      return opts.item && params['tenantId'] === 't1' ? [opts.item] : []
    }
    if (cypher.includes('WorkflowDefinition')) return [{ id: 'wf-1', name: 'Laptop Fulfilment' }]
    if (cypher.includes('CITypeDefinition')) return [{ name: 'Server' }]
    if (cypher.includes('EnumTypeDefinition')) return [{ name: 'colour', values: 'not-a-list', owner: 't1' }]
    return []
  })
}

const ask = (over: Record<string, unknown> = {}) =>
  proponiModulo({ tenantId: 't1', prompt: 'add a docking station question', itemId: 'item-1', consentiNuovi: true, ...over } as never)

const contextSentToModel = (): Record<string, unknown> => {
  const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }> }
  return JSON.parse(arg.system.at(-1)!.text) as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  messagesCreate.mockResolvedValue({ content: [] })
  loadVocabularyEntries.mockResolvedValue({ values: ['low', 'high'], labels: {} })
  getSchemaForTenant.mockResolvedValue(buildSchema('type ServiceRequest { id: ID, createdAt: String, dockingStation: String } type Query { a: Int }'))
  validaProposta.mockReturnValue(PROPOSAL)
  assertCatalogForm.mockReturnValue(undefined)
})

describe('adding fields to an existing catalog item', () => {
  it('tells the model the item, the fields and sections already there, and the room left', async () => {
    catalog({ item: { name: 'Laptop', form: JSON.stringify(EXISTING_FORM) } })
    const out = await ask()
    const ctx = contextSentToModel()
    expect(ctx['sto_aggiungendo_a']).toBe('Laptop')
    expect(ctx['modulo_esistente']).toEqual({ campi_gia_presenti: ['plate'], sezioni: [{ titolo: { it: 'Dati', en: 'Data' }, campi: ['plate'] }] })
    expect(ctx['campi_ancora_disponibili']).toBe(19)
    expect(ctx['workflow_disponibili']).toEqual(['Laptop Fulfilment'])
    expect(ctx['tipi_di_ci']).toEqual(['Server'])
    expect(ctx['script_del_cliente_accesi']).toBe(false)
    // A vocabulary whose stored values are not a list is offered with no values.
    expect(ctx['vocabolari']).toEqual([{ nome: 'colour', valori: [] }])
    expect(out.maxFieldsPerForm).toBe(20)

    // The proposal filter gets the existing section ids, so a new section cannot collide.
    const cat = validaProposta.mock.calls[0]![1] as { idSezioniEsistenti: string[]; workflowPerNome: Map<string, unknown>; campiLibreria: Map<string, { haFormula: boolean }> }
    expect(cat.idSezioniEsistenti).toEqual(['main'])
    expect(cat.workflowPerNome.get('laptop fulfilment')).toEqual({ id: 'wf-1', name: 'Laptop Fulfilment' })
    // A blank formula is not a formula.
    expect(cat.campiLibreria.get('plate')!.haFormula).toBe(false)

    // The saveability check sees the existing sections followed by the proposed one.
    const def = assertCatalogForm.mock.calls[0]![0] as { revision: number; sections: Array<{ id: string }> }
    expect(def.revision).toBe(3)
    expect(def.sections.map((s) => s.id)).toEqual(['main', 'extra'])
  })

  it('an item of another tenant (or a missing one) is NOT_FOUND and the model is never called', async () => {
    catalog({ item: { name: 'Laptop', form: null } })
    const err = await proponiModulo({ tenantId: 't2', prompt: 'x', itemId: 'item-1', consentiNuovi: true }).catch((e: unknown) => e) as GraphQLError
    expect(err.extensions['code']).toBe('NOT_FOUND')
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('an item with no form yet is designed from scratch', async () => {
    catalog({ item: { name: 'Laptop', form: null } })
    await ask()
    expect(contextSentToModel()['modulo_esistente']).toBeNull()
    expect(contextSentToModel()['sto_aggiungendo_a']).toBe('Laptop')
  })
})

describe('names the model must not propose', () => {
  it('built-in ServiceRequest columns (snake_cased) and the engine reserved names reach the filter', async () => {
    catalog({})
    await ask({ itemId: null })
    const reserved = (validaProposta.mock.calls[0]![1] as { nomiRiservati: Set<string> }).nomiRiservati
    expect(reserved.has('created_at')).toBe(true)
    expect(reserved.has('docking_station')).toBe(true)
    expect(reserved.has('status')).toBe(true)
  })

  it('a schema without a ServiceRequest type still yields the engine reserved names', async () => {
    catalog({})
    getSchemaForTenant.mockResolvedValue(buildSchema('type Query { a: Int }'))
    await ask({ itemId: null })
    const reserved = (validaProposta.mock.calls[0]![1] as { nomiRiservati: Set<string> }).nomiRiservati
    expect(reserved.has('docking_station')).toBe(false)
    expect(reserved.has('tenant_id')).toBe(true)
  })
})

describe('a vocabulary that cannot be read', () => {
  it('takes that option off the table (empty list) instead of failing the design', async () => {
    catalog({})
    loadVocabularyEntries.mockImplementation(async (_t: string, name: string) => {
      if (name === 'category') throw new Error('vocabulary missing')
      return { values: ['P1'], labels: {} }
    })
    await ask({ itemId: null })
    const ctx = contextSentToModel()
    expect(ctx['categorie']).toEqual([])
    expect(ctx['priorita']).toEqual(['P1'])
    expect(logWarn).toHaveBeenCalled()
  })
})

describe('an unsaveable proposal', () => {
  it('is refused, logging the new field names, and a non-Error rejection is still reported', async () => {
    catalog({})
    validaProposta.mockReturnValue({
      ...PROPOSAL,
      campiNuovi: [{ name: 'dock', fieldType: 'text', labelIt: '', labelEn: 'Dock', refTypes: [], vocabulary: null, validationScript: null, formula: null }],
    })
    assertCatalogForm.mockImplementation(() => { throw 'bad form' as unknown as Error })
    const err = await ask({ itemId: null }).catch((e: unknown) => e) as GraphQLError
    expect(err.message).toBe('The proposal would not be saveable: bad form')
    expect(err.extensions['i18n']).toEqual({ key: 'errors.formDesigner.invalidProposal', params: { message: 'bad form' } })
    expect(logError.mock.calls[0]![0]).toMatchObject({ campiNuovi: ['dock'], sezioni: ['extra'] })
    // The trial library labels a new field with its English label when the Italian one is empty.
    const library = assertCatalogForm.mock.calls[0]![1] as Map<string, { label: string }>
    expect(library.get('dock')!.label).toBe('Dock')
  })
})
