/**
 * «DESCRIVIMI LA SERVICE REQUEST E TE LA DISEGNO» (22 set 2026).
 *
 * ## Perché non c'erano
 * `services/formDesignerService.ts` stava all'8,1%. Il filtro della proposta
 * (`lib/formDesignProposal.ts`) ha i suoi test; questa è la PORTA, e porta due
 * regole che sono costate qualcosa:
 *
 *  1. **la chiave PRIMA del lavoro**. `getAnthropic()` stava dopo SEI letture
 *     del grafo: su una piattaforma senza chiave si pagava tutto il catalogo
 *     per poi dire «non configurato»;
 *  2. **l'ultima parola è della validazione vera**. Il gemello dei report lo
 *     faceva e questo no, ed è costato SEI difetti con la stessa forma: il
 *     filtro lasciava passare qualcosa che `assertCatalogForm` poi rifiutava —
 *     una nota obbligatoria, un campo in sola lettura e obbligatorio, una
 *     sezione senza titolo, due sezioni con lo stesso id. Il rifiuto arrivava
 *     al SALVATAGGIO, cioè dopo che i campi erano già stati creati in libreria.
 *
 * La libreria di prova che si dà a `assertCatalogForm` mette insieme i campi
 * che esistono e quelli che NASCEREBBERO accettando: è esattamente quello che
 * `saveCatalogForm` leggerà dal grafo dopo l'accettazione.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// L'id del modello NON si scrive qui: `aiModel.test.ts` è un lint statico che
// pretende che viva solo in `config.ts`.
/*
 * LA CONFIGURAZIONE FINTA RISPONDE A TUTTO.
 *
 * Leggere il catalogo tira dentro mezza applicazione — l'autenticazione,
 * l'export dei report, la posta — e ognuno di quei moduli legge una chiave
 * diversa di `config` al momento del CARICAMENTO. Elencarle a mano voleva dire
 * aggiungerne una a ogni giro, su pezzi che non c'entrano niente con quello
 * che si sta provando (il test cadeva su «KEYCLOAK_PUBLIC_URLS is not
 * iterable», poi su `config.reportDir`).
 *
 * Quindi: le poche che hanno una FORMA precisa si scrivono, e per tutte le
 * altre si risponde con una stringa. Questo test non parla di configurazione,
 * e dirlo così è più onesto di un elenco che invecchia.
 */
const CONFIG_CON_FORMA: Record<string, unknown> = {
  anthropicModel:     'modello-finto',
  keycloakPublicUrls: ['http://kc.localhost'],
  keycloakAppClientIds: ['opengrafo-web'],
  // Deve essere un URL vero: `auth/keycloak.ts` ci costruisce sopra `new URL`.
  keycloakUrl:        'http://kc:8080',
}
vi.mock('../../lib/config.js', () => ({
  config: new Proxy({}, {
    get: (_t, chiave: string) => (chiave in CONFIG_CON_FORMA ? CONFIG_CON_FORMA[chiave] : `finto-${chiave}`),
    has: () => true,
  }),
}))
vi.mock('../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const assertAIFeature = vi.fn()
vi.mock('../../lib/aiSettings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/aiSettings.js')>()),
  assertAIFeature: (...a: unknown[]) => assertAIFeature(...a),
}))

const getAnthropic = vi.fn()
const leggiJSONDalModello = vi.fn()
const registraChiamataFallita = vi.fn()
const registraDurata = vi.fn()
const registraScarti = vi.fn()
vi.mock('../../lib/aiClient.js', () => ({
  getAnthropic: (...a: unknown[]) => getAnthropic(...a),
  leggiJSONDalModello: (...a: unknown[]) => leggiJSONDalModello(...a),
  bloccoDiContesto: vi.fn((c: unknown) => ({ type: 'text', text: JSON.stringify(c) })),
  registraChiamataFallita: (...a: unknown[]) => registraChiamataFallita(...a),
  registraDurata: (...a: unknown[]) => registraDurata(...a),
  registraScarti: (...a: unknown[]) => registraScarti(...a),
}))

const runQuery = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
/*
 * Mock PARZIALE: il catalogo tira dentro mezza applicazione, e ognuno di quei
 * moduli usa un pezzo diverso del pacchetto neo4j. Elencarli a mano voleva
 * dire aggiungerne uno a ogni giro; qui si sostituisce solo cio' che apre una
 * connessione.
 */
vi.mock('@opengraphity/neo4j', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opengraphity/neo4j')>()),
  getSession: vi.fn(() => ({ close })),
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryOne: vi.fn(async () => null),
}))

const formFields = vi.fn()
const assertCatalogForm = vi.fn()
vi.mock('../../lib/catalogForm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/catalogForm.js')>()),
  formFields: (...a: unknown[]) => formFields(...a),
  assertCatalogForm: (...a: unknown[]) => assertCatalogForm(...a),
}))

