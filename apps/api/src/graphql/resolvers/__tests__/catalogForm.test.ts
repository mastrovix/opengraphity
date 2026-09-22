/**
 * I RESOLVER DEI MODULI DEL CATALOGO (22 set 2026).
 *
 * ## Perché questo file non c'era
 * `lib/catalogForm.ts` — il contratto, la validazione, il documento del modulo
 * — sta al 79,5% di copertura ed è testato bene. `graphql/resolvers/
 * catalogForm.ts`, che è lo strato dove arrivano gli argomenti del client,
 * stava al 1,3%: quattro istruzioni su trecentootto. Nessun test lo importava.
 *
 * È la forma tipica del buco: il codice che DECIDE è coperto, il codice che
 * RICEVE no. E le porte — «questo campo è davvero nel modulo di questa voce?»,
 * «questo tipo di CI esiste?», «questo vocabolario c'è?» — stanno tutte qui.
 *
 * ## Che cosa si finge e che cosa no
 * Si finge solo quello che parla col database: `getSession`, `runQuery`,
 * `runQueryOne`, e le funzioni della libreria che leggono il grafo. La
 * validazione vera (`parseCatalogForm`, `assertCatalogForm`, `parseFormTable`,
 * `assertFormTable`, `assertLimitValue`) resta quella di produzione: fingerla
 * vorrebbe dire testare il finto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import type { FormFieldDef } from '../../../lib/catalogForm.js'

// ── il database, finto ────────────────────────────────────────────────────────
const runQuery = vi.fn()
const runQueryOne = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const executeWrite = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close, executeWrite })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

// ── la libreria: si finge solo ciò che legge il grafo ─────────────────────────
const formFields = vi.fn()
const formFieldsByName = vi.fn()
const assertFormFieldName = vi.fn().mockResolvedValue(undefined)
const saveCatalogFormRevision = vi.fn().mockResolvedValue(undefined)
const formAnswersOf = vi.fn()
const etichetteDeiValori = vi.fn()
const cacheGet = vi.fn()
vi.mock('../../../lib/catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/catalogForm.js')>()),
  formFields: (...a: unknown[]) => formFields(...a),
  formFieldsByName: (...a: unknown[]) => formFieldsByName(...a),
  assertFormFieldName: (...a: unknown[]) => assertFormFieldName(...a),
  saveCatalogFormRevision: (...a: unknown[]) => saveCatalogFormRevision(...a),
  formAnswersOf: (...a: unknown[]) => formAnswersOf(...a),
  etichetteDeiValori: (...a: unknown[]) => etichetteDeiValori(...a),
  formFieldsCache: { get: (...a: unknown[]) => cacheGet(...a) },
}))

const assertLibraryRoom = vi.fn().mockResolvedValue(undefined)
const assertFormSize = vi.fn().mockResolvedValue(undefined)
const leggiTetti = vi.fn()
vi.mock('../../../lib/catalogFormLimits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/catalogFormLimits.js')>()),
  assertLibraryRoom: (...a: unknown[]) => assertLibraryRoom(...a),
  assertFormSize: (...a: unknown[]) => assertFormSize(...a),
  catalogFormLimits: (...a: unknown[]) => leggiTetti(...a),
}))

/** Il Dizionario del cliente finto: `stato` esiste, il resto no (fail-loud). */
const VOCABOLARI: Record<string, { values: string[]; labels: Record<string, Record<string, string>> }> = {
  stato: { values: ['aperto', 'chiuso'], labels: { aperto: { it: 'Aperto', en: 'Open' } } },
}
vi.mock('../../../lib/vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async (_t: string, nome: string) => {
    const v = VOCABOLARI[nome]
    if (!v) throw new GraphQLError(`Vocabulary "${nome}" does not exist`, { extensions: { code: 'BAD_USER_INPUT' } })
    return v
  }),
}))

const invalidateSchema = vi.fn()
vi.mock('../../../lib/schemaInvalidator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/schemaInvalidator.js')>()),
  invalidateSchema: (...a: unknown[]) => invalidateSchema(...a),
}))

const proponiModulo = vi.fn()
vi.mock('../../../services/formDesignerService.js', () => ({ proponiModulo: (...a: unknown[]) => proponiModulo(...a) }))

