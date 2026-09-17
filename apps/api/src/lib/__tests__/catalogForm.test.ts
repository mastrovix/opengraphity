/**
 * Moduli del catalogo servizi, ondata 1.
 *
 * Tre cose sono pinnate qui, e sono quelle che, sbagliate, non si vedrebbero:
 *
 *  1. IL VALUTATORE DELLE CONDIZIONI (@opengraphity/types): lo usano il browser
 *     per mostrare e il server per accettare. Se i due divergessero, un campo
 *     nascosto diventerebbe un varco — quindi il valutatore è uno e i suoi casi
 *     limite sono fissati: risposta vuota, liste, confronti numerici e di data.
 *  2. LA LETTURA DELLA DEFINIZIONE: un documento corrotto o di una versione
 *     sconosciuta deve essere un ERRORE, non un modulo vuoto (che sembrerebbe
 *     una configurazione).
 *  3. LA SCRITTURA DELLE RISPOSTE: un campo nascosto da una condizione che
 *     arriva comunque va rifiutato, e un obbligatorio nascosto non va chiesto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  evaluateFormCondition, evaluateFormRule, emptyCatalogForm, catalogFormFieldNames,
  catalogFormForEndUser, formItemsToFill,
  type CatalogFormDefinition, type FormCondition,
} from '@opengraphity/types'

vi.mock('../vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async (_t: string, name: string) => {
    if (name === 'device_kind') return { values: ['portatile', 'fisso', 'tablet'], labels: {}, colors: {} }
    if (name === 'sistemi')     return { values: ['posta', 'crm', 'erp'], labels: {}, colors: {} }
    throw new Error(`Vocabulary "${name}" does not exist`)
  }),
}))
/**
 * Gli script del sandbox, finti: qui si fissa COSA SI FA del loro esito, non
 * come gira isolated-vm (quello è dei test di `packages/scripting`). La formula
 * finta calcola quello che le si dice, o fallisce se `formulaFallisce`.
 */
let formulaFallisce: string | null = null
const formule: string[] = []
/**
 * La lingua del tenant: da quando i rifiuti nominano il campo NELLA LINGUA di
 * chi legge (trovato provando dal portale: «The field "Estimated cost" was
 * refused» a un utente italiano), `resolveFormWrites` la legge una volta.
 */
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))
vi.mock('../metamodelScript.js', () => ({
  runValidationScript: vi.fn(async () => null),
  runFormulaScript: vi.fn(async (code: string, input: Record<string, unknown>) => {
    formule.push(code)
    if (formulaFallisce) return { ok: false, error: formulaFallisce }
    // La finta sa fare una cosa: il codice è il nome di un campo di `input`,
    // così il test verifica COSA vede la formula.
    return { ok: true, value: input[code.trim()] ?? null }
  }),
}))

/**
 * Le due letture che l'ondata 2 fa sul grafo: l'esistenza del nodo puntato da
 * un riferimento e quanti file porta la bozza. Sono mockate qui perché il
 * comportamento da fissare è la VALIDAZIONE, non il Cypher — quello lo verifica
 * `scripts/check-cypher.mjs`, che manda ogni query in EXPLAIN.
 */
let contaFileBozza = 0
const RIFERIMENTI_ESISTENTI = new Set(['ci-1', 'u-1', 'u-2', 'team-1'])
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, query: string, params: Record<string, unknown>) => {
    if (query.includes('count(a) AS n')) return [{ n: contaFileBozza }]
    if (query.includes('RETURN n.id AS id')) {
      return RIFERIMENTI_ESISTENTI.has(String(params['id'])) ? [{ id: params['id'] }] : []
    }
    return []
  }),
}))

const { parseCatalogForm, assertCatalogForm, resolveFormWrites, visibleFormItems, settableByAutomation, formFieldAutomationMetas } = await import('../catalogForm.js')
const { runValidationScript, runFormulaScript } = await import('../metamodelScript.js')

const campo = (name: string, fieldType: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, fieldType, label: name, labels: [], help: null, helps: [],
  required: false, vocabulary: null, validationScript: null, createdAt: null, updatedAt: null,
  ...extra,
}) as never

const LIBRERIA = new Map<string, never>([
  ['modello',        campo('modello', 'text')],
  ['costo',          campo('costo', 'number')],
  ['urgente',        campo('urgente', 'boolean')],
  ['data_inizio',    campo('data_inizio', 'date')],
  ['tipo_dispositivo', campo('tipo_dispositivo', 'enum', { vocabulary: 'device_kind' })],
  ['sistemi',        campo('sistemi', 'multi_enum', { vocabulary: 'sistemi' })],
  ['istruzioni',     campo('istruzioni', 'note')],
  ['centro_di_costo', campo('centro_di_costo', 'text', { required: true })],
  // Ondata 2
  ['preventivo',      campo('preventivo', 'attachment')],
  ['dispositivo',     campo('dispositivo', 'ref_ci')],
  ['per_chi',         campo('per_chi', 'ref_user')],
  ['squadra',         campo('squadra', 'ref_team')],
])

/** Un modulo di prova: il costo si chiede solo se il tipo è «portatile». */
function moduloDiProva(): CatalogFormDefinition {
  return {
    version: 1,
    revision: 3,
    sections: [
      {
        id: 'dispositivo',
        title: { it: 'Dispositivo', en: 'Device' },
        items: [
          { field: 'tipo_dispositivo', required: true },
          { field: 'modello' },
          { field: 'costo', visibleWhen: { match: 'all', rules: [{ field: 'tipo_dispositivo', op: 'eq', value: 'portatile' }] }, required: true },
        ],
      },
      {
        id: 'amministrativo',
        title: { it: 'Amministrativo' },
        items: [
          { field: 'centro_di_costo' },
          { field: 'istruzioni' },
          { field: 'urgente', endUser: false },
        ],
      },
    ],
  }
}

