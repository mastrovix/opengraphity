/**
 * IL FILTRO DAVANTI ALLA PROPOSTA DI REPORT (19 set 2026).
 *
 * Stesso criterio del filtro dei moduli: quello che passa deve passare anche
 * da `validateReportSection` — la validazione vera, quella che il salvataggio
 * e l'anteprima fanno — e quello che non passa deve DIRSI.
 *
 * L'ultimo blocco è quello che tiene insieme le due metà: la proposta,
 * assemblata come sezione, deve superare `validateReportSection` con la
 * whitelist del tenant. Se un giorno divergessero, è lì che si rompe.
 */
import { describe, it, expect } from 'vitest'
import { validateReportSection, buildReportQuery } from '../reportQueryBuilder.js'
import type { ReportWhitelist } from '../reportWhitelist.js'
import type { NavigableEntity } from '../navigableGraph.js'
import { validaPropostaReport, sezioneDaProposta } from '../reportDesignProposal.js'

const ENTITA: NavigableEntity[] = [
  {
    entityType: 'incident', label: 'Incident', neo4jLabel: 'Incident', group: 'itsm',
    fields: [
      { name: 'number', label: 'Numero', fieldType: 'string', enumValues: [] },
      { name: 'status', label: 'Stato', fieldType: 'enum', enumValues: ['new', 'in_progress', 'closed'] },
      { name: 'severity', label: 'Severità', fieldType: 'enum', enumValues: ['low', 'high'] },
      { name: 'created_at', label: 'Creato il', fieldType: 'datetime', enumValues: [] },
      { name: 'resolution_minutes', label: 'Minuti di risoluzione', fieldType: 'number', enumValues: [] },
    ],
    relations: [
      { relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Team', targetEntityType: 'team', targetLabel: 'Team', targetNeo4jLabel: 'Team' },
    ],
  },
  {
    entityType: 'team', label: 'Team', neo4jLabel: 'Team', group: 'organization',
    fields: [{ name: 'name', label: 'Nome', fieldType: 'string', enumValues: [] }],
    relations: [],
  },
]

const WHITELIST: ReportWhitelist = {
  labels: new Set(['Incident', 'Team']),
  relationshipTypes: new Set(['ASSIGNED_TO_TEAM']),
}

function nodo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a', entita: 'incident', nel_risultato: true, colonne: [], filtri: [], perche: 'dalla frase', ...over }
}

function documento(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    titolo: 'Incident per stato', perche: 'dalla frase: «per stato»',
    grafico: 'bar', metrica: 'count', metrica_campo: null,
    raggruppa_per_entita: null, raggruppa_per_campo: 'status',
    limite: 20, ordine: 'DESC',
    nodi: [nodo()], collegamenti: [], note: [],
    ...over,
  }
}

const chiavi = (p: NonNullable<ReturnType<typeof validaPropostaReport>>) => p.scartati.map((s) => s.key)

describe('validaPropostaReport — le entità e il grafo', () => {
  it('la prima entità è la RADICE, e gli id sono i miei', () => {
    const p = validaPropostaReport(documento(), ENTITA)!
    expect(p.nodes).toHaveLength(1)
    expect(p.nodes[0]).toMatchObject({ id: 'n1', entityType: 'incident', isRoot: true })
  })

  it('un\'entità che non esiste si scarta', () => {
    const p = validaPropostaReport(documento({ nodi: [nodo(), nodo({ id: 'b', entita: 'fatture' })] }), ENTITA)!
    expect(p.nodes).toHaveLength(1)
    expect(chiavi(p)).toContain('reportProposal.discard.entityUnknown')
  })

  it('senza nemmeno un\'entità riconosciuta non c\'è proposta', () => {
    expect(validaPropostaReport(documento({ nodi: [nodo({ entita: 'fatture' })] }), ENTITA)).toBeNull()
  })

  it('un collegamento su una relazione vera passa, e prende la direzione dal metamodello', () => {
    const p = validaPropostaReport(documento({
      nodi: [nodo(), nodo({ id: 'b', entita: 'team' })],
      collegamenti: [{ da: 'a', verso: 'b', relazione: 'ASSIGNED_TO_TEAM' }],
    }), ENTITA)!
    expect(p.edges).toEqual([expect.objectContaining({
      sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing',
    })])
  })

  it('una relazione che non parte da quell\'entità si scarta, e con essa il nodo che restava staccato', () => {
    // Un nodo scollegato in Cypher è un prodotto cartesiano: numeri
    // moltiplicati, che è peggio di un report in meno.
    const p = validaPropostaReport(documento({
      nodi: [nodo(), nodo({ id: 'b', entita: 'team' })],
      collegamenti: [{ da: 'a', verso: 'b', relazione: 'AFFECTS' }],
    }), ENTITA)!
    expect(chiavi(p)).toEqual(expect.arrayContaining([
      'reportProposal.discard.relationUnknown', 'reportProposal.discard.nodeUnreachable',
    ]))
    expect(p.nodes).toHaveLength(1)
    expect(p.edges).toHaveLength(0)
  })

  it('oltre il tetto di entità si tronca', () => {
    const p = validaPropostaReport(documento({
      nodi: [nodo(), nodo({ id: 'b', entita: 'team' }), nodo({ id: 'c', entita: 'incident' }),
             nodo({ id: 'd', entita: 'team' }), nodo({ id: 'e', entita: 'incident' })],
    }), ENTITA)!
    expect(chiavi(p)).toContain('reportProposal.discard.tooManyNodes')
  })
})