vi.mock('../../../lib/tenantLanguage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/tenantLanguage.js')>()),
  languageFor: vi.fn(async () => 'it'),
}))

const ticketPropsOf = vi.fn(() => null)
vi.mock('../../../lib/ticketProps.js', () => ({ ticketPropsOf: (...a: unknown[]) => ticketPropsOf(...a) }))

const {
  catalogFormResolvers, formFieldOptions, formFieldTableColumns,
  serviceRequestFormAnswers, serviceRequestFormFieldValues,
} = await import('../catalogForm.js')

// ── contesto e aiuti ──────────────────────────────────────────────────────────
const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') } as never
const ctxSenzaMetamodello = { ...ctx as object, permissions: perms('operator') } as never

function campo(p: Partial<FormFieldDef> & { name: string }): FormFieldDef {
  return {
    id: `id-${p.name}`, fieldType: 'text', label: p.name, labels: [], help: null, helps: [],
    required: false, vocabulary: null, validationScript: null, formula: null, tableDefinition: null,
    refTypes: [], refFilter: null, shared: false, inList: false, createdAt: null, updatedAt: null,
    ...p,
  } as FormFieldDef
}

/** Il messaggio e il codice di un rifiuto, senza try/catch a mano in ogni test. */
async function rifiuto(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

const moduloCon = (...campi: Array<{ field: string; endUser?: boolean }>) => JSON.stringify({
  version: 1, revision: 3,
  sections: [{ id: 'main', title: { it: 'S', en: 'S' }, items: campi.map((c) => ({ field: c.field, ...(c.endUser === false ? { endUser: false } : {}) })) }],
})

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  executeWrite.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }))
  formFields.mockResolvedValue([])
  formFieldsByName.mockResolvedValue(new Map())
  runQuery.mockResolvedValue([])
  runQueryOne.mockResolvedValue(null)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('Query.formFields', () => {
  it('dice QUALI voci di catalogo usano ogni campo, e serializza le colonne come JSON', async () => {
    formFields.mockResolvedValue([
      campo({ name: 'targa' }),
      campo({ name: 'righe', fieldType: 'table', tableDefinition: { columns: [{ name: 'c', label: 'C', fieldType: 'text' }] } as never }),
    ])
    runQuery.mockResolvedValue([
      { name: 'Nuovo PC', form: moduloCon({ field: 'targa' }) },
      { name: 'Trasloco', form: moduloCon({ field: 'targa' }) },
      { name: 'Senza modulo', form: null },
    ])

    const out = await catalogFormResolvers.Query.formFields(null, null, ctx) as Array<Record<string, unknown>>
    expect(out[0]!['usedBy']).toEqual(['Nuovo PC', 'Trasloco'])
    expect(out[1]!['usedBy']).toEqual([])
    // Le colonne viaggiano come stringa: nel campo sono un oggetto, nello schema no.
    expect(typeof out[1]!['tableDefinition']).toBe('string')
    expect(out[0]!['tableDefinition']).toBeNull()
    expect(close).toHaveBeenCalled()
  })
})

describe('Query.catalogFormLimits', () => {
  it('somma i tetti del cliente, quanti campi ci sono e i limiti del prodotto', async () => {
    leggiTetti.mockResolvedValue({ maxLibraryFields: 40, maxFieldsPerForm: 20, maxTableRows: 10 })
    runQueryOne.mockResolvedValue({ n: 7 })
    const out = await catalogFormResolvers.Query.catalogFormLimits(null, null, ctx) as Record<string, unknown>
    expect(out).toMatchObject({ maxLibraryFields: 40, libraryFieldsUsed: 7, min: 1, max: 1000 })
  })
})