describe('il valutatore delle condizioni (browser e server, lo stesso)', () => {
  it('una risposta vuota fa fallire ogni regola tranne «vuoto»', () => {
    for (const vuoto of [undefined, null, '', '   ', []]) {
      const answers = { x: vuoto as never }
      expect(evaluateFormRule({ field: 'x', op: 'eq', value: 'a' }, answers)).toBe(false)
      expect(evaluateFormRule({ field: 'x', op: 'ne', value: 'a' }, answers)).toBe(false)
      expect(evaluateFormRule({ field: 'x', op: 'gt', value: '0' }, answers)).toBe(false)
      expect(evaluateFormRule({ field: 'x', op: 'filled' }, answers)).toBe(false)
      expect(evaluateFormRule({ field: 'x', op: 'empty' }, answers)).toBe(true)
    }
  })

  it('i confronti d\'ordine sono numerici fra numeri e alfabetici fra testi (le date ISO si ordinano come testo)', () => {
    expect(evaluateFormRule({ field: 'c', op: 'gt', value: '1000' }, { c: '900' })).toBe(false)
    expect(evaluateFormRule({ field: 'c', op: 'gt', value: '1000' }, { c: 2000 })).toBe(true)
    // «900» > «1000» alfabeticamente: il confronto numerico evita il difetto classico.
    expect(evaluateFormRule({ field: 'c', op: 'gte', value: '1000' }, { c: '1000' })).toBe(true)
    expect(evaluateFormRule({ field: 'd', op: 'gte', value: '2026-01-01' }, { d: '2026-03-04' })).toBe(true)
    expect(evaluateFormRule({ field: 'd', op: 'lt', value: '2026-01-01' }, { d: '2025-12-31' })).toBe(true)
  })

  it('su una lista «uguale» e «contiene» vogliono dire appartenenza; i confronti d\'ordine no', () => {
    const a = { s: ['posta', 'crm'] }
    expect(evaluateFormRule({ field: 's', op: 'eq', value: 'crm' }, a)).toBe(true)
    expect(evaluateFormRule({ field: 's', op: 'contains', value: 'crm' }, a)).toBe(true)
    expect(evaluateFormRule({ field: 's', op: 'ne', value: 'erp' }, a)).toBe(true)
    expect(evaluateFormRule({ field: 's', op: 'gt', value: 'a' }, a)).toBe(false)
  })

  it('il sì/no si confronta come «true»/«false», e «contiene» ignora le maiuscole', () => {
    expect(evaluateFormRule({ field: 'u', op: 'eq', value: 'true' }, { u: true })).toBe(true)
    expect(evaluateFormRule({ field: 'm', op: 'contains', value: 'PRO' }, { m: 'MacBook Pro' })).toBe(true)
  })

  it('«tutte» e «almeno una»; nessuna condizione = visibile', () => {
    const answers = { a: '1', b: '2' }
    const tutte: FormCondition = { match: 'all', rules: [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '9' }] }
    const almeno: FormCondition = { match: 'any', rules: [{ field: 'a', op: 'eq', value: '1' }, { field: 'b', op: 'eq', value: '9' }] }
    expect(evaluateFormCondition(tutte, answers)).toBe(false)
    expect(evaluateFormCondition(almeno, answers)).toBe(true)
    expect(evaluateFormCondition(undefined, answers)).toBe(true)
  })
})

describe('parseCatalogForm', () => {
  it('assente o vuoto = nessun modulo (non un errore)', () => {
    expect(parseCatalogForm(null, 'x')).toBeNull()
    expect(parseCatalogForm('', 'x')).toBeNull()
  })

  it('un modulo appena creato si rilegge identico', () => {
    const vuoto = emptyCatalogForm()
    expect(parseCatalogForm(JSON.stringify(vuoto), 'x')).toEqual(vuoto)
  })

  it('JSON corrotto, chiavi mancanti o versione dal futuro: errore, mai un modulo vuoto', () => {
    expect(() => parseCatalogForm('{non json', 'x')).toThrow(/not valid JSON/)
    expect(() => parseCatalogForm(JSON.stringify({ version: 1, sections: [] }), 'x')).toThrow(/has no revision/)
    expect(() => parseCatalogForm(JSON.stringify({ version: 99, revision: 1, sections: [] }), 'x')).toThrow(/version 99/)
    expect(() => parseCatalogForm(JSON.stringify({ version: 1, revision: -1, sections: [] }), 'x')).toThrow(/revision must be/)
  })

  it('una condizione senza regole è rifiutata: «sempre» e «mai» sarebbero indistinguibili', () => {
    const def = { version: 1, revision: 1, sections: [{ id: 'a', title: {}, items: [{ field: 'modello', visibleWhen: { match: 'all', rules: [] } }] }] }
    expect(() => parseCatalogForm(JSON.stringify(def), 'x')).toThrow(/at least one rule/)
  })

  it('operatore sconosciuto, valore mancante, id di sezione sbagliato', () => {
    const conRegola = (rule: unknown) => JSON.stringify({ version: 1, revision: 1, sections: [{ id: 'a', title: {}, items: [{ field: 'modello', visibleWhen: { match: 'all', rules: [rule] } }] }] })
    expect(() => parseCatalogForm(conRegola({ field: 'costo', op: 'maggiore', value: '1' }), 'x')).toThrow(/unknown operator/)
    expect(() => parseCatalogForm(conRegola({ field: 'costo', op: 'eq' }), 'x')).toThrow(/needs a value/)
    // `filled` non vuole un valore: passa.
    expect(() => parseCatalogForm(conRegola({ field: 'costo', op: 'filled' }), 'x')).not.toThrow()
    expect(() => parseCatalogForm(JSON.stringify({ version: 1, revision: 1, sections: [{ id: 'Sezione 1', title: {}, items: [] }] }), 'x')).toThrow(/section id/)
  })
})

