/**
 * SCRIVERE UNA RISPOSTA DI MODULO DA UN'AUTOMAZIONE (ondata 8).
 *
 * Qui stanno le cinque regole decise dal proprietario, e sono tutte «no»
 * tranne una: sono quelle che distinguono un'automazione che risponde a una
 * domanda da un'automazione che scrive una proprietà a caso.
 *
 * Il valore lo scrive `SET r += $props`, quindi non c'è Cypher da verificare
 * qui (ci pensa `check-cypher`): quello che si fissa è COSA VIENE RIFIUTATO.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CatalogFormDefinition } from '@opengraphity/types'

vi.mock('../vocabularyEntries.js', () => ({
  loadVocabularyEntries: vi.fn(async () => ({ values: ['produzione', 'collaudo'], labels: {}, colors: {} })),
}))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it'), languageForUser: vi.fn(async () => 'it') }))

/** Lo script di validazione: per difetto accetta; un test lo fa rifiutare. */
let rifiutoDelloScript: string | null = null
/** La formula finta: `input.<campo> * 2`, così si vede che ha riletto il valore nuovo. */
vi.mock('../metamodelScript.js', () => ({
  runValidationScript: vi.fn(async () => rifiutoDelloScript),
  runFormulaScript: vi.fn(async (_code: string, input: Record<string, unknown>) => ({
    ok: true, value: Number(input['costo_stimato'] ?? 0) * 2,
  })),
}))

/** Le proprietà del ticket, la libreria e la revisione congelata: le decide ogni caso. */
let propsTicket: Record<string, unknown> | null = {}
let revisioneCongelata: CatalogFormDefinition | null = null
let libreriaRighe: Array<Record<string, unknown>> = []
const scritture: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, query: string, params?: Record<string, unknown>) => {
    if (query.includes('MATCH (f:FormField')) return libreriaRighe
    if (query.includes('CatalogFormRevision')) {
      return revisioneCongelata ? [{ definition: JSON.stringify(revisioneCongelata) }] : []
    }
    // Il RICALCOLO dei campi calcolati scrive da qui (una mappa di proprietà):
    // la finta lo registra come le altre scritture, altrimenti un test che
    // pretende il ricalcolo passerebbe anche senza.
    if (query.includes('SET r += $props')) {
      scritture.push(params?.['props'] as Record<string, unknown>)
      return []
    }
    return []
  }),
  runQueryOne: vi.fn(async (_s: unknown, query: string, params?: Record<string, unknown>) => {
    if (query.includes('RETURN properties(r) AS props')) return propsTicket ? { props: propsTicket } : null
    if (query.includes('SET r += $props')) {
      scritture.push(params?.['props'] as Record<string, unknown>)
      return { before: {}, after: { ...propsTicket, ...(params?.['props'] as object) } }
    }
    return null
  }),
}))

const { writeFormAnswerFromAutomation } = await import('../catalogForm.js')

const session = {} as never
const campo = (over: Record<string, unknown> = {}) => ({
  id: 'f1', name: 'ambiente_uso', field_type: 'enum', label: 'Ambiente',
  labels: JSON.stringify({ it: 'Ambiente' }), help: null, helps: null,
  required: false, vocabulary: 'environment', validation_script: null, formula: null,
  table_definition: null, in_list: false, created_at: null, updated_at: null,
  ...over,
})
/** `formFieldsByName` legge con gli alias del RETURN: la finta li rispetta. */
const rigaLibreria = (over: Record<string, unknown> = {}) => {
  const c = campo(over)
  return {
    id: c.id, name: c.name, fieldType: c.field_type, label: c.label, labels: c.labels,
    help: c.help, helps: c.helps, required: c.required, vocabulary: c.vocabulary,
    validationScript: c.validation_script, formula: c.formula,
    tableDefinition: c.table_definition, inList: c.in_list,
    createdAt: c.created_at, updatedAt: c.updated_at,
  }
}

const modulo = (items: Array<Record<string, unknown>>): CatalogFormDefinition => ({
  version: 1, revision: 3,
  sections: [{ id: 's1', title: { it: 'S' }, items: items as never }],
})

beforeEach(() => {
  vi.clearAllMocks()
  scritture.length = 0
  rifiutoDelloScript = null
  libreriaRighe = [rigaLibreria()]
  revisioneCongelata = modulo([{ field: 'ambiente_uso' }])
  propsTicket = { id: 'sr-1', catalog_item_id: 'cat-1', form_revision: 3 }
})