describe('Query.portalReferenceChoices — le tre porte', () => {
  it('la voce di catalogo deve esistere', async () => {
    runQueryOne.mockResolvedValue(null)
    expect(await rifiuto(() => catalogFormResolvers.Query.portalReferenceChoices(
      null, { itemId: 'v9', field: 'server' }, ctx))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('il campo deve essere DAVVERO nel modulo di quella voce', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'targa' }), updatedAt: null })
    const r = await rifiuto(() => catalogFormResolvers.Query.portalReferenceChoices(
      null, { itemId: 'v1', field: 'server' }, ctx))
    expect(r.code).toBe('BAD_USER_INPUT')
    expect(r.message).toContain('is not asked by the form')
  })

  it('un campo «solo area di lavoro» non è una porta per il portale', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'server', endUser: false }), updatedAt: null })
    expect((await rifiuto(() => catalogFormResolvers.Query.portalReferenceChoices(
      null, { itemId: 'v1', field: 'server' }, ctx))).code).toBe('BAD_USER_INPUT')
  })

  it('il campo deve dichiarare i tipi di CI: senza, non c\'è una lista da cui scegliere', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'server' }), updatedAt: null })
    formFieldsByName.mockResolvedValue(new Map([['server', campo({ name: 'server', fieldType: 'ref_ci', refTypes: [] })]]))
    const r = await rifiuto(() => catalogFormResolvers.Query.portalReferenceChoices(
      null, { itemId: 'v1', field: 'server' }, ctx))
    expect(r.message).toContain('does not declare which CI types')
  })

  it('passate le tre porte, i tipi viaggiano come PARAMETRO e in PascalCase', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'server' }), updatedAt: null })
    formFieldsByName.mockResolvedValue(new Map([['server', campo({ name: 'server', fieldType: 'ref_ci', refTypes: ['virtual_machine'] })]]))
    runQuery.mockResolvedValue([{ id: 'ci1', label: 'VM-01' }])

    const out = await catalogFormResolvers.Query.portalReferenceChoices(
      null, { itemId: 'v1', field: 'server', search: 'vm' }, ctx)
    expect(out).toEqual([{ id: 'ci1', label: 'VM-01' }])
    const [, cypher, params] = runQuery.mock.calls.at(-1) as [unknown, string, Record<string, unknown>]
    expect(params['etichette']).toEqual(['VirtualMachine'])
    expect(params['cerca']).toBe('vm')
    // Nessuna etichetta interpolata nel testo della query.
    expect(cypher).not.toContain('VirtualMachine')
  })
})