describe('assertCatalogForm', () => {
  it('il modulo di prova è valido', () => {
    expect(() => assertCatalogForm(moduloDiProva(), LIBRERIA)).not.toThrow()
  })

  it('un campo che non è in libreria', () => {
    const def = { ...moduloDiProva(), sections: [{ id: 'a', title: {}, items: [{ field: 'inventato' }] }] }
    expect(() => assertCatalogForm(def, LIBRERIA)).toThrow(/not in the field library/)
  })

  it('lo stesso campo due volte scriverebbe due volte la stessa proprietà', () => {
    const def = { ...moduloDiProva(), sections: [{ id: 'a', title: {}, items: [{ field: 'modello' }, { field: 'modello' }] }] }
    expect(() => assertCatalogForm(def, LIBRERIA)).toThrow(/appears twice/)
  })

  it('una condizione che guarda un campo non presente nel modulo non potrebbe mai diventare vera', () => {
    const def = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [{ field: 'modello', visibleWhen: { match: 'all', rules: [{ field: 'costo', op: 'gt', value: '10' }] } }] }],
    } as CatalogFormDefinition
    expect(() => assertCatalogForm(def, LIBRERIA)).toThrow(/could never become true/)
  })

  it('una nota non porta risposta: non può essere obbligatoria né essere il soggetto di una condizione', () => {
    const obbligatoria = { version: 1, revision: 1, sections: [{ id: 'a', title: {}, items: [{ field: 'istruzioni', required: true }] }] } as CatalogFormDefinition
    expect(() => assertCatalogForm(obbligatoria, LIBRERIA)).toThrow(/carries no answer/)
    const soggetto = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [{ field: 'istruzioni' }, { field: 'modello', visibleWhen: { match: 'all', rules: [{ field: 'istruzioni', op: 'filled' }] } }] }],
    } as CatalogFormDefinition
    expect(() => assertCatalogForm(soggetto, LIBRERIA)).toThrow(/only fields stored as a property/)
  })

  it('due sezioni con lo stesso identificativo', () => {
    const def = { version: 1, revision: 1, sections: [{ id: 'a', title: {}, items: [] }, { id: 'a', title: {}, items: [] }] } as CatalogFormDefinition
    expect(() => assertCatalogForm(def, LIBRERIA)).toThrow(/have the id/)
  })
})

describe('visibleFormItems', () => {
  it('il campo condizionato compare solo con la risposta che lo accende', () => {
    const def = moduloDiProva()
    const senza = visibleFormItems(def, { tipo_dispositivo: 'fisso' }).map((i) => i.field)
    expect(senza).not.toContain('costo')
    const con = visibleFormItems(def, { tipo_dispositivo: 'portatile' }).map((i) => i.field)
    expect(con).toContain('costo')
  })

  it('dal portale i campi non offerti agli utenti finali non ci sono', () => {
    const def = moduloDiProva()
    expect(visibleFormItems(def, {}).map((i) => i.field)).toContain('urgente')
    expect(visibleFormItems(def, {}, { endUser: true }).map((i) => i.field)).not.toContain('urgente')
  })
})

