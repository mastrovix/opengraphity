/**
 * LE REGOLE DEI MODULI DEL CATALOGO (22 set 2026).
 *
 * ## Perché
 * `catalogForm.ts` stava a ZERO: centocinquanta istruzioni, il file più grande
 * di `packages/types`. È il posto in cui vivono le regole che il BROWSER e il
 * SERVER devono leggere allo stesso modo — quali campi si vedono, quali si
 * possono scrivere, come si confronta una risposta. Quando queste regole erano
 * scritte in due posti hanno già divergiuto, e il commento in testa a
 * `formItemsToFill` racconta come:
 *
 *   «Tre copie della regola che decide cosa si può scrivere su un ticket sono
 *    tre modi di divergere: basta aggiungere una dimensione di visibilità da un
 *    lato — come è successo con `endUser` — e il client mostra un campo che il
 *    server rifiuta, cioè chi compila non ha via d'uscita.»
 *
 * Ora la regola è una sola. Qui si fissa che cosa dice.
 */
import { describe, it, expect } from 'vitest'
import {
  isFormAnswerEmpty, evaluateFormRule, evaluateFormCondition,
  formItemsToFill, catalogFormForEndUser, catalogFormFieldNames, catalogFormConditionFieldNames,
  larghezzaEffettiva, emptyCatalogForm, nomeDaEtichetta, localizedText,
  isFormConditionOp, isFormFieldType, isFormTableType, isFormReferenceType, isFormAttachmentType,
  canBeComputed, canBeConditionSubject, isFormTableColumnType, emptyFormTable,
  formTableColumnLabel, isFormTableRowEmpty, freeSectionId, CATALOG_FORM_VERSION,
  type CatalogFormDefinition, type FormCondition,
} from '../catalogForm.js'

const regola = (field: string, op: string, value?: string) => ({ field, op, value } as never)
const condizione = (match: 'all' | 'any', ...rules: unknown[]) => ({ match, rules } as unknown as FormCondition)

// ══════════════════════════════════════════════════════════════════════════════
describe('una risposta «non data»', () => {
  it.each([
    [null, true], [undefined, true], ['', true], ['   ', true], [[], true],
    ['x', false], [0, false], [false, false], [['a'], false],
  ])('%s → vuota: %s', (valore, atteso) => {
    expect(isFormAnswerEmpty(valore as never)).toBe(atteso)
  })

  it('zero e `false` NON sono vuoti: sono risposte', () => {
    expect(isFormAnswerEmpty(0)).toBe(false)
    expect(isFormAnswerEmpty(false)).toBe(false)
  })
})