describe('Query.catalogForm e catalogFormToFill', () => {
  it('una voce senza modulo torna comunque un documento vuoto, non un errore', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: null, updatedAt: null })
    const out = await catalogFormResolvers.Query.catalogForm(null, { itemId: 'v1' }, ctx) as Record<string, unknown>
    expect(out['revision']).toBe(0)
    // `emptyCatalogForm`: una sezione vuota, per non mostrare una pagina bianca.
    expect(JSON.parse(String(out['definition']))).toMatchObject({ sections: [{ id: 'main', items: [] }] })
  })

  it('«da compilare» è null quando non c\'è niente da compilare', async () => {
    for (const form of [null, JSON.stringify({ version: 1, revision: 0, sections: [{ id: 'main', title: {}, items: [] }] })]) {
      runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form, updatedAt: null })
      expect(await catalogFormResolvers.Query.catalogFormToFill(null, { itemId: 'v1' }, ctx)).toBeNull()
    }
  })

  it('`endUser` si applica QUI: le voci interne non escono, e il validatore nemmeno', async () => {
    runQueryOne.mockResolvedValue({
      id: 'v1', name: 'Nuovo PC', updatedAt: null,
      form: moduloCon({ field: 'targa' }, { field: 'interno', endUser: false }),
    })
    formFieldsByName.mockResolvedValue(new Map([
      ['targa', campo({ name: 'targa', validationScript: 'return true' })],
    ]))

    const out = await catalogFormResolvers.Query.catalogFormToFill(
      null, { itemId: 'v1', endUser: true }, ctx) as Record<string, unknown>
    const def = JSON.parse(String(out['definition'])) as { sections: Array<{ items: Array<{ field: string }> }> }
    expect(def.sections.flatMap((s) => s.items).map((i) => i.field)).toEqual(['targa'])
    // La revisione resta quella PUBBLICATA: è il numero che il ticket porta.
    expect(out['revision']).toBe(3)
    expect((out['fields'] as Array<Record<string, unknown>>)[0]!['validationScript']).toBeNull()
  })

  it('un campo citato e non più in libreria si DICE, non si finge', async () => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'sparito' }), updatedAt: null })
    formFieldsByName.mockResolvedValue(new Map())
    const r = await rifiuto(() => catalogFormResolvers.Query.catalogFormToFill(null, { itemId: 'v1' }, ctx))
    expect(r.message).toContain('no longer exist in the library: sparito')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('Mutation.createFormField — le validazioni', () => {
  const crea = (input: Record<string, unknown>) =>
    catalogFormResolvers.Mutation.createFormField(null, { input }, ctx)

  it('il tipo deve essere un tipo, e l\'etichetta non può mancare', async () => {
    expect((await rifiuto(() => crea({ name: 'x', fieldType: 'colore', label: 'X' }))).message).toContain('is not a field type')
    expect((await rifiuto(() => crea({ name: 'x', fieldType: 'text', label: '  ' }))).message).toContain('needs a label')
  })

  it('il tetto della libreria si guarda PRIMA di validare il campo', async () => {
    assertLibraryRoom.mockRejectedValueOnce(new GraphQLError('library full'))
    expect((await rifiuto(() => crea({ name: 'x', fieldType: 'text', label: 'X' }))).message).toBe('library full')
    // Nessuna validazione dopo: non si valida un campo che non ci sta.
    expect(assertFormFieldName).not.toHaveBeenCalled()
  })

  it('un nome già in libreria si rifiuta', async () => {
    runQueryOne.mockResolvedValue({ n: 1 })
    expect((await rifiuto(() => crea({ name: 'targa', fieldType: 'text', label: 'Targa' }))).message)
      .toContain('is already in the library')
  })

  it('il vocabolario: obbligatorio per enum, vietato agli altri, e deve esistere', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'enum', label: 'A' }))).message).toContain('needs a vocabulary')
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'text', label: 'A', vocabulary: 'stato' }))).message).toContain('takes no vocabulary')
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'enum', label: 'A', vocabulary: 'inesistente' }))).message).toContain('does not exist')
  })

  it('la formula solo dove il valore può essere calcolato', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'attachment', label: 'A', formula: 'return 1' }))).message)
      .toContain('cannot be computed')
  })

  it('la colonna in lista solo dove la risposta diventa una proprietà del ticket', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'attachment', label: 'A', inList: true }))).message)
      .toContain('cannot be a list column')
  })

  it('le colonne: solo su una tabella, e una tabella senza colonne non si salva', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'text', label: 'A', tableDefinition: '{"columns":[]}' }))).message)
      .toContain('takes no table columns')
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'table', label: 'A' }))).message)
      .toContain('has no columns')
  })

  it('i tipi di CI: solo su ref_ci, e devono esistere nel metamodello', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'text', label: 'A', refTypes: ['Server'] }))).message)
      .toContain('takes no CI types')

    runQuery.mockResolvedValue([{ name: 'Server' }])
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'ref_ci', label: 'A', refTypes: ['Stampante'] }))).message)
      .toContain('Unknown CI types: Stampante')
  })

  it('il filtro CMDB: solo su ref_ci, e deve produrre una WHERE valida', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    expect((await rifiuto(() => crea({ name: 'a', fieldType: 'text', label: 'A', refFilter: '{"rules":[]}' }))).message)
      .toContain('takes no CMDB filter')

    runQuery.mockResolvedValue([])
    const r = await rifiuto(() => crea({
      name: 'a', fieldType: 'ref_ci', label: 'A', refTypes: [],
      refFilter: JSON.stringify({ rules: [{ field: 'campo_che_non_esiste', op: 'eq', value: 'x' }] }),
    }))
    expect(r.message).toContain('The CMDB filter is not usable')
  })

  it('creato: scrive il nodo, tira la leva del metamodello e torna la vista', async () => {
    runQueryOne.mockResolvedValue({ n: 0 })
    formFields.mockResolvedValue([campo({ name: 'targa', label: 'Targa' })])
    const out = await crea({ name: 'targa', fieldType: 'text', label: 'Targa', required: true }) as Record<string, unknown>
    expect(out['name']).toBe('targa')
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    const scritture = runQuery.mock.calls.filter((c) => String(c[1]).includes('CREATE (f:FormField'))
    expect(scritture).toHaveLength(1)
    expect((scritture[0]![2] as Record<string, unknown>)['required']).toBe(true)
  })
})