describe('validaPropostaReport — grafico, misura, raggruppamento', () => {
  it('un grafico inventato diventa barre, dicendolo', () => {
    const p = validaPropostaReport(documento({ grafico: 'radar' }), ENTITA)!
    expect(p.chartType).toBe('bar')
    expect(chiavi(p)).toContain('reportProposal.discard.chartUnknown')
  })

  it('una media su un campo numerico della radice passa', () => {
    const p = validaPropostaReport(documento({ metrica: 'avg', metrica_campo: 'resolution_minutes' }), ENTITA)!
    expect(p).toMatchObject({ metric: 'avg', metricField: 'resolution_minutes' })
  })

  it('una media su un campo NON numerico torna un conteggio: prima era una bugia silenziosa', () => {
    const p = validaPropostaReport(documento({ metrica: 'avg', metrica_campo: 'status' }), ENTITA)!
    expect(p).toMatchObject({ metric: 'count', metricField: null })
    expect(chiavi(p)).toContain('reportProposal.discard.metricFieldNotNumber')
  })

  it('una media su un campo che non esiste torna un conteggio', () => {
    const p = validaPropostaReport(documento({ metrica: 'avg', metrica_campo: 'costo' }), ENTITA)!
    expect(p.metric).toBe('count')
    expect(chiavi(p)).toContain('reportProposal.discard.metricFieldUnknown')
  })

  it('un campo di raggruppamento inesistente si scarta e si ripiega su status', () => {
    const p = validaPropostaReport(documento({ raggruppa_per_campo: 'reparto' }), ENTITA)!
    expect(p.groupByField).toBe('status')
    expect(chiavi(p)).toContain('reportProposal.discard.groupFieldUnknown')
  })

  it('una serie temporale si raggruppa per data se il modello non lo dice', () => {
    const p = validaPropostaReport(documento({ grafico: 'line', raggruppa_per_campo: null }), ENTITA)!
    expect(p.groupByField).toBe('created_at')
  })

  it('un kpi non ha raggruppamento', () => {
    const p = validaPropostaReport(documento({ grafico: 'kpi' }), ENTITA)!
    expect(p.groupByNodeId).toBeNull()
    expect(p.groupByField).toBeNull()
  })

  it('il limite si taglia al massimo che il costruttore sa mostrare', () => {
    const p = validaPropostaReport(documento({ limite: 500 }), ENTITA)!
    expect(p.limit).toBe(100)
    expect(chiavi(p)).toContain('reportProposal.discard.limitCapped')
  })
})

