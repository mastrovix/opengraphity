import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { buildReportQuery, validateReportSection, CHART_TYPES, type ChartType, type ReportSectionDef, type ReportNodeDef, type ReportEdgeDef } from '../reportQueryBuilder.js'
import type { ReportWhitelist } from '../reportWhitelist.js'
import { FIELD_NAME_RE } from '../cypherIdentifiers.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const whitelist: ReportWhitelist = {
  labels:            new Set(['Incident', 'Team', 'User', 'Server', 'CIBase']),
  relationshipTypes: new Set(['ASSIGNED_TO_TEAM', 'AFFECTS', 'MEMBER_OF']),
}

function node(overrides: Partial<ReportNodeDef> & { id: string }): ReportNodeDef {
  return {
    entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident',
    isResult: false, isRoot: false, positionX: 0, positionY: 0,
    filters: null, selectedFields: [],
    ...overrides,
  }
}

function edge(overrides: Partial<ReportEdgeDef> & { id: string; sourceNodeId: string; targetNodeId: string }): ReportEdgeDef {
  return { relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '', ...overrides }
}

function section(overrides: Partial<ReportSectionDef> = {}): ReportSectionDef {
  return {
    id: 'sec-1', order: 0, title: 'Test', chartType: 'kpi',
    groupByNodeId: null, groupByField: null, metric: 'count', metricField: null,
    limit: null, sortDir: null,
    nodes: [node({ id: 'root', isRoot: true })],
    edges: [],
    ...overrides,
  }
}

const TENANT = 'tenant-1'

function expectValidationError(fn: () => unknown, messagePart: string) {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(GraphQLError)
  expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
  expect((thrown as GraphQLError).message).toContain(messagePart)
}

// ── Injection payloads (must be rejected, never reach the query text) ─────────