describe('Mutation.updateFormField', () => {
  const corrente = campo({ name: 'server', fieldType: 'ref_ci', label: 'Server', refTypes: ['Server'], refFilter: '{"rules":[{"field":"vendor","op":"eq","value":"Dell"}]}' })

  beforeEach(() => { formFields.mockResolvedValue([corrente]) })

  it('un\'etichetta vuota si rifiuta (il nome e il tipo non si cambiano affatto)', async () => {
    expect((await rifiuto(() => catalogFormResolvers.Mutation.updateFormField(
      null, { id: 'id-server', input: { label: '   ' } }, ctx))).message).toContain('needs a label')
  })

  it('il filtro si RIVALIDA anche quando cambiano solo i tipi di CI', async () => {
    // `vendor` esiste sui Server ma non sulle Stampanti: restringendo il tipo,
    // il filtro vecchio non regge più e il rifiuto arriva a chi configura.
    runQuery.mockImplementation(async (_s: unknown, cypher: string) => {
      if (String(cypher).includes('HAS_FIELD')) return []           // nessun campo proprio del nuovo tipo
      if (String(cypher).includes('CITypeDefinition')) return [{ name: 'Stampante' }]
      return []
    })
    const r = await rifiuto(() => catalogFormResolvers.Mutation.updateFormField(
      null, { id: 'id-server', input: { refTypes: ['Stampante'] } }, ctx))
    expect(r.message).toContain('The CMDB filter is not usable')
  })

  it('quello che non arriva non si tocca: i flag `*Set` dicono che cosa cambia', async () => {
    runQuery.mockResolvedValue([])
    await catalogFormResolvers.Mutation.updateFormField(null, { id: 'id-server', input: { required: true } }, ctx)
    const set = runQuery.mock.calls.find((c) => String(c[1]).includes('SET f.label'))!
    const p = set[2] as Record<string, unknown>
    expect(p['requiredSet']).toBe(true)
    expect(p['tableSet']).toBe(false)
    expect(p['refTypesSet']).toBe(false)
    expect(p['helpSet']).toBe(false)
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
  })
})

describe('Mutation.deleteFormField', () => {
  beforeEach(() => { formFields.mockResolvedValue([campo({ name: 'targa', label: 'Targa' })]) })

  it('non si cancella un campo che un modulo usa, e il rifiuto dice QUALI', async () => {
    runQuery.mockResolvedValue([{ name: 'Nuovo PC', form: moduloCon({ field: 'targa' }) }])
    const r = await rifiuto(() => catalogFormResolvers.Mutation.deleteFormField(null, { id: 'id-targa' }, ctx))
    expect(r.message).toContain('is used by the form of: Nuovo PC')
  })

  it('libero: si cancella e la cache dimentica', async () => {
    runQuery.mockResolvedValue([])
    expect(await catalogFormResolvers.Mutation.deleteFormField(null, { id: 'id-targa' }, ctx)).toBe(true)
    expect(runQuery.mock.calls.some((c) => String(c[1]).includes('DETACH DELETE f'))).toBe(true)
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
  })

  it('un campo che non c\'è è NOT_FOUND, non un successo silenzioso', async () => {
    expect((await rifiuto(() => catalogFormResolvers.Mutation.deleteFormField(null, { id: 'id-mai-esistito' }, ctx))).code)
      .toBe('NOT_FOUND')
  })
})

describe('Mutation.setCatalogFormLimits', () => {
  it('i tre tetti si validano, e un tenant senza nodo :Tenant è un errore forte', async () => {
    runQueryOne.mockResolvedValue(null)
    expect((await rifiuto(() => catalogFormResolvers.Mutation.setCatalogFormLimits(
      null, { maxLibraryFields: 50, maxFieldsPerForm: 20, maxTableRows: 10 }, ctx))).message)
      .toContain('has no :Tenant node')

    expect((await rifiuto(() => catalogFormResolvers.Mutation.setCatalogFormLimits(
      null, { maxLibraryFields: 0, maxFieldsPerForm: 20, maxTableRows: 10 }, ctx))).code).not.toBe('NESSUN RIFIUTO')
  })

  it('salvati: torna i tetti nuovi e quanti campi ci sono già', async () => {
    runQueryOne.mockResolvedValue({ n: 12 })
    const out = await catalogFormResolvers.Mutation.setCatalogFormLimits(
      null, { maxLibraryFields: 50, maxFieldsPerForm: 20, maxTableRows: 10 }, ctx) as Record<string, unknown>
    expect(out).toMatchObject({ maxLibraryFields: 50, maxTableRows: 10, libraryFieldsUsed: 12 })
  })
})