describe('validaPropostaReport — i filtri', () => {
  const conFiltro = (f: Record<string, unknown>) => documento({ nodi: [nodo({ filtri: [f] })] })

  it('un filtro su un valore del vocabolario passa', () => {
    const p = validaPropostaReport(conFiltro({ campo: 'status', operatore: 'eq', valore: 'closed' }), ENTITA)!
    expect(JSON.parse(p.nodes[0]!.filters!)).toEqual([{ field: 'status', operator: 'eq', value: 'closed' }])
  })

  it('un valore che il vocabolario non ha si scarta: un filtro così non trova niente per sempre', () => {
    const p = validaPropostaReport(conFiltro({ campo: 'status', operatore: 'eq', valore: 'Chiuso' }), ENTITA)!
    expect(p.nodes[0]!.filters).toBeNull()
    expect(chiavi(p)).toContain('reportProposal.discard.filterValueUnknown')
  })

  it('«ultimi N giorni» vuole un numero di giorni', () => {
    const buono = validaPropostaReport(conFiltro({ campo: 'created_at', operatore: 'last_n_days', valore: 30 }), ENTITA)!
    expect(JSON.parse(buono.nodes[0]!.filters!)).toEqual([{ field: 'created_at', operator: 'last_n_days', value: 30 }])
    const storto = validaPropostaReport(conFiltro({ campo: 'created_at', operatore: 'last_n_days', valore: 'un mese' }), ENTITA)!
    expect(storto.nodes[0]!.filters).toBeNull()
    expect(chiavi(storto)).toContain('reportProposal.discard.filterDays')
  })

  it('un campo che non esiste porta giù il filtro, non il nodo', () => {
    const p = validaPropostaReport(conFiltro({ campo: 'reparto', operatore: 'eq', valore: 'IT' }), ENTITA)!
    expect(p.nodes).toHaveLength(1)
    expect(chiavi(p)).toContain('reportProposal.discard.filterFieldUnknown')
  })

  it('un operatore inventato si scarta', () => {
    const p = validaPropostaReport(conFiltro({ campo: 'status', operatore: 'somiglia', valore: 'x' }), ENTITA)!
    expect(chiavi(p)).toContain('reportProposal.discard.operatorUnknown')
  })

  it('«in» tiene solo i valori ammessi', () => {
    const p = validaPropostaReport(conFiltro({ campo: 'status', operatore: 'in', valore: ['new', 'inventato'] }), ENTITA)!
    expect(JSON.parse(p.nodes[0]!.filters!)).toEqual([{ field: 'status', operator: 'in', value: ['new'] }])
  })
})

describe('validaPropostaReport — le tabelle', () => {
  it('le colonne che l\'entità non ha si scartano', () => {
    const p = validaPropostaReport(documento({
      grafico: 'table', nodi: [nodo({ colonne: ['number', 'reparto'] })],
    }), ENTITA)!
    expect(p.nodes[0]!.selectedFields).toEqual(['number'])
    expect(chiavi(p)).toContain('reportProposal.discard.fieldUnknown')
  })

  it('una tabella senza colonne non si salverebbe: si mettono i primi campi, dicendolo', () => {
    const p = validaPropostaReport(documento({ grafico: 'table', nodi: [nodo({ colonne: [] })] }), ENTITA)!
    expect(p.nodes[0]!.selectedFields.length).toBeGreaterThan(0)
    expect(chiavi(p)).toContain('reportProposal.discard.columnsGuessed')
  })
})

describe('la proposta, assemblata, passa la validazione vera', () => {
  const casi: { nome: string; doc: Record<string, unknown> }[] = [
    { nome: 'barre per stato', doc: documento() },
    { nome: 'kpi', doc: documento({ grafico: 'kpi' }) },
    { nome: 'serie temporale', doc: documento({ grafico: 'line', raggruppa_per_campo: 'created_at' }) },
    { nome: 'classifica', doc: documento({ grafico: 'top_n', limite: 5 }) },
    { nome: 'tabella', doc: documento({ grafico: 'table', nodi: [nodo({ colonne: ['number', 'status'] })] }) },
    { nome: 'media di un campo numerico', doc: documento({ metrica: 'avg', metrica_campo: 'resolution_minutes' }) },
    {
      nome: 'due entità collegate, con filtro',
      doc: documento({
        nodi: [nodo({ filtri: [{ campo: 'created_at', operatore: 'last_n_days', valore: 30 }] }), nodo({ id: 'b', entita: 'team' })],
        collegamenti: [{ da: 'a', verso: 'b', relazione: 'ASSIGNED_TO_TEAM' }],
        raggruppa_per_entita: 'b', raggruppa_per_campo: 'name',
      }),
    },
  ]

  for (const caso of casi) {
    it(`${caso.nome}: validateReportSection l'accetta e il Cypher si costruisce`, () => {
      const p = validaPropostaReport(caso.doc, ENTITA)!
      const sezione = sezioneDaProposta(p)
      expect(() => { validateReportSection(sezione, WHITELIST) }).not.toThrow()
      // E si costruisce anche la query: è quello che fa l'anteprima appena la
      // proposta entra nel costruttore.
      expect(() => buildReportQuery(sezione, 't1', WHITELIST)).not.toThrow()
    })
  }
})
