/**
 * SCRIVERE UNA RISPOSTA DI MODULO (ondata 8; e dal 17 set 2026 anche da una
 * persona che corregge, che è lo stesso codice e le stesse cinque regole).
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

const { writeFormAnswer } = await import('../catalogForm.js')

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
    await writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'produzione')
    expect(scritture).toEqual([{ ambiente_uso: 'produzione' }])
  })

  it('un valore fuori vocabolario si rifiuta: una regola non è più autorevole di un utente', async () => {
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'marte'))
      .rejects.toThrow(/is not a value of/)
    expect(scritture).toHaveLength(0)
  })

  it('lo script di validazione del campo si applica', async () => {
    // Lo script deve ESSERCI sul campo: senza, il codice non lo chiama affatto.
    libreriaRighe = [rigaLibreria({ validation_script: 'if (value === "produzione") throw new Error("no")' })]
    rifiutoDelloScript = 'sopra il tetto'
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/was refused: sopra il tetto/)
  })

  it('un ticket che NON nasce da un modulo: si rifiuta dicendolo', async () => {
    propsTicket = { id: 'sr-1', catalog_item_id: null, form_revision: null }
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/does not come from a catalog form/)
  })

  it('un campo che quel modulo NON chiedeva: si rifiuta (le domande sono quelle di allora)', async () => {
    revisioneCongelata = modulo([{ field: 'modello_richiesto' }])
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/is not asked by the form this request was filled with/)
  })

  it('un campo NASCOSTO da una condizione: si rifiuta, non è stato chiesto', async () => {
    revisioneCongelata = modulo([
      // La condizione vuole `match: "all" | "any"`, non `logic`.
      { field: 'ambiente_uso', visibleWhen: { match: 'all', rules: [{ field: 'urgente', op: 'eq', value: 'true' }] } },
    ])
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'produzione'))
      .rejects.toThrow(/or a condition hides it/)
  })

  it('un campo CALCOLATO: si rifiuta, ha già il suo valore dalla formula', async () => {
    libreriaRighe = [rigaLibreria({ formula: 'return 1', vocabulary: null, field_type: 'number' })]
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', '5'))
      .rejects.toThrow(/is computed/)
  })

  it('quello che non è un valore singolo: si rifiuta (nota, allegato, riferimento, tabella, scelta multipla)', async () => {
    for (const tipo of ['note', 'attachment', 'ref_ci', 'table', 'multi_enum']) {
      libreriaRighe = [rigaLibreria({ field_type: tipo, vocabulary: tipo === 'multi_enum' ? 'environment' : null })]
      await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', 'x'))
        .rejects.toThrow(/is not a single value|is computed/)
    }
  })

  it('svuotare un campo OBBLIGATORIO si rifiuta; svuotarne uno libero si scrive', async () => {
    revisioneCongelata = modulo([{ field: 'ambiente_uso', required: true }])
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', ''))
      .rejects.toThrow(/is required: it cannot be cleared/)

    revisioneCongelata = modulo([{ field: 'ambiente_uso' }])
    await writeFormAnswer(session, 't1', 'sr-1', 'ambiente_uso', '')
    expect(scritture).toEqual([{ ambiente_uso: null }])
  })

  it('un nome che non è della libreria si rifiuta prima di tutto il resto', async () => {
    libreriaRighe = []
    await expect(writeFormAnswer(session, 't1', 'sr-1', 'inventato', 'x'))
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
    await writeFormAnswer(session, 't1', 'req-1', 'costo_stimato', '500')
    // UNA scrittura, col valore chiesto e il ricalcolo insieme: erano due
    // `SET` in fila, e fra l'uno e l'altro il ticket esisteva con un totale
    // che non tornava coi suoi addendi — letto in quell'istante da un webhook
    // o da una condizione, era una verità falsa.
    expect(scritture).toEqual([{ costo_stimato: 500, costo_totale: 1000 }])
  })

  it('il calcolato resta in sola lettura: scriverlo è ancora un rifiuto', async () => {
    await expect(writeFormAnswer(session, 't1', 'req-1', 'costo_totale', '9'))
      .rejects.toThrow(/is computed/)
  })
})

/**
 * LE RISPOSTE CHE UNA CORREZIONE RENDE NON PIÙ CHIESTE (17 set 2026).
 *
 * Trovato provando dal vivo la correzione di una risposta su `RICH-000022`:
 * correggendo «Ambiente» da Produzione a Sviluppo, «Costo stimato» — che il
 * modulo chiede SOLO in produzione — restava sul nodo con 2000, e il calcolato
 * «Costo totale» con 2440. Il ticket mostrava come risposte due domande che
 * quel modulo, in quella configurazione, non fa; quei numeri finivano in
 * filtri, report, widget e condizioni delle regole; e nessuno li poteva più
 * correggere, perché ormai nascosti il punto 3 li rifiuta — un valore
 * bloccato e sbagliato per sempre.
 *
 * La regola della compilazione è che un campo nascosto non è una risposta:
 * questa vale anche DOPO.
 */