vi.mock('../../lib/catalogFormLimits.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  catalogFormLimits: vi.fn(async () => ({ maxLibraryFields: 50, maxFieldsPerForm: 20, maxTableRows: 10 })),
}))
vi.mock('../../lib/scriptingPlan.js', () => ({ getScriptingPlan: vi.fn(async () => ({ plan: 'pro', enabled: true })) }))
vi.mock('../../lib/vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async () => ({ values: Array.from({ length: 30 }, (_, i) => `v${i}`), labels: {} })),
}))
vi.mock('../../lib/systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'Italian') }))

const validaProposta = vi.fn()
vi.mock('../../lib/formDesignProposal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/formDesignProposal.js')>()),
  validaProposta: (...a: unknown[]) => validaProposta(...a),
}))

const { proponiModulo, propostaComeDefinizione, MAX_PROMPT_CHARS } = await import('../formDesignerService.js')

const messagesCreate = vi.fn()

// The first proposal loads the whole GraphQL schema (`nomiNonUsabili` imports
// `schemaCache.js` lazily): seconds on a busy full-suite run. Load it once here,
// with room, so no single test pays for it against the 5s test timeout.
beforeAll(async () => { await import('../../lib/schemaCache.js') }, 60_000)

const PROPOSTA = {
  voce: 'Nuovo PC', sezioni: [{ id: 'main', titleIt: 'Dati', titleEn: 'Data', columns: 1, items: [] }],
  campiNuovi: [], vocabolariNuovi: [], scartati: [], note: [], maxFieldsPerForm: 20,
}

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

const chiedi = (over: Record<string, unknown> = {}) =>
  proponiModulo({ tenantId: 't1', prompt: 'un modulo per chiedere un PC', itemId: null, consentiNuovi: true, ...over } as never)

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  assertAIFeature.mockResolvedValue(undefined)
  getAnthropic.mockReturnValue({ messages: { create: messagesCreate } })
  messagesCreate.mockResolvedValue({ content: [] })
  runQuery.mockResolvedValue([])
  formFields.mockResolvedValue([])
  leggiJSONDalModello.mockReturnValue({ sezioni: [] })
  validaProposta.mockReturnValue(PROPOSTA)
  assertCatalogForm.mockReturnValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('le porte, nell\'ordine giusto', () => {
  it('l\'interruttore dell\'organizzazione viene per primo', async () => {
    assertAIFeature.mockRejectedValue(new GraphQLError('spento'))
    expect((await esito(() => chiedi())).message).toBe('spento')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('una descrizione vuota o troppo lunga si rifiuta', async () => {
    expect((await esito(() => chiedi({ prompt: '   ' }))).message).toContain('Empty description')
    expect((await esito(() => chiedi({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }))).message).toContain('too long')
  })

  it('la CHIAVE prima del catalogo: senza, si pagherebbero sei letture per dire «non configurato»', async () => {
    getAnthropic.mockImplementation(() => { throw new GraphQLError('nessuna chiave') })
    expect((await esito(() => chiedi())).message).toBe('nessuna chiave')
    expect(formFields).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('quello che il modello vede del cliente', () => {
  it('i vocabolari TRONCATI, e quanti ne restano', async () => {
    // Un vocabolario del cliente con trenta valori: una tendina con duecento
    // non aiuta a scegliere un filtro, e i valori troncati restano validabili
    // dal filtro, che li conosce tutti.
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (String(cypher).includes('EnumTypeDefinition')
        ? [{ name: 'stato', values: Array.from({ length: 30 }, (_, i) => `v${i}`), owner: 't1' }]
        : []))
    await chiedi()
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }>; messages: Array<{ content: string }> }
    const contesto = JSON.parse(arg.system.at(-1)!.text) as { vocabolari: Array<{ nome: string; valori: string[]; altri?: number }> }
    const stato = contesto.vocabolari.find((v) => v.nome === 'stato')!
    expect(stato.valori).toHaveLength(12)
    expect(stato.altri).toBe(18)
    // La descrizione di chi chiede sta nel MESSAGGIO, non nel contesto in cache.
    expect(arg.messages[0]!.content).toBe('un modulo per chiedere un PC')
  })

  it('il vocabolario DEL CLIENTE scavalca quello spedito, mai il contrario', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (String(cypher).includes('EnumTypeDefinition')
        ? [
            { name: 'priority', values: ['p1', 'p2'], owner: 'system' },
            { name: 'priority', values: ['bassa', 'alta'], owner: 't1' },
            { name: 'severity', values: ['s1'], owner: 'system' },
          ]
        : []))
    await chiedi()
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }> }
    const contesto = JSON.parse(arg.system.at(-1)!.text) as { vocabolari: Array<{ nome: string; valori: string[] }> }
    expect(contesto.vocabolari.find((v) => v.nome === 'priority')!.valori).toEqual(['bassa', 'alta'])
    expect(contesto.vocabolari.find((v) => v.nome === 'severity')!.valori).toEqual(['s1'])
  })

  it('e se non può creare niente di nuovo, il modello lo SA', async () => {
    await chiedi({ consentiNuovi: false })
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }> }
    const contesto = JSON.parse(arg.system.at(-1)!.text) as Record<string, unknown>
    expect(contesto['posso_creare_campi_e_vocabolari_nuovi']).toBe(false)
  })

  it('le etichette si chiedono in tutte e due le lingue, e nella lingua del tenant', async () => {
    await chiedi()
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }> }
    expect(arg.system[1]!.text).toContain('Italian')
    expect(arg.system[1]!.text).toContain('etichetta_it')
    expect(arg.system[1]!.text).toContain('etichetta_en')
  })
})

