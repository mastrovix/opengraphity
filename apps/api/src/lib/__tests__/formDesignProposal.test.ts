/**
 * IL FILTRO DAVANTI ALLA PROPOSTA DELL'AI (19 set 2026).
 *
 * Questi test sono la ragione per cui la validazione sta in un file puro: ogni
 * modo in cui un modello può sbagliare è un caso qui, provato senza rete e
 * senza database. Il criterio di ognuno è lo stesso — **quello che passa deve
 * passare anche dalle mutation vere**, e quello che non passa deve DIRSI.
 *
 * L'ultimo test è quello che tiene insieme le due metà: la proposta, applicata
 * come definizione di modulo, deve superare `assertCatalogForm`, cioè la
 * validazione del salvataggio. Se un giorno divergessero, è lì che si rompe.
 */
import { describe, it, expect } from 'vitest'
import { assertCatalogForm, type FormFieldDef } from '../catalogForm.js'
import { validaProposta, type CatalogoPerProposta } from '../formDesignProposal.js'
import { propostaComeDefinizione } from '../../services/formDesignerService.js'

function catalogo(over: Partial<CatalogoPerProposta> = {}): CatalogoPerProposta {
  return {
    campiLibreria: new Map([
      ['centro_di_costo', { fieldType: 'text', label: 'Centro di costo' }],
      ['ambiente',        { fieldType: 'enum', label: 'Ambiente' }],
    ]),
    vocabolari: new Map([
      ['environment', ['production', 'staging']],
      ['category',    ['hardware', 'software']],
      ['priority',    ['low', 'high']],
    ]),
    tipiCI: new Set(['Server', 'Laptop']),
    categorie: ['hardware', 'software'],
    priorita: ['low', 'high'],
    workflowPerNome: new Map([['richieste standard', { id: 'wf-1', name: 'Richieste standard' }]]),
    scriptingAcceso: true,
    consentiNuovi: true,
    maxCampiPerModulo: 20,
    campiGiaNelModulo: [],
    nomiRiservati: new Set(['description', 'status', 'number', 'priority', 'title']),
    idSezioniEsistenti: [],
    ...over,
  }
}

/** Un campo come lo scrive il modello: tutte le chiavi, perché lo schema le pretende. */
function campo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    riuso: null, tipo: 'text', etichetta_it: 'Modello richiesto', etichetta_en: 'Requested model',
    aiuto_it: null, aiuto_en: null, vocabolario: null, tipi_ci: [],
    formula: null, script_validazione: null, obbligatorio: false, larghezza: 'full',
    visibile_nella_richiesta: true, solo_lettura: false, visibile_quando: null,
    perche: 'dalla frase: «il modello del portatile»',
    ...over,
  }
}

function documento(campi: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    voce: null,
    vocabolari_nuovi: [],
    sezioni: [{ titolo_it: 'Il dispositivo', titolo_en: 'The device', colonne: 1, campi }],
    note: [],
    ...over,
  }
}

/** Gli scarti per chiave: quello che il designer mostrerà. */
function chiavi(p: ReturnType<typeof validaProposta>): string[] {
  return p.scartati.map((s) => s.key)
}