describe('evaluateFormRule', () => {
  it('`filled` e `empty` sono gli unici che guardano una risposta assente', () => {
    expect(evaluateFormRule(regola('a', 'filled'), {})).toBe(false)
    expect(evaluateFormRule(regola('a', 'empty'), {})).toBe(true)
    expect(evaluateFormRule(regola('a', 'filled'), { a: 'x' })).toBe(true)
    expect(evaluateFormRule(regola('a', 'empty'), { a: 'x' })).toBe(false)
  })

  it('una risposta vuota fa fallire ogni altra regola: un campo non compilato non fa comparire quello che dipende da lui', () => {
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']) {
      expect(evaluateFormRule(regola('a', op, 'x'), { a: '' }), op).toBe(false)
    }
  })

  it('`eq` e `ne` sul testo, e un booleano si confronta come «true»/«false»', () => {
    expect(evaluateFormRule(regola('a', 'eq', 'x'), { a: 'x' })).toBe(true)
    expect(evaluateFormRule(regola('a', 'ne', 'x'), { a: 'y' })).toBe(true)
    expect(evaluateFormRule(regola('a', 'eq', 'true'), { a: true })).toBe(true)
    expect(evaluateFormRule(regola('a', 'eq', 'false'), { a: false })).toBe(true)
  })

  it('`contains` non bada alle maiuscole', () => {
    expect(evaluateFormRule(regola('a', 'contains', 'ROMA'), { a: 'Via Roma 1' })).toBe(true)
  })

  it('i confronti d\'ordine sono NUMERICI quando entrambi i lati sono numeri', () => {
    // «costo > 1000»: 9 non deve battere 1000 come farebbe un confronto di testo.
    expect(evaluateFormRule(regola('costo', 'gt', '1000'), { costo: '9' })).toBe(false)
    expect(evaluateFormRule(regola('costo', 'gt', '1000'), { costo: '1200' })).toBe(true)
    expect(evaluateFormRule(regola('costo', 'gte', '1000'), { costo: '1000' })).toBe(true)
    expect(evaluateFormRule(regola('costo', 'lt', '1000'), { costo: '999' })).toBe(true)
    expect(evaluateFormRule(regola('costo', 'lte', '1000'), { costo: '1000' })).toBe(true)
  })

  it('…e ALFABETICI quando non lo sono: «data >= 2026-01-01» funziona perché l\'ISO si ordina come testo', () => {
    expect(evaluateFormRule(regola('d', 'gte', '2026-01-01'), { d: '2026-03-04' })).toBe(true)
    expect(evaluateFormRule(regola('d', 'gte', '2026-01-01'), { d: '2025-12-31' })).toBe(false)
  })

  it('su una LISTA `eq` e `contains` vogliono dire «fra le scelte c\'è»', () => {
    expect(evaluateFormRule(regola('s', 'eq', 'b'), { s: ['a', 'b'] })).toBe(true)
    expect(evaluateFormRule(regola('s', 'contains', 'b'), { s: ['a', 'b'] })).toBe(true)
    expect(evaluateFormRule(regola('s', 'ne', 'c'), { s: ['a', 'b'] })).toBe(true)
    expect(evaluateFormRule(regola('s', 'ne', 'a'), { s: ['a', 'b'] })).toBe(false)
  })

  it('e i confronti d\'ordine su una lista non hanno senso: falsi', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      expect(evaluateFormRule(regola('s', op, 'a'), { s: ['a', 'b'] }), op).toBe(false)
    }
  })
})