describe('una risposta scritta da una regola', () => {
  it('si scrive, passando dal vocabolario del campo', async () => {
    await writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'produzione')
    expect(scritture).toEqual([{ ambiente_uso: 'produzione' }])
  })

  it('un valore fuori vocabolario si rifiuta: una regola non è più autorevole di un utente', async () => {
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'marte'))
      .rejects.toThrow(/is not a value of/)
    expect(scritture).toHaveLength(0)
  })

  it('lo script di validazione del campo si applica', async () => {
    // Lo script deve ESSERCI sul campo: senza, il codice non lo chiama affatto.
    libreriaRighe = [rigaLibreria({ validation_script: 'if (value === "produzione") throw new Error("no")' })]
    rifiutoDelloScript = 'sopra il tetto'
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/was refused: sopra il tetto/)
  })

  it('un ticket che NON nasce da un modulo: si rifiuta dicendolo', async () => {
    propsTicket = { id: 'sr-1', catalog_item_id: null, form_revision: null }
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/does not come from a catalog form/)
  })

  it('un campo che quel modulo NON chiedeva: si rifiuta (le domande sono quelle di allora)', async () => {
    revisioneCongelata = modulo([{ field: 'modello_richiesto' }])
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/is not asked by the form this request was filled with/)
  })

  it('un campo NASCOSTO da una condizione: si rifiuta, non è stato chiesto', async () => {
    revisioneCongelata = modulo([
      // La condizione vuole `match: "all" | "any"`, non `logic`.
      { field: 'ambiente_uso', visibleWhen: { match: 'all', rules: [{ field: 'urgente', op: 'eq', value: 'true' }] } },
    ])
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/or a condition hides it/)
  })

  it('un campo CALCOLATO: si rifiuta, ha già il suo valore dalla formula', async () => {
    libreriaRighe = [rigaLibreria({ formula: 'return 1', vocabulary: null, field_type: 'number' })]
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', '5'))
      .rejects.toThrow(/is computed/)
  })

  it('quello che non è un valore singolo: si rifiuta (nota, allegato, riferimento, tabella, scelta multipla)', async () => {
    for (const tipo of ['note', 'attachment', 'ref_ci', 'table', 'multi_enum']) {
      libreriaRighe = [rigaLibreria({ field_type: tipo, vocabulary: tipo === 'multi_enum' ? 'environment' : null })]
      await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', 'x'))
        .rejects.toThrow(/is not a single value|is computed/)
    }
  })

  it('svuotare un campo OBBLIGATORIO si rifiuta; svuotarne uno libero si scrive', async () => {
    revisioneCongelata = modulo([{ field: 'ambiente_uso', required: true }])
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', ''))
      .rejects.toThrow(/is required: an automation cannot clear it/)

    revisioneCongelata = modulo([{ field: 'ambiente_uso' }])
    await writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'ambiente_uso', '')
    expect(scritture).toEqual([{ ambiente_uso: null }])
  })

  it('un nome che non è della libreria si rifiuta prima di tutto il resto', async () => {
    libreriaRighe = []
    await expect(writeFormAnswerFromAutomation(session, 't1', 'sr-1', 'inventato', 'x'))
      .rejects.toThrow(/is not a field of the form library/)
  })
})


/**
 * I CAMPI CALCOLATI CHE DIPENDONO DA QUELLO SCRITTO (revisione del 17 set 2026).
 *
 * Al salvataggio del modulo le formule si rieseguono tutte; da un'automazione
 * si scriveva una proprietà e basta, quindi una regola che imposta `quantita`
 * lasciava `costo_totale` al valore di prima — il ticket portava due verità, e
 * il totale sbagliato finiva in filtri, report e widget.
 */
describe('ricalcolo dei campi calcolati', () => {
  beforeEach(() => {
    scritture.length = 0
    rifiutoDelloScript = null
    propsTicket = { catalog_item_id: 'voce-1', form_revision: 3, costo_stimato: 100, costo_totale: 200 }
    libreriaRighe = [
      rigaLibreria({ name: 'costo_stimato', field_type: 'number', label: 'Costo stimato', labels: JSON.stringify({ it: 'Costo stimato' }), vocabulary: null }),
      rigaLibreria({ name: 'costo_totale', field_type: 'number', label: 'Costo totale', labels: JSON.stringify({ it: 'Costo totale' }), vocabulary: null, formula: 'return input.costo_stimato * 2' }),
    ]
    revisioneCongelata = {
      version: 1, revision: 3,
      sections: [{ id: 's', title: { it: 'S' }, items: [{ field: 'costo_stimato' }, { field: 'costo_totale' }] }],
    }
  })

  it('scrivendo il campo da cui dipende, il calcolato si aggiorna', async () => {
    await writeFormAnswerFromAutomation(session, 't1', 'req-1', 'costo_stimato', '500')
    // Due scritture: il valore chiesto, e il ricalcolo.
    expect(scritture).toEqual([{ costo_stimato: 500 }, { costo_totale: 1000 }])
  })

  it('il calcolato resta in sola lettura: scriverlo è ancora un rifiuto', async () => {
    await expect(writeFormAnswerFromAutomation(session, 't1', 'req-1', 'costo_totale', '9'))
      .rejects.toThrow(/is computed/)
  })
})