describe('validaProposta — i campi', () => {
  it('un campo nuovo prende il nome dall\'etichetta, con la regola di sempre', () => {
    const p = validaProposta(documento([campo({ etichetta_it: 'Data di consegna', tipo: 'date' })]), catalogo())
    expect(p.campiNuovi).toHaveLength(1)
    expect(p.campiNuovi[0]!.name).toBe('data_di_consegna')
    expect(p.sezioni[0]!.items[0]!.source).toBe('new')
  })

  it('un\'etichetta che esiste già in libreria diventa un RIUSO, non un doppione', () => {
    // È la regola di dominio: due campi per la stessa domanda = due colonne
    // nei report che nessuno saprà sommare.
    const p = validaProposta(documento([campo({ etichetta_it: 'Centro di costo' })]), catalogo())
    expect(p.campiNuovi).toHaveLength(0)
    expect(p.sezioni[0]!.items[0]).toMatchObject({ field: 'centro_di_costo', source: 'library' })
  })

  it('un riuso conserva il TIPO della libreria e lo dice, se il modello ne chiedeva un altro', () => {
    const p = validaProposta(documento([campo({ riuso: 'ambiente', tipo: 'text', etichetta_it: 'Ambiente' })]), catalogo())
    expect(p.sezioni[0]!.items[0]!.field).toBe('ambiente')
    expect(chiavi(p)).toContain('proposal.discard.reuseTypeKept')
  })

  it('un riuso di un campo che non esiste non ferma il campo: si crea nuovo, e lo scarto lo spiega', () => {
    const p = validaProposta(documento([campo({ riuso: 'inventato', etichetta_it: 'Targa del muletto' })]), catalogo())
    expect(chiavi(p)).toContain('proposal.discard.reuseUnknown')
    expect(p.campiNuovi.map((c) => c.name)).toEqual(['targa_del_muletto'])
  })

  it('lo stesso campo citato due volte entra una volta sola', () => {
    const p = validaProposta(documento([campo({ riuso: 'ambiente' }), campo({ riuso: 'ambiente' })]), catalogo())
    expect(p.sezioni[0]!.items).toHaveLength(1)
    expect(chiavi(p)).toContain('proposal.discard.alreadyInForm')
  })

  it('un campo già nel modulo esistente non si aggiunge di nuovo', () => {
    const p = validaProposta(documento([campo({ riuso: 'ambiente' })]), catalogo({ campiGiaNelModulo: ['ambiente'] }))
    expect(p.sezioni).toHaveLength(0)
    expect(chiavi(p)).toContain('proposal.discard.alreadyInForm')
  })

  it('un tipo che non esiste viene scartato, non ignorato', () => {
    const p = validaProposta(documento([campo({ tipo: 'firma_digitale' })]), catalogo())
    expect(p.campiNuovi).toHaveLength(0)
    expect(chiavi(p)).toContain('proposal.discard.unknownType')
  })

  it('una TABELLA non si propone: è un documento a parte, e mezza tabella non si disegna', () => {
    const p = validaProposta(documento([campo({ tipo: 'table', etichetta_it: 'Persone da abilitare' })]), catalogo())
    expect(chiavi(p)).toContain('proposal.discard.unknownType')
  })

  it('un campo senza etichetta non ha nome: si scarta', () => {
    const p = validaProposta(documento([campo({ etichetta_it: '', etichetta_en: '' })]), catalogo())
    expect(chiavi(p)).toEqual(['proposal.discard.noLabel'])
  })

  it('oltre il tetto di campi per modulo si tronca, e il tetto si legge nello scarto', () => {
    const p = validaProposta(
      documento([campo({ etichetta_it: 'Uno' }), campo({ etichetta_it: 'Due' }), campo({ etichetta_it: 'Tre' })]),
      catalogo({ maxCampiPerModulo: 2 }),
    )
    expect(p.sezioni[0]!.items).toHaveLength(2)
    expect(p.scartati.filter((s) => s.key === 'proposal.discard.formFull')[0]?.params).toMatchObject({ max: 2 })
  })
})