describe('resolveFormWrites', () => {
  const session = {} as never
  const risposte = (m: Record<string, string | string[]>) =>
    Object.entries(m).map(([name, v]) => (Array.isArray(v) ? { name, values: v } : { name, value: v }))

  beforeEach(() => { vi.mocked(runValidationScript).mockClear() })

  it('converte i tipi e scrive le proprietà', async () => {
    const out = (await resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'portatile', modello: 'MacBook Pro', costo: '1800',
      centro_di_costo: 'CC-12', urgente: 'true',
    }))).props
    expect(out).toEqual({
      tipo_dispositivo: 'portatile', modello: 'MacBook Pro', costo: 1800,
      centro_di_costo: 'CC-12', urgente: true,
    })
  })

  it('SICUREZZA: un campo nascosto da una condizione che arriva comunque è rifiutato', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'fisso', centro_di_costo: 'CC-1', costo: '5000',
    }))).rejects.toThrow(/hidden by a condition/)
  })

  it('SICUREZZA: dal portale un campo non offerto agli utenti finali è rifiutato', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'fisso', centro_di_costo: 'CC-1', urgente: 'true',
    }), { endUser: true })).rejects.toThrow(/hidden by a condition|not offered here/)
  })

  /*
   * IL VARCO DELLA FORMA (chiuso il 17 set 2026, ondata 1 del rimedio).
   *
   * `formAnswerMap` preferisce `values` a `value` anche quando la lista è
   * VUOTA, mentre la scrittura di un campo a valore singolo legge `value`:
   * mandando le due cose insieme si otteneva un campo che per le CONDIZIONI
   * era vuoto e per il TICKET valeva. Il costo diventava 5000 e
   * `centro_di_costo`, obbligatorio solo quando il costo supera i mille, non
   * veniva mai chiesto.
   */
  it('SICUREZZA: `values` su un campo a valore singolo è rifiutato, non preferito', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, [
      { name: 'tipo_dispositivo', value: 'portatile' },
      { name: 'modello', value: 'MacBook Pro' },
      { name: 'costo', value: '5000', values: [] },
    ])).rejects.toThrow(/holds one value/)
  })

  it('SICUREZZA: lo stesso varco non passa nemmeno con una lista piena', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, [
      { name: 'tipo_dispositivo', value: 'portatile', values: ['fisso'] },
    ])).rejects.toThrow(/holds one value/)
  })

  it('e il contrario: una selezione multipla mandata come valore solo è rifiutata', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, [
      { name: 'tipo_dispositivo', value: 'fisso' },
      { name: 'sistemi', value: 'crm' },
    ])).rejects.toThrow(/holds several values/)
  })

  it('un campo che non appartiene al modulo non può scrivere una proprietà del ticket', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, [{ name: 'priority', value: 'P1' }]))
      .rejects.toThrow(/not a field of this form/)
  })

  it('l\'obbligatorio si chiede solo se VISIBILE: il costo nascosto non si chiede, quello visibile sì', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'fisso', centro_di_costo: 'CC-1',
    }))).resolves.toMatchObject({ props: { tipo_dispositivo: 'fisso' } })

    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'portatile', centro_di_costo: 'CC-1',
    }))).rejects.toThrow(/is required/)
  })

  it('l\'obbligatorietà della libreria vale anche senza sovrascrittura del modulo', async () => {
    // `centro_di_costo` è obbligatorio in libreria e il modulo non dice niente.
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({ tipo_dispositivo: 'fisso' })))
      .rejects.toThrow(/is required/)
  })

  it('il vocabolario è verificato, per la scelta singola e per quella multipla', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'astronave', centro_di_costo: 'CC-1',
    }))).rejects.toThrow(/is not a value of/)

    const conSistemi: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [{ field: 'sistemi' }] }],
    }
    await expect(resolveFormWrites(session, 't1', conSistemi, LIBRERIA, risposte({ sistemi: ['posta', 'inventato'] })))
      .rejects.toThrow(/is not a value of/)
    await expect(resolveFormWrites(session, 't1', conSistemi, LIBRERIA, risposte({ sistemi: ['posta', 'crm', 'posta'] })))
      .resolves.toMatchObject({ props: { sistemi: ['posta', 'crm'] } })
  })

  it('un numero che non è un numero, una data che non è una data', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'portatile', centro_di_costo: 'CC-1', costo: 'tanto',
    }))).rejects.toThrow(/is a number/)

    const conData: CatalogFormDefinition = { version: 1, revision: 1, sections: [{ id: 'a', title: {}, items: [{ field: 'data_inizio' }] }] }
    await expect(resolveFormWrites(session, 't1', conData, LIBRERIA, risposte({ data_inizio: 'domani' })))
      .rejects.toThrow(/is a date/)
  })

  it('lo script di validazione gira sui soli campi visibili e compilati, e il suo rifiuto arriva a chi compila', async () => {
    const libreriaConScript = new Map(LIBRERIA)
    libreriaConScript.set('costo', campo('costo', 'number', { validationScript: 'if (value > 5000) throw new Error("troppo")' }))
    vi.mocked(runValidationScript).mockResolvedValueOnce('troppo')
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), libreriaConScript, risposte({
      tipo_dispositivo: 'portatile', centro_di_costo: 'CC-1', costo: '9000',
    }))).rejects.toThrow(/was refused: troppo/)

    // Con il costo nascosto lo script non viene nemmeno chiamato.
    vi.mocked(runValidationScript).mockClear()
    await resolveFormWrites(session, 't1', moduloDiProva(), libreriaConScript, risposte({
      tipo_dispositivo: 'fisso', centro_di_costo: 'CC-1',
    }))
    expect(runValidationScript).not.toHaveBeenCalled()
  })

  it('una nota non accetta risposte', async () => {
    await expect(resolveFormWrites(session, 't1', moduloDiProva(), LIBRERIA, risposte({
      tipo_dispositivo: 'fisso', centro_di_costo: 'CC-1', istruzioni: 'ciao',
    }))).rejects.toThrow(/carries no answer/)
  })

  it('catalogFormFieldNames elenca i campi nell\'ordine del modulo', () => {
    expect(catalogFormFieldNames(moduloDiProva())).toEqual([
      'tipo_dispositivo', 'modello', 'costo', 'centro_di_costo', 'istruzioni', 'urgente',
    ])
  })
})

// ── Ondata 2: allegati e riferimenti ────────────────────────────────────────