describe('buildReportQuery — Cypher injection is rejected at build time', () => {
  const UNION_POC = 'status as label, count(n_x) as value union match (u:User) return u.email as label, 1 as value //'

  const cases: Array<{ name: string; sec: ReportSectionDef; message: string }> = [
    {
      name: 'groupByField UNION PoC (C-01)',
      sec: section({ chartType: 'bar', groupByField: UNION_POC }),
      message: 'groupByField',
    },
    {
      name: 'groupByField with backtick / brace',
      sec: section({ chartType: 'pie', groupByField: 'status` } ) RETURN 1 //' }),
      message: 'groupByField',
    },
    {
      name: 'filters[].field injection',
      sec: section({ nodes: [node({ id: 'root', isRoot: true, filters: JSON.stringify([{ field: 'status = "x" OR 1=1 //', operator: 'eq', value: 'open' }]) })] }),
      message: 'filter #0 field',
    },
    {
      name: 'filters unknown operator',
      sec: section({ nodes: [node({ id: 'root', isRoot: true, filters: JSON.stringify([{ field: 'status', operator: 'raw', value: 'x' }]) })] }),
      message: 'unknown operator',
    },
    {
      name: 'filters not JSON',
      sec: section({ nodes: [node({ id: 'root', isRoot: true, filters: '{not json' })] }),
      message: 'invalid filters JSON',
    },
    {
      name: 'selectedFields injection in table',
      sec: section({ chartType: 'table', nodes: [node({ id: 'root', isRoot: true, isResult: true, selectedFields: ['title, n0.tenant_id AS t //'] })] }),
      message: 'selectedFields',
    },
    {
      name: 'neo4jLabel not in whitelist (sensitive node)',
      sec: section({ nodes: [node({ id: 'root', isRoot: true, neo4jLabel: 'ApiKey' })] }),
      message: 'not a reportable entity',
    },
    {
      name: 'neo4jLabel with injection characters',
      sec: section({ nodes: [node({ id: 'root', isRoot: true, neo4jLabel: 'Incident) RETURN 1 //' })] }),
      message: 'not a reportable entity',
    },
    {
      name: 'relationshipType not in whitelist',
      sec: section({
        nodes: [node({ id: 'root', isRoot: true }), node({ id: 'c', neo4jLabel: 'Team' })],
        edges: [edge({ id: 'e', sourceNodeId: 'root', targetNodeId: 'c', relationshipType: 'X]->(z) RETURN z //' })],
      }),
      message: 'not a reportable relationship',
    },
    {
      name: 'edge direction invalid',
      sec: section({
        nodes: [node({ id: 'root', isRoot: true }), node({ id: 'c', neo4jLabel: 'Team' })],
        edges: [edge({ id: 'e', sourceNodeId: 'root', targetNodeId: 'c', direction: 'sideways' })],
      }),
      message: 'direction',
    },
    {
      name: 'edge referencing unknown node',
      sec: section({
        nodes: [node({ id: 'root', isRoot: true })],
        edges: [edge({ id: 'e', sourceNodeId: 'root', targetNodeId: 'ghost' })],
      }),
      message: 'must reference section nodes',
    },
    {
      name: 'sortDir injection',
      sec: section({ chartType: 'bar', sortDir: 'DESC UNION MATCH (u:User) RETURN u.email AS label, 1 AS value' }),
      message: 'sortDir',
    },
    {
      name: 'limit out of range',
      sec: section({ limit: 100000 }),
      message: 'limit',
    },
    {
      name: 'chartType unknown',
      sec: section({ chartType: 'raw_cypher' }),
      message: 'chartType',
    },
    {
      name: 'no root node',
      sec: section({ nodes: [node({ id: 'a' })] }),
      message: 'exactly one root',
    },
    {
      name: 'two root nodes',
      sec: section({ nodes: [node({ id: 'a', isRoot: true }), node({ id: 'b', isRoot: true })] }),
      message: 'exactly one root',
    },
    {
      name: 'groupByNodeId stale',
      sec: section({ chartType: 'bar', groupByNodeId: 'missing' }),
      message: 'groupByNodeId',
    },
    {
      name: 'duplicate node ids',
      sec: section({ nodes: [node({ id: 'a', isRoot: true }), node({ id: 'a' })] }),
      message: 'duplicate node id',
    },
  ]

  it.each(cases)('rejects: $name', ({ sec, message }) => {
    expectValidationError(() => buildReportQuery(sec, TENANT, whitelist), message)
    expectValidationError(() => validateReportSection(sec, whitelist), message)
  })

  it('the rejected UNION payload never appears in any generated query', () => {
    // Sanity: a valid section's query is built purely from validated identifiers.
    const { query } = buildReportQuery(section({ chartType: 'bar', groupByField: 'status' }), TENANT, whitelist)
    expect(query).not.toContain('union')
    expect(query).not.toContain('User')
  })
})

// ── Valid sections: exact Cypher ──────────────────────────────────────────────