describe('validaProposta — le scelte e i vocabolari', () => {
  it('una scelta senza vocabolario non offre niente: si scarta', () => {
    const p = validaProposta(documento([campo({ tipo: 'enum', etichetta_it: 'Urgenza', vocabolario: null })]), catalogo())
    expect(p.campiNuovi).toHaveLength(0)
    expect(chiavi(p)).toContain('proposal.discard.choiceWithoutVocabulary')
  })

  it('un vocabolario che non esiste porta giù il campo che lo citava', () => {
    const p = validaProposta(documento([campo({ tipo: 'enum', etichetta_it: 'Urgenza', vocabolario: 'inventato' })]), catalogo())
    expect(chiavi(p)).toEqual(['proposal.discard.vocabularyUnknown', 'proposal.discard.choiceWithoutVocabulary'])
  })

  it('un vocabolario NUOVO proposto vale per i campi della stessa proposta', () => {
    const p = validaProposta(documento(
      [campo({ tipo: 'enum', etichetta_it: 'Modello di portatile', vocabolario: 'laptop_model' })],
      { vocabolari_nuovi: [{ nome: 'laptop_model', etichetta: 'Modello di portatile', valori: ['MacBook Pro 14', 'ThinkPad T14'], perche: 'dalla frase' }] },
    ), catalogo())
    expect(p.vocabolariNuovi.map((v) => v.name)).toEqual(['laptop_model'])
    expect(p.campiNuovi[0]!.vocabulary).toBe('laptop_model')
  })

  it('un vocabolario nuovo che in realtà esiste già si scarta: quello esistente si usa', () => {
    const p = validaProposta(documento([], {
      vocabolari_nuovi: [{ nome: 'environment', etichetta: 'Ambiente', valori: ['a', 'b'], perche: '' }],
    }), catalogo())
    expect(p.vocabolariNuovi).toHaveLength(0)
    expect(chiavi(p)).toContain('proposal.discard.vocabularyExists')
  })

  it('un vocabolario con meno di due valori non è una scelta', () => {
    const p = validaProposta(documento([], {
      vocabolari_nuovi: [{ nome: 'solo_uno', etichetta: 'Solo uno', valori: ['x'], perche: '' }],
    }), catalogo())
    expect(chiavi(p)).toContain('proposal.discard.vocabularyValues')
  })

  it('un vocabolario su un campo che non pesca dal Dizionario si toglie, il campo resta', () => {
    const p = validaProposta(documento([campo({ tipo: 'text', vocabolario: 'environment' })]), catalogo())
    expect(p.campiNuovi[0]!.vocabulary).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.vocabularyNotAllowed')
  })
})

describe('validaProposta — la CMDB e gli script', () => {
  it('i tipi di CI che non esistono cadono, quelli veri restano', () => {
    const p = validaProposta(documento([campo({ tipo: 'ref_ci', etichetta_it: 'Dispositivo', tipi_ci: ['Laptop', 'Stampante'] })]), catalogo())
    expect(p.campiNuovi[0]!.refTypes).toEqual(['Laptop'])
    expect(chiavi(p)).toContain('proposal.discard.ciTypeUnknown')
  })

  it('una formula su un campo che non si calcola non passa', () => {
    const p = validaProposta(documento([campo({ tipo: 'attachment', etichetta_it: 'Preventivo', formula: 'return 1' })]), catalogo())
    expect(p.campiNuovi[0]!.formula).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.formulaNotAllowed')
  })

  it('uno script che il validatore del prodotto rifiuta non arriva alla tela', () => {
    const p = validaProposta(documento([campo({ tipo: 'number', etichetta_it: 'Costo', formula: 'return require("fs")' })]), catalogo())
    expect(p.campiNuovi[0]!.formula).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.scriptInvalid')
  })

  it('con gli script del cliente SPENTI non si propone codice', () => {
    const p = validaProposta(
      documento([campo({ tipo: 'number', etichetta_it: 'Costo', formula: 'return input.a * 2' })]),
      catalogo({ scriptingAcceso: false }),
    )
    expect(p.campiNuovi[0]!.formula).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.scriptingOff')
  })

  it('un campo calcolato non nasce obbligatorio: nessuno può compilarlo', () => {
    const p = validaProposta(
      documento([campo({ tipo: 'number', etichetta_it: 'Costo totale', formula: 'return input.costo * 2', obbligatorio: true })]),
      catalogo(),
    )
    expect(p.campiNuovi[0]!.formula).toBe('return input.costo * 2')
    expect(p.sezioni[0]!.items[0]!.required).toBe(false)
  })
})