describe('Mutation.proposeServiceRequestDesign', () => {
  it('chi può solo COMPORRE riceve una proposta di solo riuso', async () => {
    proponiModulo.mockResolvedValue({ prompt: 'p', maxFieldsPerForm: 20, voce: null, sezioni: [], campiNuovi: [], vocabolariNuovi: [], scartati: [], note: [] })
    await catalogFormResolvers.Mutation.proposeServiceRequestDesign(null, { prompt: 'p' }, ctxSenzaMetamodello)
    expect(proponiModulo.mock.calls[0]![0]).toMatchObject({ consentiNuovi: false })

    await catalogFormResolvers.Mutation.proposeServiceRequestDesign(null, { prompt: 'p' }, ctx)
    expect(proponiModulo.mock.calls[1]![0]).toMatchObject({ consentiNuovi: true })
  })

  it('gli scarti viaggiano coi parametri come JSON', async () => {
    proponiModulo.mockResolvedValue({
      prompt: 'p', maxFieldsPerForm: 20, voce: null, sezioni: [], campiNuovi: [], vocabolariNuovi: [],
      scartati: [{ cosa: 'campo', key: 'errors.x', params: { name: 'a' } }], note: ['n'],
    })
    const out = await catalogFormResolvers.Mutation.proposeServiceRequestDesign(null, { prompt: 'p' }, ctx) as Record<string, unknown>
    expect(out['discarded']).toEqual([{ what: 'campo', key: 'errors.x', params: '{"name":"a"}' }])
    expect(out['notes']).toEqual(['n'])
  })
})