describe('buildReportQuery — valid sections produce the expected Cypher', () => {
  it('kpi on root only', () => {
    const { query, params, columns } = buildReportQuery(section(), TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'RETURN count(n0) AS value',
    ].join('\n'))
    expect(params).toEqual({ tenantId: TENANT, limit: 20 })
    expect(columns).toEqual([])
  })

  it('bar grouped on a joined node with filters (camelCase → snake_case)', () => {
    const sec = section({
      chartType: 'bar', groupByNodeId: 'team', groupByField: 'name', limit: 5, sortDir: 'asc',
      nodes: [
        node({ id: 'root', isRoot: true, filters: JSON.stringify([
          { field: 'status', operator: 'in', value: ['open', 'assigned'] },
          { field: 'createdAt', operator: 'last_n_days', value: '30' },
          { field: 'title', operator: 'contains', value: 'db' },
          { field: 'resolvedAt', operator: 'is_null', value: null },
        ]) }),
        node({ id: 'team', neo4jLabel: 'Team', entityType: 'Team', label: 'Team' }),
      ],
      edges: [edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' })],
    })
    const { query, params } = buildReportQuery(sec, TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'WHERE n0.status IN $n0_f0 AND datetime(n0.created_at) > datetime() - duration({days: $n0_f1}) AND toLower(n0.title) CONTAINS toLower($n0_f2) AND n0.resolved_at IS NULL',
      'MATCH (n0)-[:ASSIGNED_TO_TEAM]->(n1:Team)',
      // `WITH DISTINCT` (19 set 2026): con un join `count(n0)` contava RIGHE,
      // non nodi — un incident che tocca tre CI valeva tre.
      'WITH DISTINCT n0, n1',
      'RETURN n1.name AS label, count(n0) AS value',
      'ORDER BY value ASC',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    expect(params).toEqual({
      tenantId: TENANT, limit: 5,
      n0_f0: ['open', 'assigned'], n0_f1: 30, n0_f2: 'db',
    })
  })

  /**
   * UNA CONVENZIONE SOLA: `direction` vale rispetto a SORGENTE → BERSAGLIO,
   * comunque la BFS arrivi all'arco (19 set 2026).
   *
   * Questo test fissava il contrario — «legacy semantics preserved», cioè il
   * verso interpretato rispetto al PADRE nell'albero — e quella era una
   * seconda convenzione, mai scritta e opposta a quella del generatore
   * quando l'arco si percorre dal lato della sorgente. Le due si annullavano
   * finché il grafo si costruiva sempre dalla radice in giù; il progettista
   * AI, che orienta gli archi secondo il metamodello, ha prodotto il caso in
   * cui non si annullano: la relazione al contrario, e un report che non
   * trova mai niente senza dirlo.
   */
  it('la direzione di un arco vale rispetto a sorgente → bersaglio, da qualunque lato lo si percorra', () => {
    const build = (direction: string) => buildReportQuery(section({
      chartType: 'pie',
      nodes: [
        node({ id: 'team', isRoot: true, neo4jLabel: 'Team' }),
        node({ id: 'user', neo4jLabel: 'User', filters: JSON.stringify([{ field: 'role', operator: 'neq', value: 'viewer' }]) }),
      ],
      edges: [edge({ id: 'e1', sourceNodeId: 'user', targetNodeId: 'team', relationshipType: 'MEMBER_OF', direction })],
    }), TENANT, whitelist).query

    // L'arco dice «user -[:MEMBER_OF]-> team»: la radice è `team`, quindi si
    // percorre all'indietro, e il pattern deve restare quello.
    expect(build('outgoing')).toContain('MATCH (n0)<-[:MEMBER_OF]-(n1:User)')
    // «team -[:MEMBER_OF]-> user», letto dallo stesso lato.
    expect(build('incoming')).toContain('MATCH (n0)-[:MEMBER_OF]->(n1:User)')
  })

  it('line chart defaults to created_at', () => {
    const { query } = buildReportQuery(section({ chartType: 'line' }), TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      // `toString(...)`: senza, l'asse di ogni serie diceva «[object Object]»
      // (19 set 2026) — una data di Neo4j perde il suo `toString` passando
      // dalla serializzazione JSON.
      'RETURN toString(date(datetime(n0.created_at))) AS label, count(n0) AS value',
      'ORDER BY label ASC',
    ].join('\n'))
  })

  /**
   * Le INTESTAZIONI si leggono (ondata 6, punto 3): l'etichetta del campo
   * quando la conosciamo, il nome interno come ripiego, e l'etichetta
   * dell'entità davanti SOLO con più di un'entità nella stessa tabella — qui
   * ce ne sono due, quindi il prefisso serve a distinguere «Nome» da «Nome».
   *
   * Il testo dell'etichetta resta dato dell'utente e non entra MAI in Cypher:
   * il `Team) RETURN 1 //` nel nome del nodo è lì per questo.
   */
  it('table: aliases are generated (c0, c1…) and display names come from the field labels', () => {
    const sec = section({
      chartType: 'table',
      nodes: [
        node({ id: 'root', isRoot: true, isResult: true, label: 'Incidenti aperti', selectedFields: ['title', 'createdAt'] }),
        node({ id: 'team', neo4jLabel: 'Team', isResult: true, label: 'Team) RETURN 1 //', selectedFields: ['name'] }),
      ],
      edges: [edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' })],
    })
    const fieldLabels = new Map([['Incident.title', 'Titolo'], ['Team.name', 'Nome']])
    const { query, columns } = buildReportQuery(sec, TENANT, whitelist, { fieldLabels })
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'MATCH (n0)-[:ASSIGNED_TO_TEAM]->(n1:Team)',
      // Anche una tabella con un join duplicava le righe.
      'WITH DISTINCT n0, n1',
      'RETURN n0.title AS c0, n0.created_at AS c1, n1.name AS c2',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    // The label text (which may contain anything) is UI-only, never in Cypher.
    expect(query).not.toContain('RETURN 1')
    expect(columns).toEqual([
      { alias: 'c0', name: 'Incidenti aperti · Titolo', source: { neo4jLabel: 'Incident', field: 'title' } },
      // `createdAt` non è nella mappa: ripiego sul nome interno, non intestazione vuota.
      { alias: 'c1', name: 'Incidenti aperti · createdAt', source: { neo4jLabel: 'Incident', field: 'createdAt' } },
      { alias: 'c2', name: 'Team) RETURN 1 // · Nome', source: { neo4jLabel: 'Team', field: 'name' } },
    ])
  })

  it('table con UNA sola entità: nessun prefisso, il nome del campo basta', () => {
    const sec = section({
      chartType: 'table',
      nodes: [node({ id: 'root', isRoot: true, isResult: true, label: 'Incidenti aperti', selectedFields: ['title'] })],
    })
    const { columns } = buildReportQuery(sec, TENANT, whitelist, { fieldLabels: new Map([['Incident.title', 'Titolo']]) })
    expect(columns).toEqual([{ alias: 'c0', name: 'Titolo', source: { neo4jLabel: 'Incident', field: 'title' } }])
  })

  it('table with no selected fields is a validation error (no phantom id column) — C-11', () => {
    expectValidationError(() => buildReportQuery(section({ chartType: 'table' }), TENANT, whitelist), 'at least one selected field')
    // selected fields on a NON-result node do not count
    expectValidationError(() => buildReportQuery(section({
      chartType: 'table',
      nodes: [node({ id: 'root', isRoot: true, isResult: false, selectedFields: ['title'] })],
    }), TENANT, whitelist), 'at least one selected field')
  })

  // ── One expected RETURN per ChartType (builder side of the C-11 contract) ──
  const RETURN_BY_TYPE: Record<ChartType, string[]> = {
    kpi:            ['RETURN count(n0) AS value'],
    pie:            ['RETURN n0.status AS label, count(n0) AS value', 'ORDER BY value DESC', 'LIMIT toInteger($limit)'],
    donut:          ['RETURN n0.status AS label, count(n0) AS value', 'ORDER BY value DESC', 'LIMIT toInteger($limit)'],
    bar:            ['RETURN n0.status AS label, count(n0) AS value', 'ORDER BY value DESC', 'LIMIT toInteger($limit)'],
    bar_horizontal: ['RETURN n0.status AS label, count(n0) AS value', 'ORDER BY value DESC', 'LIMIT toInteger($limit)'],
    top_n:          ['RETURN n0.status AS label, count(n0) AS value', 'ORDER BY value DESC', 'LIMIT toInteger($limit)'],
    line:           ['RETURN toString(date(datetime(n0.created_at))) AS label, count(n0) AS value', 'ORDER BY label ASC'],
    area:           ['RETURN toString(date(datetime(n0.created_at))) AS label, count(n0) AS value', 'ORDER BY label ASC'],
    table:          ['RETURN n0.title AS c0', 'LIMIT toInteger($limit)'],
  }

  it('RETURN_BY_TYPE covers every CHART_TYPES entry', () => {
    expect(Object.keys(RETURN_BY_TYPE).sort()).toEqual([...CHART_TYPES].sort())
  })

  it.each(CHART_TYPES)('chartType %s → expected RETURN clause', (chartType) => {
    const sec = section({ chartType, nodes: [node({ id: 'root', isRoot: true, isResult: true, selectedFields: chartType === 'table' ? ['title'] : [] })] })
    const { query } = buildReportQuery(sec, TENANT, whitelist)
    expect(query).toBe(['MATCH (n0:Incident {tenant_id: $tenantId})', ...RETURN_BY_TYPE[chartType]].join('\n'))
  })

  it('top_n honours limit/sortDir like a ranked bar (executor reads label/value)', () => {
    const { query, params } = buildReportQuery(section({ chartType: 'top_n', groupByField: 'severity', limit: 3, sortDir: 'asc' }), TENANT, whitelist)
    expect(query).toContain('RETURN n0.severity AS label, count(n0) AS value')
    expect(query).toContain('ORDER BY value ASC')
    expect(params['limit']).toBe(3)
  })

  it('metamodel labels/relations added to the whitelist are accepted', () => {
    const wl: ReportWhitelist = {
      labels: new Set([...whitelist.labels, 'CustomBox']),
      relationshipTypes: new Set([...whitelist.relationshipTypes, 'CONTAINS_BOX']),
    }
    const sec = section({
      nodes: [node({ id: 'root', isRoot: true, neo4jLabel: 'Server' }), node({ id: 'b', neo4jLabel: 'CustomBox' })],
      edges: [edge({ id: 'e', sourceNodeId: 'root', targetNodeId: 'b', relationshipType: 'CONTAINS_BOX' })],
    })
    expect(buildReportQuery(sec, TENANT, wl).query).toContain('MATCH (n0)-[:CONTAINS_BOX]->(n1:CustomBox)')
    expectValidationError(() => buildReportQuery(sec, TENANT, whitelist), 'not a reportable entity')
  })
})

describe('FIELD_NAME_RE contract', () => {
  it.each(['status', 'created_at', 'ip_address', 'x1', 'a_b_c'])('accepts %s', f => expect(FIELD_NAME_RE.test(f)).toBe(true))
  it.each(['', 'Status', '_x', '1a', 'a b', 'a-b', 'a.b', 'a`b', 'a}b', 'x AS y', 'tenant_id) RETURN 1 //'])('rejects %j', f => expect(FIELD_NAME_RE.test(f)).toBe(false))
})

/**
 * LE METRICHE FANNO QUELLO CHE DICONO (19 set 2026).
 *
 * `metric` e `metricField` si salvavano e NON si usavano: il RETURN era sempre
 * `count(root)`, quindi un report configurato «media del costo» mostrava il
 * numero di ticket. Trovato preparando il progettista AI dei report — una
 * proposta che scrive «media» avrebbe prodotto un conteggio, e il difetto
 * sarebbe passato da raro a normale.
 */
describe('le metriche', () => {
  // Si riusa il costruttore di sezioni del file: una radice `Incident` con
  // una colonna, che è quello che ogni altro test qui sopra usa.
  const sezione = (over: Partial<ReportSectionDef>): ReportSectionDef =>
    section({ nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] })], ...over })

  it('count resta count', () => {
    expect(buildReportQuery(sezione({}), 't1', whitelist).query).toContain('RETURN count(n0) AS value')
  })

  it('avg calcola la MEDIA sul campo della radice, non un conteggio', () => {
    const q = buildReportQuery(sezione({ metric: 'avg', metricField: 'resolution_minutes' }), 't1', whitelist).query
    expect(q).toContain('RETURN avg(toFloat(n0.resolution_minutes)) AS value')
    expect(q).not.toContain('count(n0)')
  })

  it('sum somma, min e max non forzano il numero (valgono anche su una data)', () => {
    expect(buildReportQuery(sezione({ metric: 'sum', metricField: 'cost' }), 't1', whitelist).query)
      .toContain('sum(toFloat(n0.cost))')
    expect(buildReportQuery(sezione({ metric: 'min', metricField: 'created_at' }), 't1', whitelist).query)
      .toContain('min(n0.created_at)')
    expect(buildReportQuery(sezione({ metric: 'max', metricField: 'created_at' }), 't1', whitelist).query)
      .toContain('max(n0.created_at)')
  })

  it('la metrica vale anche sui grafici a categorie e sulle serie', () => {
    const barre = buildReportQuery(sezione({
      chartType: 'bar', metric: 'avg', metricField: 'cost', groupByField: 'status',
    }), 't1', whitelist).query
    expect(barre).toContain('AS label, avg(toFloat(n0.cost)) AS value')
    const serie = buildReportQuery(sezione({
      chartType: 'line', metric: 'sum', metricField: 'cost', groupByField: 'created_at',
    }), 't1', whitelist).query
    expect(serie).toContain('AS label, sum(toFloat(n0.cost)) AS value')
  })

  it('una metrica senza campo si RIFIUTA: prima diventava un conteggio in silenzio', () => {
    expect(() => buildReportQuery(sezione({ metric: 'avg', metricField: null }), 't1', whitelist))
      .toThrow(/needs a metricField/)
  })

  it('una metrica inventata si rifiuta', () => {
    expect(() => buildReportQuery(sezione({ metric: 'median' }), 't1', whitelist))
      .toThrow(/unsupported metric/)
  })

  it('un campo di metrica con Cypher dentro non passa', () => {
    expect(() => buildReportQuery(sezione({ metric: 'sum', metricField: 'cost) RETURN 1 //' }), 't1', whitelist))
      .toThrow()
  })
})