describe('validaProposta — le condizioni di visibilità', () => {
  const conCondizione = (regola: Record<string, unknown>) => documento([
    campo({ riuso: 'ambiente', etichetta_it: 'Ambiente' }),
    campo({ etichetta_it: 'Motivo', tipo: 'textarea', visibile_quando: { match: 'all', rules: [regola] } }),
  ])

  it('una condizione su un campo del modulo passa e viaggia come JSON', () => {
    const p = validaProposta(conCondizione({ field: 'ambiente', op: 'eq', value: 'production' }), catalogo())
    expect(JSON.parse(p.sezioni[0]!.items[1]!.visibleWhen!)).toEqual({
      match: 'all', rules: [{ field: 'ambiente', op: 'eq', value: 'production' }],
    })
  })

  it('una condizione su un campo che il modulo non cita si scarta INTERA', () => {
    const p = validaProposta(conCondizione({ field: 'campo_fantasma', op: 'eq', value: 'x' }), catalogo())
    expect(p.sezioni[0]!.items[1]!.visibleWhen).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.conditionField')
  })

  it('una condizione su un allegato non si può valutare: si scarta', () => {
    const doc = documento([
      campo({ etichetta_it: 'Preventivo', tipo: 'attachment' }),
      campo({ etichetta_it: 'Motivo', tipo: 'textarea', visibile_quando: { match: 'all', rules: [{ field: 'preventivo', op: 'filled', value: null }] } }),
    ])
    const p = validaProposta(doc, catalogo())
    expect(p.sezioni[0]!.items[1]!.visibleWhen).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.conditionSubject')
  })

  it('un operatore che pretende un valore, senza valore, non passa', () => {
    const p = validaProposta(conCondizione({ field: 'ambiente', op: 'eq', value: null }), catalogo())
    expect(chiavi(p)).toContain('proposal.discard.conditionValue')
  })

  it('un operatore inventato non passa', () => {
    const p = validaProposta(conCondizione({ field: 'ambiente', op: 'somiglia', value: 'x' }), catalogo())
    expect(chiavi(p)).toContain('proposal.discard.conditionOp')
  })
})

describe('validaProposta — l\'intestazione della voce', () => {
  const voce = (over: Record<string, unknown> = {}) => documento([campo()], {
    voce: {
      nome: 'Nuovo portatile', descrizione: 'Richiesta di un portatile aziendale',
      categoria: 'hardware', priorita: 'high', richiede_approvazione: true,
      workflow: 'Richieste standard', perche: 'dalla frase', ...over,
    },
  })

  it('categoria, priorità e workflow si risolvono su quelli che esistono', () => {
    const p = validaProposta(voce(), catalogo())
    expect(p.voce).toMatchObject({
      name: 'Nuovo portatile', category: 'hardware', priority: 'high',
      requiresApproval: true, workflowDefinitionId: 'wf-1', workflowDefinitionName: 'Richieste standard',
    })
  })

  it('una categoria che il Dizionario non ha diventa null, e lo scarto lo dice', () => {
    const p = validaProposta(voce({ categoria: 'mobilità' }), catalogo())
    expect(p.voce!.category).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.categoryUnknown')
  })

  it('un workflow che non esiste non si inventa', () => {
    const p = validaProposta(voce({ workflow: 'Iter accelerato' }), catalogo())
    expect(p.voce!.workflowDefinitionId).toBeNull()
    expect(chiavi(p)).toContain('proposal.discard.workflowUnknown')
  })
})

describe('validaProposta — chi non può creare campi', () => {
  it('riceve solo RIUSO: niente campi nuovi, niente vocabolari nuovi', () => {
    const doc = documento([campo({ riuso: 'ambiente' }), campo({ etichetta_it: 'Targa' })], {
      vocabolari_nuovi: [{ nome: 'nuovo', etichetta: 'Nuovo', valori: ['a', 'b'], perche: '' }],
    })
    const p = validaProposta(doc, catalogo({ consentiNuovi: false }))
    expect(p.campiNuovi).toHaveLength(0)
    expect(p.vocabolariNuovi).toHaveLength(0)
    expect(p.sezioni[0]!.items.map((i) => i.field)).toEqual(['ambiente'])
    expect(chiavi(p)).toEqual(expect.arrayContaining(['proposal.discard.newVocabularyNotAllowed', 'proposal.discard.newFieldNotAllowed']))
  })
})