describe('evaluateFormCondition', () => {
  it('ASSENTE = visibile: è il caso normale', () => {
    expect(evaluateFormCondition(undefined, {})).toBe(true)
  })

  it('un elenco di regole VUOTO è visibile, qualunque sia il `match`', () => {
    // La validazione della definizione lo rifiuta a monte, proprio per non
    // dover scegliere qui fra «tutte le zero» e «almeno una di zero».
    expect(evaluateFormCondition(condizione('all'), {})).toBe(true)
    expect(evaluateFormCondition(condizione('any'), {})).toBe(true)
  })

  it('`all` vuole tutte, `any` almeno una', () => {
    const risposte = { a: 'x', b: 'y' }
    expect(evaluateFormCondition(condizione('all', regola('a', 'eq', 'x'), regola('b', 'eq', 'y')), risposte)).toBe(true)
    expect(evaluateFormCondition(condizione('all', regola('a', 'eq', 'x'), regola('b', 'eq', 'z')), risposte)).toBe(false)
    expect(evaluateFormCondition(condizione('any', regola('a', 'eq', 'no'), regola('b', 'eq', 'y')), risposte)).toBe(true)
    expect(evaluateFormCondition(condizione('any', regola('a', 'eq', 'no'), regola('b', 'eq', 'no')), risposte)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('formItemsToFill — la regola che decide cosa si può scrivere', () => {
  const def = {
    version: 1, revision: 3,
    sections: [
      { id: 'main', title: { it: 'Dati' }, items: [
        { field: 'tipo' },
        { field: 'motivo', visibleWhen: condizione('all', regola('tipo', 'eq', 'altro')) },
        { field: 'interno', endUser: false },
      ] },
      { id: 'extra', title: { it: 'Extra' }, visibleWhen: condizione('all', regola('tipo', 'eq', 'altro')),
        items: [{ field: 'dettaglio' }] },
    ],
  } as unknown as CatalogFormDefinition

  it('una sezione nascosta si porta via tutte le sue voci', () => {
    expect(formItemsToFill(def, { tipo: 'standard' }).map((i) => i.field)).toEqual(['tipo', 'interno'])
  })

  it('una condizione soddisfatta apre sezione e voce', () => {
    expect(formItemsToFill(def, { tipo: 'altro' }).map((i) => i.field))
      .toEqual(['tipo', 'motivo', 'interno', 'dettaglio'])
  })

  it('`endUser` toglie le voci che il modulo destina all\'area di lavoro', () => {
    expect(formItemsToFill(def, { tipo: 'altro' }, { endUser: true }).map((i) => i.field))
      .toEqual(['tipo', 'motivo', 'dettaglio'])
  })

  it('`catalogFormForEndUser` toglie anche le SEZIONI che restano senza voci', () => {
    const soloInterne = {
      version: 1, revision: 1,
      sections: [
        { id: 'a', title: { it: 'A' }, items: [{ field: 'x', endUser: false }] },
        { id: 'b', title: { it: 'B' }, items: [{ field: 'y' }] },
      ],
    } as unknown as CatalogFormDefinition
    const out = catalogFormForEndUser(soloInterne)
    // Un'intestazione senza campi sarebbe un modulo rotto, e il titolo è
    // comunque un dato interno.
    expect(out.sections.map((s) => s.id)).toEqual(['b'])
    expect(out.revision).toBe(1)
  })

  it('i nomi dei campi escono NELL\'ORDINE in cui compaiono', () => {
    expect(catalogFormFieldNames(def)).toEqual(['tipo', 'motivo', 'interno', 'dettaglio'])
  })

  it('e i campi citati dalle CONDIZIONI si sanno a parte: devono esistere nel modulo', () => {
    expect(catalogFormConditionFieldNames(def)).toContain('tipo')
  })
})

describe('la larghezza la decide la SEZIONE, e non si aggira', () => {
  it('una colonna: tutto pieno, anche se il campo chiede metà', () => {
    expect(larghezzaEffettiva({ columns: 1 }, { width: 'half' })).toBe('full')
    expect(larghezzaEffettiva({ columns: undefined as never }, { width: 'half' })).toBe('full')
  })

  it('due colonne: metà per difetto, e il campo può chiedere la riga intera', () => {
    expect(larghezzaEffettiva({ columns: 2 }, {})).toBe('half')
    expect(larghezzaEffettiva({ columns: 2 }, { width: 'full' })).toBe('full')
    expect(larghezzaEffettiva({ columns: 2 }, { width: 'half' })).toBe('half')
  })
})

describe('emptyCatalogForm', () => {
  it('una sezione vuota, per non far vedere una pagina bianca', () => {
    expect(emptyCatalogForm()).toEqual({
      version: CATALOG_FORM_VERSION, revision: 0,
      sections: [{ id: 'main', title: {}, items: [] }],
    })
  })
})

describe('nomeDaEtichetta', () => {
  it('accenti via, minuscole, il resto diventa `_`', () => {
    expect(nomeDaEtichetta('Città di nascita')).toBe('citta_di_nascita')
    expect(nomeDaEtichetta('Costo (€)')).toBe('costo')
  })

  it('deve cominciare per lettera', () => {
    expect(nomeDaEtichetta('2026')).toBe('campo_2026')
    expect(nomeDaEtichetta('!!!')).toBe('campo')
  })

  it('sta in quaranta caratteri, e non finisce con un `_`', () => {
    const n = nomeDaEtichetta('a'.repeat(60))
    expect(n.length).toBeLessThanOrEqual(40)
    expect(n.endsWith('_')).toBe(false)
  })

  it('un nome già preso NON si riusa: due etichette uguali possono essere due domande diverse', () => {
    expect(nomeDaEtichetta('Note', ['note'])).toBe('note_2')
    expect(nomeDaEtichetta('Note', ['note', 'note_2'])).toBe('note_3')
  })

  it('sotto i due caratteri si allunga: la regex del nome non lo accetterebbe', () => {
    expect(nomeDaEtichetta('A').length).toBeGreaterThanOrEqual(2)
  })
})

describe('localizedText', () => {
  it('la lingua chiesta, se c\'è', () => {
    expect(localizedText({ it: 'Nome', en: 'Name' }, 'it', 'x')).toBe('Nome')
    expect(localizedText({ it: 'Nome', en: 'Name' }, 'en', 'x')).toBe('Name')
  })

  it('altrimenti una traduzione QUALSIASI, che è meglio del nome interno', () => {
    expect(localizedText({ it: 'Nome' }, 'de', 'nome_campo')).toBe('Nome')
    expect(localizedText({ it: 'Nome' }, null, 'nome_campo')).toBe('Nome')
  })

  it('il ripiego solo quando non c\'è NESSUNA traduzione utile', () => {
    expect(localizedText(undefined, 'it', 'nome_campo')).toBe('nome_campo')
    expect(localizedText({}, 'it', 'nome_campo')).toBe('nome_campo')
    // Una traduzione di soli spazi non è una traduzione.
    expect(localizedText({ it: '   ' }, 'de', 'nome_campo')).toBe('nome_campo')
  })
})

describe('i riconoscitori di tipo', () => {
  it('un operatore di condizione è uno dei nove', () => {
    expect(isFormConditionOp('eq')).toBe(true)
    expect(isFormConditionOp('empty')).toBe(true)
    expect(isFormConditionOp('regex')).toBe(false)
    expect(isFormConditionOp(42)).toBe(false)
  })

  it('un tipo di campo è uno di quelli spediti', () => {
    expect(isFormFieldType('text')).toBe(true)
    expect(isFormFieldType('colore')).toBe(false)
    expect(isFormFieldType(null)).toBe(false)
  })

  it('tabella, riferimento e allegato si riconoscono per famiglia', () => {
    expect(isFormTableType('table')).toBe(true)
    expect(isFormTableType('text')).toBe(false)
    expect(isFormReferenceType('ref_ci')).toBe(true)
    expect(isFormReferenceType('text')).toBe(false)
    expect(isFormAttachmentType('attachment')).toBe(true)
    expect(isFormAttachmentType('text')).toBe(false)
  })

  it('«si può calcolare» e «si può usare in una condizione» non sono la stessa cosa', () => {
    expect(canBeComputed('attachment')).toBe(false)
    expect(canBeComputed('table')).toBe(false)
    expect(canBeConditionSubject('note')).toBe(false)
  })
})

describe('le tabelle ripetibili', () => {
  it('una tabella nasce con la sua versione e nessuna colonna', () => {
    expect(emptyFormTable()).toMatchObject({ columns: [] })
    expect(emptyFormTable().version).toBeGreaterThanOrEqual(1)
  })

  it('un tipo di colonna è uno di quelli ammessi', () => {
    expect(isFormTableColumnType('text')).toBe(true)
    expect(isFormTableColumnType('table')).toBe(false)
  })

  it('l\'etichetta di una colonna segue la lingua, e senza traduzioni resta il nome', () => {
    const c = { name: 'stato', labels: { it: 'Stato', en: 'Status' }, fieldType: 'text' } as never
    expect(formTableColumnLabel(c, 'en')).toBe('Status')
    expect(formTableColumnLabel(c, 'it')).toBe('Stato')
    // Lingua sconosciuta: una traduzione qualsiasi, non il nome interno.
    expect(formTableColumnLabel(c, 'de')).toBe('Stato')
    expect(formTableColumnLabel({ name: 'x', fieldType: 'text' } as never)).toBe('x')
  })

  it('una riga è vuota quando lo sono tutte le sue celle', () => {
    expect(isFormTableRowEmpty({})).toBe(true)
    expect(isFormTableRowEmpty({ a: '', b: '  ' })).toBe(true)
    expect(isFormTableRowEmpty({ a: '', b: 'x' })).toBe(false)
  })
})

describe('freeSectionId', () => {
  it('il primo `section_N` libero', () => {
    expect(freeSectionId([])).toBe('section_1')
    expect(freeSectionId(['section_1', 'section_2'])).toBe('section_3')
    expect(freeSectionId(['section_2'])).toBe('section_1')
  })
})
