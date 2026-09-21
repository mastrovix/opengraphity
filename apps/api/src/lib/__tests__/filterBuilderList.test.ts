/**
 * Gli operatori di LISTA del costruttore di filtri (moduli del catalogo,
 * ondata 4).
 *
 * Il difetto che li ha resi necessari: un campo a selezione multipla sta sul
 * nodo come lista di stringhe, ma il filtro lo trattava come un testo. Non
 * dava errore — non trovava MAI niente, che è il modo peggiore di sbagliare:
 * la lista tornava vuota e sembrava una risposta.
 */
import { describe, it, expect } from 'vitest'
import { buildAdvancedWhere } from '../filterBuilder.js'

const campi = new Set(['sistemi'])
const regola = (operator: string, value: unknown) =>
  JSON.stringify({ rules: [{ field: 'sistemi', operator, value, logic: 'AND' }] })

describe('operatori di lista', () => {
  it('«contiene uno di»: basta un valore in comune', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(regola('has_any', ['crm', 'erp']), params, campi)
    expect(where).toBe('(n.sistemi IS NOT NULL AND ANY(_v IN $af_0 WHERE _v IN n.sistemi))')
    expect(params['af_0']).toEqual(['crm', 'erp'])
  })

  it('«contiene tutti»: devono esserci tutti quelli chiesti', () => {
    const where = buildAdvancedWhere(regola('has_all', ['crm', 'erp']), {}, campi)
    expect(where).toContain('ALL(_v IN $af_0 WHERE _v IN n.sistemi)')
  })

  it('«non contiene nessuno di» accetta il campo MAI compilato: un null non contiene niente', () => {
    const where = buildAdvancedWhere(regola('has_none', ['crm']), {}, campi)
    expect(where).toBe('(n.sistemi IS NULL OR NONE(_v IN $af_0 WHERE _v IN n.sistemi))')
  })

  it('«vuoto» su una lista guarda la dimensione, non la stringa vuota', () => {
    expect(buildAdvancedWhere(regola('list_is_empty', null), {}, campi)).toBe('(n.sistemi IS NULL OR size(n.sistemi) = 0)')
    expect(buildAdvancedWhere(regola('list_is_not_empty', null), {}, campi)).toBe('(n.sistemi IS NOT NULL AND size(n.sistemi) > 0)')
  })

  it('il campo resta nella lista bianca: un nome non ammesso viene rifiutato, non ignorato', () => {
    expect(() => buildAdvancedWhere(regola('has_any', ['x']), {}, new Set(['altro'])))
      .toThrow(/Filter field not allowed/)
  })
})

/**
 * FILTRARE LE RIGHE di una tabella (ondata 7). Non c'è Cypher nuova: sono i
 * campi di relazione dell'ondata 2, con `rel.field` che distingue le righe di
 * due tabelle diverse. Questo test tiene ferma proprio quella parte — senza il
 * vincolo, un filtro su una tabella troverebbe le righe dell'altra.
 */
describe('righe di una tabella', () => {
  const campiTabella = new Set(['persone__ruolo', 'fornitori__ruolo'])
  const relazioni = {
    persone__ruolo:   { relType: 'FORM_TABLE_ROW', targetLabel: 'FormTableRow', searchProp: 'ruolo', relProps: { field: 'persone' } },
    fornitori__ruolo: { relType: 'FORM_TABLE_ROW', targetLabel: 'FormTableRow', searchProp: 'ruolo', relProps: { field: 'fornitori' } },
  }
  const regolaSu = (field: string, operator: string, value: unknown) =>
    JSON.stringify({ rules: [{ field, operator, value, logic: 'AND' }] })

  it('«uguale a» diventa un EXISTS su una riga, con il nome della tabella nella relazione', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(regolaSu('persone__ruolo', 'equals', 'admin'), params, campiTabella, 'n', relazioni)
    expect(where).toContain('EXISTS { MATCH (n)-[:FORM_TABLE_ROW {field: $af_0_rel_field}]->(_af_t0:FormTableRow)')
    expect(where).toContain('_af_t0.ruolo = $af_0')
    expect(params['af_0']).toBe('admin')
    expect(params['af_0_rel_field']).toBe('persone')
  })

  it('due tabelle con la STESSA colonna non si confondono: cambia `rel.field`', () => {
    const params: Record<string, unknown> = {}
    buildAdvancedWhere(regolaSu('fornitori__ruolo', 'equals', 'admin'), params, campiTabella, 'n', relazioni)
    expect(params['af_0_rel_field']).toBe('fornitori')
  })

  it('«è vuoto» chiede che NON esista nessuna riga di quella tabella', () => {
    const where = buildAdvancedWhere(regolaSu('persone__ruolo', 'is_empty', null), {}, campiTabella, 'n', relazioni)
    expect(where).toContain('NOT EXISTS { MATCH (n)-[:FORM_TABLE_ROW {field: $af_0_rel_field}]->(:FormTableRow) }')
  })

  it('un operatore che una relazione non sa fare viene RIFIUTATO, non ignorato', () => {
    expect(() => buildAdvancedWhere(regolaSu('persone__ruolo', 'greater_than', '3'), {}, campiTabella, 'n', relazioni))
      .toThrow(/not supported on relation field/)
  })
})