describe('validaProposta — documenti storti', () => {
  it('un documento vuoto non esplode: nessuna sezione, nessuno scarto inventato', () => {
    const p = validaProposta({}, catalogo())
    expect(p).toMatchObject({ sezioni: [], campiNuovi: [], vocabolariNuovi: [], voce: null })
  })

  it('una sezione senza campi validi non compare: una sezione vuota sulla tela non dice niente', () => {
    const p = validaProposta(documento([campo({ tipo: 'inventato' })]), catalogo())
    expect(p.sezioni).toHaveLength(0)
  })

  it('tipi sbagliati al posto di liste e oggetti non fermano il resto', () => {
    const p = validaProposta({ sezioni: 'non una lista', vocabolari_nuovi: 42, note: null, voce: 'no' }, catalogo())
    expect(p.sezioni).toEqual([])
    expect(p.note).toEqual([])
  })
})

describe('la proposta, applicata, passa la validazione del salvataggio', () => {
  it('assertCatalogForm accetta il modulo che nasce dalla proposta', () => {
    const doc = documento([
      campo({ riuso: 'ambiente', etichetta_it: 'Ambiente', obbligatorio: true }),
      campo({ etichetta_it: 'Modello richiesto', tipo: 'text' }),
      campo({
        etichetta_it: 'Motivo dell\'urgenza', tipo: 'textarea',
        visibile_quando: { match: 'all', rules: [{ field: 'ambiente', op: 'eq', value: 'production' }] },
      }),
      // IL CASO CHE MANCAVA (trovato pubblicando, 19 set 2026): un
      // riferimento offerto a chi apre la richiesta fa RIFIUTARE il
      // salvataggio, e il test non lo vedeva perché non c'erano riferimenti.
      campo({ etichetta_it: 'Applicazione', tipo: 'ref_ci', visibile_nella_richiesta: true, obbligatorio: true }),
    ])
    const p = validaProposta(doc, catalogo())
    const definizione = propostaComeDefinizione(p, null)

    // La libreria come sarà DOPO aver accettato: i campi esistenti più quelli
    // nuovi. È la stessa mappa che `saveCatalogForm` legge dal grafo.
    const libreria = new Map<string, FormFieldDef>([
      ['ambiente', finto({ name: 'ambiente', fieldType: 'enum', vocabulary: 'environment' })],
      ...p.campiNuovi.map((c) => [c.name, finto({ name: c.name, fieldType: c.fieldType as FormFieldDef['fieldType'] })] as const),
    ])
    expect(() => { assertCatalogForm(definizione, libreria) }).not.toThrow()
    expect(definizione.sections[0]!.items).toHaveLength(4)
    // Un riferimento non si offre a chi compila dal portale: lo rifiuterebbe
    // `assertCatalogForm`, e la proposta deve saperlo da sé.
    // Non offerto nel portale E non obbligatorio: le due regole del prodotto
    // insieme dicono che un riferimento non puo essere pretesa.
    expect(definizione.sections[0]!.items[3]).toMatchObject({ field: 'applicazione', endUser: false, required: false })
    expect(p.scartati.map((x) => x.key)).toContain('proposal.discard.referenceNotRequired')
    // La proposta NON pubblica: la revisione resta quella di prima.
    expect(definizione.revision).toBe(0)
  })
})

function finto(over: Partial<FormFieldDef>): FormFieldDef {
  return {
    id: 'f-1', name: 'x', fieldType: 'text', label: 'X', labels: [], help: null, helps: [],
    required: false, vocabulary: null, validationScript: null, formula: null, tableDefinition: null,
    refTypes: [], shared: false, refFilter: null, inList: false,
    ...over,
  } as FormFieldDef
}