describe('ondata 2: riferimenti e allegati', () => {
  const session = {} as never
  const moduloRif: CatalogFormDefinition = {
    version: 1, revision: 1,
    sections: [{ id: 'a', title: {}, items: [{ field: 'dispositivo', endUser: false }, { field: 'per_chi', endUser: false, required: true }] }],
  }
  const moduloFile: CatalogFormDefinition = {
    version: 1, revision: 1,
    sections: [{ id: 'a', title: {}, items: [{ field: 'preventivo', required: true }] }],
  }

  it('un riferimento NON si offre nel portale: il modulo che lo offre viene rifiutato alla pubblicazione', () => {
    const offerto: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [{ field: 'dispositivo' }] }],
    }
    expect(() => assertCatalogForm(offerto, LIBRERIA)).toThrow(/cannot be offered in the portal/)
    // Con la spunta togliata passa.
    expect(() => assertCatalogForm(moduloRif, LIBRERIA)).not.toThrow()
  })

  it('una condizione non può guardare un allegato né un riferimento', () => {
    const suFile: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 'a', title: {}, items: [
        { field: 'preventivo' },
        { field: 'modello', visibleWhen: { match: 'all', rules: [{ field: 'preventivo', op: 'filled' }] } },
      ] }],
    }
    expect(() => assertCatalogForm(suFile, LIBRERIA)).toThrow(/only fields stored as a property/)
  })

  it('un riferimento diventa una relazione, non una proprietà: nessun valore scritto sul ticket', async () => {
    const esito = await resolveFormWrites(session, 't1', moduloRif, LIBRERIA,
      [{ name: 'dispositivo', refIds: ['ci-1'] }, { name: 'per_chi', refIds: ['u-1'] }])
    expect(esito.props).toEqual({})
    expect(esito.references).toEqual([
      { field: 'dispositivo', fieldType: 'ref_ci', ids: ['ci-1'] },
      { field: 'per_chi', fieldType: 'ref_user', ids: ['u-1'] },
    ])
  })

  it('un riferimento a qualcosa che non esiste nel tenant è rifiutato', async () => {
    await expect(resolveFormWrites(session, 't1', moduloRif, LIBRERIA,
      [{ name: 'dispositivo', refIds: ['inventato'] }, { name: 'per_chi', refIds: ['u-1'] }]))
      .rejects.toThrow(/does not exist here/)
  })

  it('un riferimento obbligatorio mancante è rifiutato; due id su un campo che ne prende uno pure', async () => {
    await expect(resolveFormWrites(session, 't1', moduloRif, LIBRERIA, [{ name: 'dispositivo', refIds: ['ci-1'] }]))
      .rejects.toThrow(/is required/)
    await expect(resolveFormWrites(session, 't1', moduloRif, LIBRERIA,
      [{ name: 'per_chi', refIds: ['u-1', 'u-2'] }]))
      .rejects.toThrow(/takes one reference/)
  })

  it('un allegato obbligatorio: senza file sulla bozza è rifiutato, con un file passa', async () => {
    await expect(resolveFormWrites(session, 't1', moduloFile, LIBRERIA, [], { draftId: 'd-1', userId: 'u-1' }))
      .rejects.toThrow(/needs at least one file/)

    contaFileBozza = 2
    const esito = await resolveFormWrites(session, 't1', moduloFile, LIBRERIA, [], { draftId: 'd-1', userId: 'u-1' })
    expect(esito.props).toEqual({})
    expect(esito.attachmentFields).toEqual([{ field: 'preventivo', label: 'preventivo', required: true, count: 2 }])
    contaFileBozza = 0
  })

  it('senza bozza un allegato obbligatorio è rifiutato: non si finge che i file ci siano', async () => {
    await expect(resolveFormWrites(session, 't1', moduloFile, LIBRERIA, []))
      .rejects.toThrow(/needs at least one file/)
  })

  it('un allegato non accetta un valore di testo come risposta', async () => {
    contaFileBozza = 1
    const esito = await resolveFormWrites(session, 't1', moduloFile, LIBRERIA,
      [{ name: 'preventivo', value: 'non-un-file' }], { draftId: 'd-1', userId: 'u-1' })
    // Il valore viene ignorato: un allegato non è una proprietà.
    expect(esito.props).toEqual({})
    contaFileBozza = 0
  })
})

/**
 * I CAMPI CALCOLATI (ondata 6). Le tre cose che, sbagliate, non si vedrebbero:
 * il valore lo decide il SERVER (non il client), la formula NON vede gli altri
 * campi calcolati (così i cicli non esistono), e una formula che fallisce
 * FERMA il salvataggio nominando il campo — la scelta del proprietario.
 */