/**
 * «DIVERSO DA» E «NON FRA» COMPRENDONO CHI NON HA RISPOSTO (17 set 2026).
 *
 * In Cypher `NULL <> 'x'` è NULL, cioè falso: un ticket che quella domanda non
 * l'ha mai avuta spariva dal risultato. Sulle richieste è la norma — un campo
 * di modulo esiste solo per la voce di catalogo che lo chiede — quindi «tutte
 * tranne produzione» mostrava solo le richieste di quella voce. La regola
 * giusta era già scritta per «non contiene nessuno di», con tanto di commento.
 */
describe('gli operatori negativi non scartano chi non ha risposto', () => {
  it('«diverso da» include il campo mai compilato', () => {
    const where = buildAdvancedWhere(regola('not_equals', 'production'), {}, campi)
    expect(where).toBe('(n.sistemi IS NULL OR n.sistemi <> $af_0)')
  })

  it('«non fra» fa lo stesso', () => {
    const where = buildAdvancedWhere(regola('not_in', ['production', 'staging']), {}, campi)
    expect(where).toBe('(n.sistemi IS NULL OR NOT n.sistemi IN $af_0)')
  })

  it('«uguale a» invece NON lo include: chi non ha risposto non è uguale a niente', () => {
    const where = buildAdvancedWhere(regola('equals', 'production'), {}, campi)
    expect(where).toBe('n.sistemi = $af_0')
  })
})

/**
 * L'OPERATORE DEVE STARE COL TIPO DEL CAMPO (17 set 2026).
 *
 * L'operatore era validato contro un elenco, il tipo non entrava nella
 * decisione: un `contains` su una selezione multipla genera
 * `toLower(lista) CONTAINS …`, che in Cypher è un errore di tipo. L'errore
 * veniva mascherato e la pagina Richieste INTERA non caricava, senza dire
 * quale regola. Ora si rifiuta la regola, nominandola.
 */
describe('operatore × tipo del campo', () => {
  const liste = new Set(['sistemi'])

  it('un operatore di testo su una lista è rifiutato, e dice cosa usare', () => {
    expect(() => buildAdvancedWhere(regola('contains', 'crm'), {}, campi, 'n', {}, '', liste))
      .toThrow(/holds several values/)
  })

  it('un operatore di lista su un campo a valore singolo è rifiutato', () => {
    const scalari = new Set(['ambiente_uso'])
    const spec = JSON.stringify({ rules: [{ field: 'ambiente_uso', operator: 'has_any', value: ['a'], logic: 'AND' }] })
    expect(() => buildAdvancedWhere(spec, {}, scalari, 'n', {}, '', new Set()))
      .toThrow(/holds one value/)
  })

  it('senza l\'elenco delle liste il controllo non scatta: i chiamanti che non le conoscono restano come prima', () => {
    expect(() => buildAdvancedWhere(regola('contains', 'crm'), {}, campi)).not.toThrow()
    expect(() => buildAdvancedWhere(regola('has_any', ['crm']), {}, campi)).not.toThrow()
  })

  it('e gli abbinamenti giusti passano', () => {
    expect(() => buildAdvancedWhere(regola('has_any', ['crm']), {}, campi, 'n', {}, '', liste)).not.toThrow()
  })
})