describe('una correzione che nasconde un altro campo', () => {
  const soloInProduzione = {
    version: 1, revision: 3,
    sections: [{ id: 's', title: { it: 'S' }, items: [
      { field: 'ambiente_uso' },
      { field: 'costo_stimato', visibleWhen: { match: 'all', rules: [{ field: 'ambiente_uso', op: 'eq', value: 'produzione' }] } },
      { field: 'costo_totale', visibleWhen: { match: 'all', rules: [{ field: 'costo_stimato', op: 'filled' }] } },
    ] }],
  } as unknown as CatalogFormDefinition

  beforeEach(() => {
    scritture.length = 0
    rifiutoDelloScript = null
    libreriaRighe = [
      rigaLibreria(),
      rigaLibreria({ name: 'costo_stimato', field_type: 'number', label: 'Costo stimato', labels: JSON.stringify({ it: 'Costo stimato' }), vocabulary: null }),
      rigaLibreria({ name: 'costo_totale', field_type: 'number', label: 'Costo totale', labels: JSON.stringify({ it: 'Costo totale' }), vocabulary: null, formula: 'return input.costo_stimato * 2' }),
    ]
    revisioneCongelata = soloInProduzione
    propsTicket = { catalog_item_id: 'voce-1', form_revision: 3, ambiente_uso: 'produzione', costo_stimato: 2000, costo_totale: 4000 }
  })

  it('la risposta che il modulo non chiede più si svuota, invece di restare per sempre', async () => {
    await writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'collaudo')
    // `costo_stimato` non è più chiesto, e con lui cade `costo_totale`: la
    // cascata va a fondo, non si ferma al primo giro. E tutto in una scrittura
    // sola, perché uno stato intermedio è uno stato sbagliato leggibile.
    expect(scritture).toEqual([{ ambiente_uso: 'collaudo', costo_stimato: null, costo_totale: null }])
  })

  it('e il calcolato non viene riscritto col valore di prima', async () => {
    await writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'collaudo')
    const totali = scritture.filter((s) => 'costo_totale' in s).map((s) => s['costo_totale'])
    expect(totali).toEqual([null])
  })

  it('quello che resta chiesto non si tocca', async () => {
    propsTicket = { catalog_item_id: 'voce-1', form_revision: 3, ambiente_uso: 'collaudo', costo_stimato: null, costo_totale: null }
    await writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'produzione')
    // Da nascosto a visibile non si svuota niente: la cascata guarda solo il
    // salto da chiesto a non chiesto.
    expect(scritture.some((s) => 'costo_stimato' in s && s['costo_stimato'] === null)).toBe(false)
  })

  it('un campo già nascosto da prima non si svuota di straforo', async () => {
    // `costo_stimato` era già nascosto (ambiente = collaudo) e porta un valore
    // vecchio: ripulirlo dentro la correzione di un'ALTRA risposta sarebbe una
    // cancellazione che nessuno ha chiesto.
    propsTicket = { catalog_item_id: 'voce-1', form_revision: 3, ambiente_uso: 'collaudo', costo_stimato: 999, costo_totale: null }
    await writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'collaudo')
    expect(scritture.some((s) => 'costo_stimato' in s)).toBe(false)
  })

  it('se il campo che si nasconde è un allegato si RIFIUTA, invece di lasciare i file orfani', async () => {
    libreriaRighe = [
      rigaLibreria(),
      rigaLibreria({ name: 'preventivo', field_type: 'attachment', label: 'Preventivo', labels: JSON.stringify({ it: 'Preventivo' }), vocabulary: null }),
    ]
    revisioneCongelata = {
      version: 1, revision: 3,
      sections: [{ id: 's', title: { it: 'S' }, items: [
        { field: 'ambiente_uso' },
        { field: 'preventivo', visibleWhen: { match: 'all', rules: [{ field: 'ambiente_uso', op: 'eq', value: 'produzione' }] } },
      ] }],
    } as unknown as CatalogFormDefinition
    propsTicket = { catalog_item_id: 'voce-1', form_revision: 3, ambiente_uso: 'produzione', preventivo: 'file-1' }
    await expect(writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'collaudo'))
      .rejects.toThrow(/would stop the form from asking/)
    // E non ha scritto niente: si rifiuta PRIMA, non a metà.
    expect(scritture).toEqual([])
  })
})