describe('campi calcolati', () => {
  // Nessuna lettura sul grafo in questi casi: la sessione non serve.
  const session = {} as never
  const definizione = (campi: string[]): CatalogFormDefinition => ({
    version: 1, revision: 1,
    sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: campi.map((f) => ({ field: f })) }],
  })

  // `clearAllMocks`: i conteggi delle chiamate sono per singolo caso, altrimenti
  // «non è stata chiamata» conterebbe anche le chiamate dei casi precedenti.
  beforeEach(() => { formulaFallisce = null; formule.length = 0; vi.clearAllMocks() })

  const libreria = (over: Record<string, unknown> = {}) => new Map(Object.entries({
    costo: campo('costo', 'number'),
    totale: campo('totale', 'number', { formula: 'costo' }),
    ...over,
  }))

  it('il valore viene dalla formula, non da chi compila: il client non lo manda affatto', async () => {
    const def = definizione(['costo', 'totale'])
    const r = await resolveFormWrites(session, 't1', def, libreria(), [{ name: 'costo', value: '120' }])
    expect(r.props['totale']).toBe(120)
    expect(runFormulaScript).toHaveBeenCalledTimes(1)
  })

  /*
   * ── LA DECISIONE DEL 17 SET 2026 ───────────────────────────────────────────
   *
   * Una condizione può guardare un campo CALCOLATO. Il difetto che questo
   * chiude era stato riprodotto nel browser: il costruttore offriva il campo
   * calcolato come soggetto, il browser mostrava il campo condizionato (lì il
   * valore calcolato c'è), e il server rifiutava con «non viene chiesto con
   * queste risposte» — perché calcolava la visibilità PRIMA delle formule.
   * Quella richiesta non si poteva creare, mai.
   */
  it('una condizione su un campo CALCOLATO si valuta: il campo condizionato si accetta', async () => {
    const lib = libreria({ giustificazione: campo('giustificazione', 'text') })
    const def: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [
        { field: 'costo' },
        { field: 'totale' },
        { field: 'giustificazione', required: true, visibleWhen: { logic: 'and', rules: [{ field: 'totale', op: 'gt', value: '1000' }] } },
      ] }],
    }
    // `totale` = formula su `costo`: 5000 > 1000, quindi la giustificazione si chiede.
    const r = await resolveFormWrites(session, 't1', def, lib, [
      { name: 'costo', value: '5000' }, { name: 'giustificazione', value: 'Sostituzione urgente' },
    ])
    expect(r.props['totale']).toBe(5000)
    expect(r.props['giustificazione']).toBe('Sostituzione urgente')
  })

  it('e sotto la soglia quel campo non è chiesto: chi lo manda comunque è rifiutato', async () => {
    const lib = libreria({ giustificazione: campo('giustificazione', 'text') })
    const def: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [
        { field: 'costo' },
        { field: 'totale' },
        { field: 'giustificazione', required: true, visibleWhen: { logic: 'and', rules: [{ field: 'totale', op: 'gt', value: '1000' }] } },
      ] }],
    }
    // 10 → totale 10: la giustificazione non si chiede, e non è obbligatoria.
    await expect(resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: '10' }]))
      .resolves.toMatchObject({ props: { totale: 10 } })
    // Mandarla comunque resta un varco, come per ogni campo nascosto.
    await expect(resolveFormWrites(session, 't1', def, lib, [
      { name: 'costo', value: '10' }, { name: 'giustificazione', value: 'x' },
    ])).rejects.toThrow(/hidden by a condition/)
  })

  it('una formula rotta su un campo che NESSUNO vede non rompe la richiesta', async () => {
    formulaFallisce = 'ReferenceError: quantita is not defined'
    const lib = libreria()
    const def: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [
        { field: 'costo' },
        // visibile solo sopra i mille: con costo 10 resta fuori
        { field: 'totale', visibleWhen: { logic: 'and', rules: [{ field: 'costo', op: 'gt', value: '1000' }] } },
      ] }],
    }
    const r = await resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: '10' }])
    expect(r.props['costo']).toBe(10)
    expect(r.props['totale']).toBeUndefined()
  })

  it('un client che manda un campo calcolato viene RIFIUTATO, non ignorato', async () => {
    const def = definizione(['costo', 'totale'])
    await expect(resolveFormWrites(session, 't1', def, libreria(), [
      { name: 'costo', value: '120' }, { name: 'totale', value: '999' },
    ])).rejects.toThrow(/is computed/)
  })

  it('la formula NON vede gli altri campi calcolati: niente catene, quindi niente cicli', async () => {
    const lib = libreria({ secondo: campo('secondo', 'number', { formula: 'totale' }) })
    const def = definizione(['costo', 'totale', 'secondo'])
    const r = await resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: '7' }])
    expect(r.props['totale']).toBe(7)
    // `secondo` chiede `totale`, che è calcolato: per la formula non esiste.
    expect(r.props['secondo']).toBeNull()
  })

  it('formula che fallisce: il salvataggio si ferma e il messaggio nomina il campo', async () => {
    formulaFallisce = 'ReferenceError: quantita is not defined'
    const def = definizione(['costo', 'totale'])
    await expect(resolveFormWrites(session, 't1', def, libreria(), [{ name: 'costo', value: '1' }]))
      .rejects.toThrow(/formula of field "totale" failed: ReferenceError/)
  })

  it('il risultato passa dalle regole di tutti: un numero che non è un numero viene rifiutato', async () => {
    const lib = libreria({ costo: campo('costo', 'text'), totale: campo('totale', 'number', { formula: 'costo' }) })
    const def = definizione(['costo', 'totale'])
    await expect(resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: 'pippo' }]))
      .rejects.toThrow(/is a number, "pippo" is not/)
  })

  /*
   * Un campo calcolato NASCOSTO non si SCRIVE: la domanda non è stata fatta.
   *
   * Fino al 17 set 2026 non si calcolava nemmeno. Poi il proprietario ha
   * deciso che una condizione può guardare un campo calcolato («chiedi la
   * giustificazione se il totale supera mille»), e per valutarla il valore
   * deve esistere: ora la formula gira per ogni campo calcolato che il modulo
   * cita, e la visibilità decide solo cosa finisce sul ticket. Il prezzo della
   * decisione è un giro di sandbox per campo calcolato a ogni salvataggio.
   */
  it('un campo calcolato NASCOSTO da una condizione non si scrive, ma si calcola (le condizioni lo guardano)', async () => {
    const lib = libreria()
    const def: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [
        { field: 'costo' },
        { field: 'totale', visibleWhen: { logic: 'and', rules: [{ field: 'costo', op: 'gt', value: '1000' }] } },
      ] }],
    }
    const r = await resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: '10' }])
    expect(r.props['totale']).toBeUndefined()
    expect(runFormulaScript).toHaveBeenCalledTimes(1)
  })

  it('calcolato e OBBLIGATORIO: se la formula non produce niente, il salvataggio si ferma come per un campo vuoto', async () => {
    const lib = libreria({ totale: campo('totale', 'number', { formula: 'inesistente', required: true }) })
    const def = definizione(['costo', 'totale'])
    await expect(resolveFormWrites(session, 't1', def, lib, [{ name: 'costo', value: '5' }]))
      .rejects.toThrow(/required/)
  })
})

/**
 * LA TABELLA RIPETIBILE (ondata 7). Le cose che, sbagliate, non si vedrebbero:
 * una riga vuota che diventa un dato, una colonna sconosciuta accettata in
 * silenzio, e l'ORDINE — che è l'unica cosa che distingue «la prima persona
 * dell'elenco» da «una delle persone».
 */