/**
 * UNA CONDIZIONE SU UN CAMPO NUOVO (difetto trovato nel browser, 19 set 2026).
 *
 * Il modello scriveva `field: 'tipo_accesso_applicativo'` mentre il nome vero,
 * derivato dall'etichetta, era `tipo_di_accesso`: la regola veniva scartata, e
 * con lei l'unica cosa che l'utente aveva chiesto per nome («se il tipo di
 * accesso è amministratore chiedi anche il responsabile»). Il nome di un campo
 * che non esiste ancora il modello non può conoscerlo, quindi la condizione si
 * risolve anche per ETICHETTA.
 */
describe('una condizione può nominare un campo per etichetta', () => {
  const doc = (riferimento: string) => documento([
    campo({ etichetta_it: 'Tipo di accesso', tipo: 'enum', vocabolario: 'environment' }),
    campo({
      etichetta_it: 'Responsabile che autorizza', tipo: 'text',
      visibile_quando: { match: 'all', rules: [{ field: riferimento, op: 'eq', value: 'amministratore' }] },
    }),
  ])

  it('per etichetta: è quello che il prompt gli chiede di scrivere', () => {
    const p = validaProposta(doc('Tipo di accesso'), catalogo())
    expect(JSON.parse(p.sezioni[0]!.items[1]!.visibleWhen!)).toMatchObject({ rules: [{ field: 'tipo_di_accesso' }] })
  })

  it('per nome derivato: funziona comunque', () => {
    const p = validaProposta(doc('tipo_di_accesso'), catalogo())
    expect(p.sezioni[0]!.items[1]!.visibleWhen).not.toBeNull()
  })

  it('un nome inventato resta uno scarto: si dice quale', () => {
    const p = validaProposta(doc('tipo_accesso_applicativo'), catalogo())
    expect(p.sezioni[0]!.items[1]!.visibleWhen).toBeNull()
    expect(p.scartati.find((s) => s.key === 'proposal.discard.conditionField')?.params)
      .toMatchObject({ name: 'tipo_accesso_applicativo' })
  })

  it('un campo GIÀ nel modulo si può nominare per etichetta di libreria', () => {
    const p = validaProposta(documento([
      campo({
        etichetta_it: 'Motivo', tipo: 'textarea',
        visibile_quando: { match: 'all', rules: [{ field: 'Ambiente', op: 'eq', value: 'production' }] },
      }),
    ]), catalogo({ campiGiaNelModulo: ['ambiente'] }))
    expect(JSON.parse(p.sezioni[0]!.items[0]!.visibleWhen!)).toMatchObject({ rules: [{ field: 'ambiente' }] })
  })
})

/**
 * I RILIEVI DELLA REVISIONE DEL 19 SET, uno per uno.
 *
 * Tutti avevano la stessa forma: il filtro lasciava passare qualcosa che il
 * SALVATAGGIO poi rifiutava — e il rifiuto arrivava dopo che i campi erano già
 * stati creati in libreria, cioè nel momento peggiore. Il criterio qui è
 * sempre lo stesso: quello che esce dal filtro deve superare
 * `assertCatalogForm`, che è la funzione che decide davvero.
 */