/**
 * IL PERIODO DI UNA SERIE (19 set 2026).
 *
 * «gli incident resolved negli ultimi 6 mesi»: il proprietario intendeva il
 * numero PER MESE, e il motore sapeva raggruppare solo per giorno — 180 punti
 * appiccicati. Non c'era modo di chiedere altro, da nessuna parte.
 */
describe('la granularità di una serie', () => {
  const serie = (over: Partial<ReportSectionDef>): ReportSectionDef => section({
    chartType: 'line', groupByField: 'resolved_at',
    nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] })],
    ...over,
  })

  it('senza periodo resta il comportamento di prima: un punto al giorno', () => {
    expect(buildReportQuery(serie({}), 't1', whitelist).query).toContain('toString(date(datetime(n0.resolved_at)))')
  })

  it('per mese porta ogni data al primo del mese', () => {
    expect(buildReportQuery(serie({ groupByGranularity: 'month' }), 't1', whitelist).query)
      .toContain("toString(date.truncate('month', datetime(n0.resolved_at)))")
  })

  it('per settimana idem', () => {
    expect(buildReportQuery(serie({ groupByGranularity: 'week' }), 't1', whitelist).query)
      .toContain("toString(date.truncate('week', datetime(n0.resolved_at)))")
  })

  it('un periodo inventato si rifiuta invece di finire nel Cypher', () => {
    expect(() => buildReportQuery(serie({ groupByGranularity: "day') RETURN 1 //" }), 't1', whitelist))
      .toThrow(/unsupported groupByGranularity/)
  })

  /*
   * QUESTO TEST DICEVA IL CONTRARIO stamattina, e diceva il difetto.
   *
   * «Fuori dalle serie il periodo non cambia niente» significava che un
   * istogramma raggruppato per `created_at` raggruppava sul TIMESTAMP: una
   * barra per incident, tutte alte 1, con sotto «2026-07-15T11:05:33.963Z».
   * Il proprietario l'ha visto mezz'ora dopo. Il periodo vale per qualunque
   * grafico raggruppato per data.
   */
  it('anche un istogramma raggruppato per data si tronca al periodo', () => {
    const barre = buildReportQuery(serie({ chartType: 'bar', groupByField: 'created_at', groupByGranularity: 'month' }), 't1', whitelist).query
    expect(barre).toContain("toString(date.truncate('month', datetime(n0.created_at)))")
  })

  it('senza periodo un raggruppamento resta la proprietà grezza: stato, categoria, team', () => {
    const barre = buildReportQuery(serie({ chartType: 'bar', groupByField: 'status' }), 't1', whitelist).query
    expect(barre).toContain('RETURN n0.status AS label')
    expect(barre).not.toContain('date')
  })

  it('una classifica per mese si raggruppa come le barre', () => {
    const classifica = buildReportQuery(serie({ chartType: 'top_n', groupByField: 'created_at', groupByGranularity: 'month' }), 't1', whitelist).query
    expect(classifica).toContain("toString(date.truncate('month', datetime(n0.created_at)))")
  })
})