describe('tabelle ripetibili', () => {
  const session = {} as never
  const colonne = {
    version: 1,
    columns: [
      { name: 'persona', labels: { it: 'Persona' }, fieldType: 'text', required: true },
      { name: 'ruolo', labels: { it: 'Ruolo' }, fieldType: 'enum', vocabulary: 'device_kind' },
      { name: 'giorni', labels: { it: 'Giorni' }, fieldType: 'number' },
    ],
  }
  const lib = new Map<string, never>([['persone', campo('persone', 'table', { tableDefinition: colonne })]])
  const def: CatalogFormDefinition = {
    version: 1, revision: 1,
    sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [{ field: 'persone' }] }],
  }
  const righe = (rows: Array<Record<string, string | null>>) => [{ name: 'persone', rows }]

  it('le righe piene si scrivono nell\'ordine arrivato, le vuote si scartano', async () => {
    const r = await resolveFormWrites(session, 't1', def, lib, righe([
      { persona: 'Ada', ruolo: 'portatile', giorni: '3' },
      { persona: '', ruolo: '', giorni: '' },
      { persona: 'Grace', ruolo: 'fisso', giorni: '1' },
    ]), { maxTableRows: 10 })
    expect(r.tables).toHaveLength(1)
    expect(r.tables[0]!.rows.map((x) => x['persona'])).toEqual(['Ada', 'Grace'])
    // Una tabella NON diventa una proprietà del ticket: è il senso di tutto.
    expect(r.props['persone']).toBeUndefined()
  })

  it('una colonna obbligatoria vuota ferma il salvataggio, e il messaggio dice QUALE RIGA', async () => {
    await expect(resolveFormWrites(session, 't1', def, lib, righe([
      { persona: 'Ada', ruolo: 'portatile', giorni: '1' },
      { persona: '', ruolo: 'fisso', giorni: '2' },
    ]), { maxTableRows: 10 })).rejects.toThrow(/Row 2 .*"Persona" is required/)
  })

  it('una colonna che la tabella non ha viene RIFIUTATA, non ignorata', async () => {
    await expect(resolveFormWrites(session, 't1', def, lib, righe([{ persona: 'Ada', stipendio: '9000' }]), { maxTableRows: 10 }))
      .rejects.toThrow(/has no column "stipendio"/)
  })

  it('le celle passano dal tipo della colonna: numero, data e vocabolario', async () => {
    await expect(resolveFormWrites(session, 't1', def, lib, righe([{ persona: 'Ada', giorni: 'molti' }]), { maxTableRows: 10 }))
      .rejects.toThrow(/"molti" is not a number/)
    await expect(resolveFormWrites(session, 't1', def, lib, righe([{ persona: 'Ada', ruolo: 'imperatrice' }]), { maxTableRows: 10 }))
      .rejects.toThrow(/is not a value of "Ruolo"/)
  })

  it('il tetto sulle righe conta solo quelle PIENE: dieci clic a vuoto non riempiono la tabella', async () => {
    const vuote = Array.from({ length: 8 }, () => ({ persona: '', ruolo: '', giorni: '' }))
    const r = await resolveFormWrites(session, 't1', def, lib, righe([...vuote, { persona: 'Ada' }]), { maxTableRows: 2 })
    expect(r.tables[0]!.rows).toHaveLength(1)
    await expect(resolveFormWrites(session, 't1', def, lib, righe([{ persona: 'a' }, { persona: 'b' }, { persona: 'c' }]), { maxTableRows: 2 }))
      .rejects.toThrow(/at most 2 rows, 3 were sent/)
  })

  it('tabella OBBLIGATORIA senza righe piene: si ferma come un campo lasciato vuoto', async () => {
    const obbligatoria: CatalogFormDefinition = {
      version: 1, revision: 1,
      sections: [{ id: 's1', title: [{ language: 'it', label: 'S' }], items: [{ field: 'persone', required: true }] }],
    }
    await expect(resolveFormWrites(session, 't1', obbligatoria, lib, righe([{ persona: '' }]), { maxTableRows: 10 }))
      .rejects.toThrow(/needs at least one row/)
  })

  it('un campo tabella senza colonne è un errore di CONFIGURAZIONE, detto con il nome del campo', async () => {
    const senzaColonne = new Map<string, never>([['persone', campo('persone', 'table')]])
    await expect(resolveFormWrites(session, 't1', def, senzaColonne, righe([{ persona: 'Ada' }]), { maxTableRows: 10 }))
      .rejects.toThrow(/is a table but has no columns/)
  })
})


/**
 * COSA PUÒ SCRIVERE UN'AUTOMAZIONE (ondata 8).
 *
 * La regola sta in un posto solo perché la leggono tre lati che devono dire la
 * stessa cosa: la tendina che OFFRE il campo, la validazione che ACCETTA la
 * regola, e la scrittura. Quando erano due, la tendina offriva
 * `modello_richiesto` e il salvataggio rispondeva «non è un campo di questo
 * tipo di ticket» — visto dal vivo su c-test.
 */
describe('scrivibile da un\'automazione', () => {
  const campo = (extra: Record<string, unknown>) => ({
    id: 'x', name: 'x', label: 'X', labels: [], help: null, helps: [], required: false,
    vocabulary: null, validationScript: null, formula: null, inList: false, tableDefinition: null,
    ...extra,
  }) as never

  it('sì per testo, numero, data, sì/no e scelta singola', () => {
    for (const fieldType of ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'enum']) {
      expect(settableByAutomation(campo({ fieldType })), fieldType).toBe(true)
    }
  })

  it('no per un campo CALCOLATO: il valore lo fa la formula', () => {
    expect(settableByAutomation(campo({ fieldType: 'number', formula: 'return 1' }))).toBe(false)
  })

  it('no per la scelta MULTIPLA: sul nodo è una lista', () => {
    expect(settableByAutomation(campo({ fieldType: 'multi_enum' }))).toBe(false)
  })

  it('no per quello che non diventa una proprietà (note, allegati, riferimenti, tabelle)', () => {
    for (const fieldType of ['note', 'attachment', 'ref_ci', 'ref_user', 'ref_team', 'table']) {
      expect(settableByAutomation(campo({ fieldType })), fieldType).toBe(false)
    }
  })
})