describe('la revisione del 19 set', () => {
  const libreriaDopo = (p: ReturnType<typeof validaProposta>) => new Map<string, FormFieldDef>([
    ['ambiente', finto({ name: 'ambiente', fieldType: 'enum', vocabulary: 'environment' })],
    ['centro_di_costo', finto({ name: 'centro_di_costo', fieldType: 'text' })],
    ...p.campiNuovi.map((c) => [c.name, finto({
      name: c.name, fieldType: c.fieldType as FormFieldDef['fieldType'], formula: c.formula,
    })] as const),
  ])
  const salvabile = (p: ReturnType<typeof validaProposta>, esistente: Parameters<typeof propostaComeDefinizione>[1] = null) => {
    assertCatalogForm(propostaComeDefinizione(p, esistente), libreriaDopo(p))
  }

  it('la stessa etichetta due volte non fa più morire la mutation', () => {
    // Prima: `TypeError: Cannot read properties of undefined (reading 'fieldType')`,
    // cioè un 500 dopo aver pagato la chiamata al modello.
    const p = validaProposta(documento([campo({ etichetta_it: 'Note' }), campo({ etichetta_it: 'Note' })]), catalogo())
    expect(p.sezioni[0]!.items).toHaveLength(1)
    expect(chiavi(p)).toContain('proposal.discard.alreadyInForm')
    expect(() => { salvabile(p) }).not.toThrow()
  })

  it('una NOTA non nasce obbligatoria', () => {
    const p = validaProposta(documento([campo({ tipo: 'note', etichetta_it: 'Leggi prima', obbligatorio: true })]), catalogo())
    expect(p.sezioni[0]!.items[0]!.required).toBe(false)
    expect(chiavi(p)).toContain('proposal.discard.cannotBeRequired')
    expect(() => { salvabile(p) }).not.toThrow()
  })

  it('sola lettura e obbligatorio non stanno insieme senza una formula', () => {
    const p = validaProposta(documento([campo({ etichetta_it: 'Costo noto', obbligatorio: true, solo_lettura: true })]), catalogo())
    expect(p.sezioni[0]!.items[0]).toMatchObject({ required: false, readOnly: true })
    expect(() => { salvabile(p) }).not.toThrow()
  })

  it('un campo che il portale non chiede non può essere obbligatorio', () => {
    const p = validaProposta(documento([campo({ etichetta_it: 'Nota interna', obbligatorio: true, visibile_nella_richiesta: false })]), catalogo())
    expect(p.sezioni[0]!.items[0]).toMatchObject({ required: false, endUser: false })
    expect(() => { salvabile(p) }).not.toThrow()
  })

  it('le etichette inglesi non generano nomi RISERVATI', () => {
    // «Description» dava `description`, che `createFormField` rifiuta: la
    // proposta si applicava a metà, lasciando campi orfani in libreria.
    const p = validaProposta(documento([
      campo({ etichetta_it: 'Description', etichetta_en: 'Description' }),
      campo({ etichetta_it: 'Status', etichetta_en: 'Status' }),
    ]), catalogo())
    for (const c of p.campiNuovi) expect(['description', 'status', 'number', 'priority', 'title']).not.toContain(c.name)
    expect(p.campiNuovi).toHaveLength(2)
  })

  it('gli id di sezione non ripetono quelli che il modulo ha già', () => {
    const p = validaProposta(documento([campo({ etichetta_it: 'Nuovo' })]), catalogo({ idSezioniEsistenti: ['ai_1', 'ai_2'] }))
    expect(p.sezioni[0]!.id).toBe('ai_3')
    const esistente = {
      version: 1, revision: 1,
      sections: [
        { id: 'ai_1', title: { it: 'Una', en: 'One' }, items: [{ field: 'ambiente' }] },
        { id: 'ai_2', title: { it: 'Due', en: 'Two' }, items: [{ field: 'centro_di_costo' }] },
      ],
    }
    expect(() => { salvabile(p, esistente as never) }).not.toThrow()
  })

  it('una sezione senza titolo prende quello del primo campo, invece di non salvarsi', () => {
    const p = validaProposta(documento([], {
      sezioni: [{ titolo_it: '', titolo_en: '', colonne: 1, campi: [campo({ etichetta_it: 'Data di consegna', tipo: 'date' })] }],
    }), catalogo())
    expect(p.sezioni[0]!.titleIt).toBe('Data di consegna')
    expect(() => { salvabile(p) }).not.toThrow()
  })

  it('un campo di libreria CON formula non diventa obbligatorio', () => {
    const p = validaProposta(documento([campo({ riuso: 'costo_totale', etichetta_it: 'Costo totale', obbligatorio: true })]),
      catalogo({ campiLibreria: new Map([['costo_totale', { fieldType: 'number', label: 'Costo totale', haFormula: true }]]) }))
    expect(p.sezioni[0]!.items[0]!.required).toBe(false)
  })
})