describe('l\'ultima parola è della validazione vera', () => {
  it('la libreria di prova mette insieme i campi CHE ESISTONO e quelli che NASCEREBBERO', async () => {
    formFields.mockResolvedValue([{ name: 'targa', fieldType: 'text', label: 'Targa' }])
    validaProposta.mockReturnValue({
      ...PROPOSTA,
      campiNuovi: [{ name: 'modello', fieldType: 'text', labelIt: 'Modello', labelEn: 'Model', refTypes: [], vocabulary: null, validationScript: null, formula: null }],
    })
    await chiedi()
    const libreria = assertCatalogForm.mock.calls[0]![1] as Map<string, unknown>
    // È esattamente quello che `saveCatalogForm` leggerà dal grafo dopo
    // l'accettazione: l'esistente più il nuovo.
    expect([...libreria.keys()].sort()).toEqual(['modello', 'targa'])
  })

  it('se una proposta filtrata non passa è un difetto NOSTRO, e si dice invece di consegnarla', async () => {
    assertCatalogForm.mockImplementation(() => { throw new Error('una sezione senza titolo') })
    const r = await esito(() => chiedi())
    expect(r.code).toBe('INTERNAL_SERVER_ERROR')
    expect(r.message).toContain('would not be saveable')
    // I params ci vogliono: senza, i18next stampa «{{message}}» alla lettera.
    expect(r.message).toContain('una sezione senza titolo')
  })

  it('passata: la proposta esce col prompt, e non si è scritto niente', async () => {
    const out = await chiedi()
    expect(out).toMatchObject({ ...PROPOSTA, prompt: 'un modulo per chiedere un PC' })
    expect(registraDurata).toHaveBeenCalledWith('formDesigner', expect.any(Number))
    expect(registraScarti).toHaveBeenCalledWith('formDesigner', 0)
  })
})

describe('la chiamata al modello che fallisce', () => {
  it('si conta e si rilancia: non si finge una proposta vuota', async () => {
    messagesCreate.mockRejectedValue(new Error('529 overloaded'))
    expect((await esito(() => chiedi())).message).toContain('529 overloaded')
    expect(registraChiamataFallita).toHaveBeenCalledWith('formDesigner', expect.any(Error))
    expect(registraDurata).not.toHaveBeenCalled()
  })
})

describe('propostaComeDefinizione — le sezioni si AGGIUNGONO a quelle che c\'erano', () => {
  it('un modulo che non c\'è: revisione zero e solo le sezioni proposte', () => {
    const def = propostaComeDefinizione({ sezioni: [{ id: 'main', titleIt: 'Dati', titleEn: 'Data', columns: 1, items: [] }] } as never, null)
    expect(def.revision).toBe(0)
    expect(def.sections).toHaveLength(1)
  })

  it('un modulo che c\'è: le sue sezioni restano davanti, e la revisione non cambia', () => {
    const esistente = { version: 1, revision: 4, sections: [{ id: 'main', title: { it: 'Vecchia' }, items: [] }] }
    const def = propostaComeDefinizione(
      { sezioni: [{ id: 'main', titleIt: 'Nuova', titleEn: 'New', columns: 1, items: [] }] } as never, esistente as never)
    expect(def.revision).toBe(4)
    expect(def.sections[0]).toMatchObject({ id: 'main', title: { it: 'Vecchia' } })
    // L'id in collisione lo risolve `sectionsFromProposal`, che è la STESSA
    // funzione del browser: due copie vorrebbero dire validare qui un
    // documento e salvarne un altro di là.
    expect(def.sections).toHaveLength(2)
    expect(def.sections[1]!.id).not.toBe('main')
  })
})