describe('Mutation.saveCatalogForm', () => {
  beforeEach(() => {
    runQueryOne.mockResolvedValue({ id: 'v1', name: 'Nuovo PC', form: moduloCon({ field: 'targa' }), updatedAt: null })
    formFieldsByName.mockResolvedValue(new Map([['targa', campo({ name: 'targa' })]]))
  })

  it('un documento vuoto si rifiuta', async () => {
    expect((await rifiuto(() => catalogFormResolvers.Mutation.saveCatalogForm(
      null, { itemId: 'v1', definition: '' }, ctx))).message).toContain('form definition is empty')
  })

  it('la revisione sale di uno, e la copia congelata sta nella STESSA transazione', async () => {
    const out = await catalogFormResolvers.Mutation.saveCatalogForm(
      null, { itemId: 'v1', definition: moduloCon({ field: 'targa' }) }, ctx) as Record<string, unknown>
    expect(out['revision']).toBe(4)
    expect(executeWrite).toHaveBeenCalledTimes(1)
    // Tutte e due le scritture dentro l'unica transazione: o entrambe o nessuna.
    expect(saveCatalogFormRevision).toHaveBeenCalledTimes(1)
    const [tx] = saveCatalogFormRevision.mock.calls[0] as [unknown]
    expect(tx).toEqual({ tx: true })
  })

  it('il tetto per modulo si guarda prima di scrivere', async () => {
    assertFormSize.mockRejectedValueOnce(new GraphQLError('too many fields'))
    expect((await rifiuto(() => catalogFormResolvers.Mutation.saveCatalogForm(
      null, { itemId: 'v1', definition: moduloCon({ field: 'targa' }) }, ctx))).message).toBe('too many fields')
    expect(executeWrite).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('i resolver di campo', () => {
  it('`options`: le scelte del Dizionario con l\'etichetta nella lingua chiesta', async () => {
    expect(await formFieldOptions({ fieldType: 'enum', vocabulary: null }, {}, ctx)).toEqual([])
    const out = await formFieldOptions({ fieldType: 'enum', vocabulary: 'stato' }, { language: 'en' }, ctx)
    expect(out).toEqual([{ value: 'aperto', label: 'Open' }, { value: 'chiuso', label: 'Chiuso' }])
  })

  it('`tableColumns`: vuote se non è una tabella, altrimenti colonne con le loro scelte', async () => {
    expect(await formFieldTableColumns({ fieldType: 'text', tableDefinition: null }, {}, ctx)).toEqual([])
    const def = JSON.stringify({ version: 1, columns: [
      { name: 'stato', label: 'Stato', fieldType: 'enum', vocabulary: 'stato', required: true },
      { name: 'nota', label: 'Nota', fieldType: 'text' },
    ] })
    const out = await formFieldTableColumns({ fieldType: 'table', tableDefinition: def }, { language: 'it' }, ctx)
    expect(out.map((c) => c.name)).toEqual(['stato', 'nota'])
    expect(out[0]!.required).toBe(true)
    expect(out[0]!.options).toEqual([{ value: 'aperto', label: 'Aperto' }, { value: 'chiuso', label: 'Chiuso' }])
    expect(out[1]!.options).toEqual([])
  })

  it('`formAnswers`: niente da dire per un ticket senza modulo', async () => {
    expect(await serviceRequestFormAnswers({ id: 'r1' }, null, ctx)).toEqual([])
    expect(await serviceRequestFormAnswers({ id: 'r1', catalogItemId: 'v1', formRevision: null }, null, ctx)).toEqual([])
  })

  it('`formAnswers`: le celle escono in ORDINE DI COLONNA, con le etichette del Dizionario', async () => {
    runQueryOne.mockResolvedValue({ props: { targa: 'AB123' } })
    formAnswersOf.mockResolvedValue([{
      name: 'righe', label: 'Righe', fieldType: 'table', value: null, values: [],
      tableColumns: [{ name: 'stato', vocabulary: 'stato' }, { name: 'nota', vocabulary: null }],
      rows: [{ nota: 'ciao', stato: 'aperto' }],
    }])
    const out = await serviceRequestFormAnswers({ id: 'r1', catalogItemId: 'v1', formRevision: 3 }, null, ctx)
    expect((out[0]!['rows'] as Array<{ cells: unknown[] }>)[0]!.cells).toEqual([
      { column: 'stato', value: 'aperto', displayValue: 'Aperto' },
      { column: 'nota', value: 'ciao', displayValue: 'ciao' },
    ])
  })

  it('`formFieldValues`: solo i campi messi in lista, e solo quelli con un valore', async () => {
    cacheGet.mockResolvedValue([
      campo({ name: 'targa', inList: true }),
      campo({ name: 'stato', fieldType: 'enum', inList: true, vocabulary: 'stato' }),
      campo({ name: 'nascosto', inList: false }),
      campo({ name: 'allegato', fieldType: 'attachment', inList: true }),
    ])
    etichetteDeiValori.mockResolvedValue((nome: string) => (v: string) => (nome === 'stato' ? 'Aperto' : v))
    runQueryOne.mockResolvedValue({ props: { targa: 'AB123', stato: 'aperto', nascosto: 'x' } })

    const out = await serviceRequestFormFieldValues({ id: 'r1' }, null, ctx)
    expect(out.map((v) => v.name)).toEqual(['targa', 'stato'])
    expect(out[1]!.displayValue).toBe('Aperto')
    expect(out[0]!.rows).toEqual([])
  })

  it('`formFieldValues`: se le proprietà sono già state lette, non si riapre nessuna sessione', async () => {
    cacheGet.mockResolvedValue([campo({ name: 'targa', inList: true })])
    etichetteDeiValori.mockResolvedValue(() => (v: string) => v)
    ticketPropsOf.mockReturnValueOnce({ targa: 'AB123' } as never)

    const out = await serviceRequestFormFieldValues({ id: 'r1' }, null, ctx)
    expect(out.map((v) => v.name)).toEqual(['targa'])
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('`formFieldValues`: nessun campo in lista → nessuna lettura affatto', async () => {
    cacheGet.mockResolvedValue([campo({ name: 'targa', inList: false })])
    expect(await serviceRequestFormFieldValues({ id: 'r1' }, null, ctx)).toEqual([])
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})