/**
 * PER ANNO (19 set 2026): «quando si raggruppa per data devo poter
 * specificare sempre se per giorno, mese o anno, in tutti i grafici in cui
 * ha senso farlo».
 */
describe('il periodo per anno', () => {
  const sez = (over: Partial<ReportSectionDef>): ReportSectionDef => section({
    nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] })], ...over,
  })

  it('una serie per anno', () => {
    expect(buildReportQuery(sez({ chartType: 'line', groupByField: 'created_at', groupByGranularity: 'year' }), 't1', whitelist).query)
      .toContain("toString(date.truncate('year', datetime(n0.created_at)))")
  })

  it('una torta per anno', () => {
    expect(buildReportQuery(sez({ chartType: 'pie', groupByField: 'resolved_at', groupByGranularity: 'year' }), 't1', whitelist).query)
      .toContain("toString(date.truncate('year', datetime(n0.resolved_at)))")
  })
})

/**
 * I NUMERI CON UN JOIN (19 set 2026, dalla revisione).
 *
 * `count(n0)` conta righe, non nodi: con un secondo MATCH un incident che
 * tocca tre CI compare tre volte. Sul conteggio era un numero gonfiato — da
 * quando le metriche funzionano davvero è una SOMMA sbagliata, cioè una cifra
 * che qualcuno stamperà.
 */