describe('formFieldAutomationMetas', () => {
  it('solo per le richieste: gli altri tipi di ticket non compilano moduli', async () => {
    expect((await formFieldAutomationMetas({} as never, 't1', 'incident')).size).toBe(0)
    expect((await formFieldAutomationMetas({} as never, 't1', 'change')).size).toBe(0)
  })
})


/**
 * IL MODULO COME LO VEDE L'UTENTE FINALE (ondata 1 del rimedio del 17 set 2026).
 *
 * Il difetto: `catalogFormToFill` dichiarava `endUser` e non lo leggeva, quindi
 * al portale arrivavano le voci «solo area di lavoro» con etichette, aiuti e le
 * formule dei campi. Il filtro stava solo nel renderer. Qui si tiene fermo che
 * la definizione esca già filtrata.
 */
describe('catalogFormForEndUser', () => {
  const modulo = (): CatalogFormDefinition => ({
    version: 1, revision: 4,
    sections: [
      { id: 'a', title: { it: 'Il dispositivo' }, items: [
        { field: 'modello' },
        { field: 'ambiente', endUser: true },
        { field: 'costo_interno', endUser: false },
      ] },
      { id: 'b', title: { it: 'Solo per noi' }, items: [
        { field: 'approvazione_diretta', endUser: false },
      ] },
    ],
  })

  it('toglie le voci non offerte nel portale e lascia le altre', () => {
    const out = catalogFormForEndUser(modulo())
    expect(catalogFormFieldNames(out)).toEqual(['modello', 'ambiente'])
  })

  it('toglie la sezione che resta senza voci: il suo titolo è comunque un dato interno', () => {
    const out = catalogFormForEndUser(modulo())
    expect(out.sections.map((s) => s.id)).toEqual(['a'])
  })

  it('senza `endUser` una voce è offerta: assente vuol dire sì', () => {
    const out = catalogFormForEndUser({ version: 1, revision: 1, sections: [
      { id: 'a', title: {}, items: [{ field: 'x' }] },
    ] })
    expect(catalogFormFieldNames(out)).toEqual(['x'])
  })

  it('la revisione non cambia: è il numero che il ticket porta', () => {
    expect(catalogFormForEndUser(modulo()).revision).toBe(4)
    expect(catalogFormForEndUser(modulo()).version).toBe(1)
  })

  it('un modulo tutto interno resta senza sezioni (il chiamante offre la richiesta generica)', () => {
    const out = catalogFormForEndUser({ version: 1, revision: 2, sections: [
      { id: 'a', title: { it: 'Interna' }, items: [{ field: 'x', endUser: false }] },
    ] })
    expect(out.sections).toEqual([])
  })

  it('non tocca il documento di partenza', () => {
    const dato = modulo()
    catalogFormForEndUser(dato)
    expect(catalogFormFieldNames(dato)).toEqual(['modello', 'ambiente', 'costo_interno', 'approvazione_diretta'])
  })
})


/**
 * LA VISIBILITÀ È UNA FUNZIONE SOLA (revisione del 17 set 2026).
 *
 * Era scritta tre volte — server, renderer, e una copia in linea nel corpo del
 * render — e condiviso c'era solo il valutatore di una singola condizione. Ora
 * `formItemsToFill` vive in `@opengraphity/types` e la richiamano entrambi:
 * `visibleFormItems` (API) e `visibleCatalogFormItems` (web-core) sono due nomi
 * per la stessa cosa. Questo test tiene fermo il lato server; il renderer
 * delega alla stessa funzione, quindi la parità non è più una promessa scritta
 * in un commento.
 */
describe('formItemsToFill: una sorgente sola per la visibilità', () => {
  const def: CatalogFormDefinition = {
    version: 1, revision: 3,
    sections: [
      { id: 'a', title: { it: 'Sempre' }, items: [
        { field: 'tipo' },
        { field: 'costo', visibleWhen: { match: 'all', rules: [{ field: 'tipo', op: 'eq', value: 'portatile' }] } },
        { field: 'interno', endUser: false },
      ] },
      { id: 'b', title: { it: 'Solo per i grandi importi' },
        visibleWhen: { match: 'all', rules: [{ field: 'costo', op: 'gt', value: '1000' }] },
        items: [{ field: 'giustificazione' }] },
    ],
  }

  it('`visibleFormItems` dell\'API è `formItemsToFill`: stesso elenco, stessi argomenti', () => {
    for (const risposte of [
      {},
      { tipo: 'portatile' },
      { tipo: 'portatile', costo: 5000 },
      { tipo: 'fisso', costo: 5000 },
    ]) {
      expect(visibleFormItems(def, risposte).map((i) => i.field))
        .toEqual(formItemsToFill(def, risposte).map((i) => i.field))
      expect(visibleFormItems(def, risposte, { endUser: true }).map((i) => i.field))
        .toEqual(formItemsToFill(def, risposte, { endUser: true }).map((i) => i.field))
    }
  })

  it('una condizione di SEZIONE su un valore calcolato apre la sezione', () => {
    // `costo` qui è il valore che la formula ha prodotto: per la visibilità è
    // una risposta come le altre, ed è il punto della decisione del 17 set.
    expect(formItemsToFill(def, { tipo: 'portatile', costo: 5000 }).map((i) => i.field))
      .toEqual(['tipo', 'costo', 'interno', 'giustificazione'])
    expect(formItemsToFill(def, { tipo: 'portatile', costo: 10 }).map((i) => i.field))
      .toEqual(['tipo', 'costo', 'interno'])
  })

  it('dal portale le voci dell\'area di lavoro non si chiedono', () => {
    expect(formItemsToFill(def, { tipo: 'portatile' }, { endUser: true }).map((i) => i.field))
      .toEqual(['tipo', 'costo'])
  })
})