/**
 * FORMULE E VISIBILITÀ SI INSEGUONO, E NON BASTA UNA PASSATA DI CIASCUNA.
 *
 * È il secondo giro dello stesso difetto, trovato dal vivo su `RICH-000022`
 * subito dopo aver messo la cascata: svuotato «Costo stimato», la formula di
 * «Costo totale» l'ha rifatto (0), e con un totale a 0 la condizione di
 * «Ambienti coinvolti» (`> 1000`) è diventata falsa — ma la visibilità era già
 * stata guardata, col totale di prima. Risultato: «Ambienti coinvolti» restava
 * compilato per una condizione che non regge più. Corretto a metà è sempre
 * sbagliato, e qui la metà si vedeva a schermo.
 */
describe('il punto fisso: un calcolato rifatto può nascondere un altro campo', () => {
  beforeEach(() => {
    scritture.length = 0
    rifiutoDelloScript = null
    libreriaRighe = [
      rigaLibreria(),
      rigaLibreria({ name: 'costo_stimato', field_type: 'number', label: 'Costo stimato', labels: JSON.stringify({ it: 'Costo stimato' }), vocabulary: null }),
      rigaLibreria({ name: 'costo_totale', field_type: 'number', label: 'Costo totale', labels: JSON.stringify({ it: 'Costo totale' }), vocabulary: null, formula: 'return input.costo_stimato * 2' }),
      rigaLibreria({ name: 'nota_spesa', field_type: 'text', label: 'Nota spesa', labels: JSON.stringify({ it: 'Nota spesa' }), vocabulary: null }),
    ]
    revisioneCongelata = {
      version: 1, revision: 3,
      sections: [{ id: 's', title: { it: 'S' }, items: [
        { field: 'ambiente_uso' },
        // Chiesto solo in produzione, come sul modulo vero di c-test.
        { field: 'costo_stimato', visibleWhen: { match: 'all', rules: [{ field: 'ambiente_uso', op: 'eq', value: 'produzione' }] } },
        // Sempre chiesto: la formula lo rifà anche quando l'addendo sparisce.
        { field: 'costo_totale' },
        // E questo dipende dal CALCOLATO, non da ciò che ho corretto io.
        { field: 'nota_spesa', visibleWhen: { match: 'all', rules: [{ field: 'costo_totale', op: 'gt', value: '1000' }] } },
      ] }],
    } as unknown as CatalogFormDefinition
    propsTicket = {
      catalog_item_id: 'voce-1', form_revision: 3,
      ambiente_uso: 'produzione', costo_stimato: 2000, costo_totale: 4000, nota_spesa: 'acquisto urgente',
    }
  })

  it('la nota che dipendeva dal totale si svuota anche se dipende da un calcolato', async () => {
    await writeFormAnswer(session, 't1', 'req-1', 'ambiente_uso', 'collaudo')
    expect(scritture).toHaveLength(1)
    const scritta = scritture[0]!
    expect(scritta['ambiente_uso']).toBe('collaudo')
    expect(scritta['costo_stimato']).toBeNull()
    // La formula (finta) su un addendo assente dà 0: il totale è rifatto, non
    // lasciato al 4000 di prima.
    expect(scritta['costo_totale']).toBe(0)
    // E con 0 la condizione `> 1000` non regge: la nota non è più chiesta.
    expect(scritta['nota_spesa']).toBeNull()
  })

  it('SVUOTARE una risposta passa dalla stessa stabilizzazione, non da una scorciatoia', async () => {
    // Svuotare `costo_stimato` (libero, in produzione è visibile) deve rifare
    // il totale e spegnere la nota: prima uscivo subito con un `SET` solo, e
    // questi due restavano al valore di prima.
    await writeFormAnswer(session, 't1', 'req-1', 'costo_stimato', '')
    expect(scritture).toHaveLength(1)
    expect(scritture[0]).toEqual({ costo_stimato: null, costo_totale: 0, nota_spesa: null })
  })
})