describe('i join non moltiplicano i numeri', () => {
  const conJoin = (over: Partial<ReportSectionDef> = {}): ReportSectionDef => section({
    chartType: 'bar', groupByField: 'status',
    nodes: [
      node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] }),
      node({ id: 'n2', neo4jLabel: 'Team' }),
    ],
    edges: [edge({ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' })],
    ...over,
  })

  it('con un join le righe si scremano prima di aggregare', () => {
    expect(buildReportQuery(conJoin(), 't1', whitelist).query).toContain('WITH DISTINCT n0')
  })

  it('senza join non si aggiunge niente: la query resta quella di sempre', () => {
    const semplice = buildReportQuery(section({
      nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] })],
    }), 't1', whitelist).query
    expect(semplice).not.toContain('WITH DISTINCT')
  })

  it('la somma di un campo passa dal DISTINCT: è la cifra che qualcuno stampa', () => {
    const q = buildReportQuery(conJoin({ metric: 'sum', metricField: 'cost' }), 't1', whitelist).query
    expect(q).toContain('WITH DISTINCT n0')
    expect(q).toContain('sum(toFloat(n0.cost))')
  })
})

/**
 * UN ARCO IN PIÙ È UN VINCOLO, non un disegno: il triangolo.
 */
describe('gli archi fuori dall\'albero', () => {
  it('diventano un EXISTS invece di sparire', () => {
    const q = buildReportQuery(section({
      chartType: 'kpi',
      nodes: [
        node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] }),
        node({ id: 'n2', neo4jLabel: 'Team' }),
        node({ id: 'n3', neo4jLabel: 'User' }),
      ],
      edges: [
        edge({ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO_TEAM' }),
        edge({ id: 'e2', sourceNodeId: 'n1', targetNodeId: 'n3', relationshipType: 'AFFECTS' }),
        // Il terzo lato: prima spariva, e il report contava anche le coppie
        // che quella relazione non hanno.
        edge({ id: 'e3', sourceNodeId: 'n3', targetNodeId: 'n2', relationshipType: 'MEMBER_OF' }),
      ],
    }), 't1', whitelist).query
    expect(q).toContain('WHERE EXISTS { (n2)-[:MEMBER_OF]->(n1) }')
  })
})

describe('una tabella non ha una misura', () => {
  it('una media su una tabella si rifiuta invece di essere ignorata', () => {
    expect(() => buildReportQuery(section({
      chartType: 'table', metric: 'avg', metricField: 'cost',
      nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'] })],
    }), 't1', whitelist)).toThrow(/a table lists rows/)
  })
})

/**
 * IL VALORE DI UN FILTRO NON PASSA PIÙ SENZA GUARDARLO (19 set 2026).
 *
 * Tre esiti muti: «ultimi N giorni» vuoto = 0 giorni (solo il futuro), «è
 * fra» vuoto = `IN []` (mai vero), e un operatore senza valore. Nessuno dava
 * un errore: davano zero righe, che è una risposta plausibile.
 */
describe('i valori dei filtri', () => {
  const conFiltro = (filtro: Record<string, unknown>) => section({
    nodes: [node({ id: 'n1', isRoot: true, isResult: true, selectedFields: ['number'], filters: JSON.stringify([filtro]) })],
  })
  const costruisci = (filtro: Record<string, unknown>) => () => buildReportQuery(conFiltro(filtro), 't1', whitelist)

  it('«ultimi N giorni» senza numero si rifiuta invece di diventare zero giorni', () => {
    expect(costruisci({ field: 'created_at', operator: 'last_n_days', value: '' })).toThrow(/whole number of days/)
    expect(costruisci({ field: 'created_at', operator: 'last_n_days', value: 'un mese' })).toThrow(/whole number of days/)
    expect(costruisci({ field: 'created_at', operator: 'last_n_days', value: 0 })).toThrow(/whole number of days/)
  })

  it('un numero di giorni scritto come testo si accetta: è quello che manda una casella', () => {
    const { params } = buildReportQuery(conFiltro({ field: 'created_at', operator: 'last_n_days', value: '30' }), 't1', whitelist)
    expect(Object.values(params)).toContain(30)
  })

  it('«è fra» senza valori si rifiuta: una lista vuota non corrisponde mai', () => {
    expect(costruisci({ field: 'status', operator: 'in', value: [] })).toThrow(/at least one value/)
    expect(costruisci({ field: 'status', operator: 'in', value: ['', '  '] })).toThrow(/at least one value/)
  })

  it('un confronto senza valore si rifiuta', () => {
    expect(costruisci({ field: 'status', operator: 'eq', value: '' })).toThrow(/needs a value/)
    expect(costruisci({ field: 'status', operator: 'eq', value: null })).toThrow(/needs a value/)
  })

  it('«è vuoto» non vuole nessun valore e non si lamenta', () => {
    expect(costruisci({ field: 'resolved_at', operator: 'is_null', value: null })).not.toThrow()
  })

  it('un numero resta un numero: `n.porta = "443"` non troverebbe mai niente', () => {
    const { params } = buildReportQuery(conFiltro({ field: 'port', operator: 'eq', value: 443 }), 't1', whitelist)
    expect(Object.values(params)).toContain(443)
  })
})
