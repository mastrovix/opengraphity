/**
 * The filter in front of the AI report proposal — the less-travelled paths
 * (lib/reportDesignProposal.ts). The sibling reportDesignProposal.test.ts pins
 * the main contract and the round trip through `validateReportSection`.
 *
 * Why these behaviours matter: whatever the model proposes lands in the
 * report builder in front of a person, and then runs as a Cypher query. Every
 * piece that would make the query EXPLODE (a date operator on a string), or
 * silently return nothing forever (a string compared with a number property,
 * a value outside the field's vocabulary), or multiply the numbers (a node
 * joined by no edge = a cartesian product) must be dropped AND reported with
 * an i18n key, so the reviewer sees what was removed and why. Nothing is
 * "corrected" by guessing, except where the code states the default it uses.
 */
import { describe, it, expect } from 'vitest'
import type { NavigableEntity, NavigableField } from '../navigableGraph.js'
import { validaPropostaReport, sezioneDaProposta, MAX_LIMITE_PROPONIBILE } from '../reportDesignProposal.js'

const field = (name: string, label: string, fieldType: string, enumValues: string[] = []): NavigableField =>
  ({ name, label, fieldType, enumValues, enumTypeName: null })

const ENTITIES: NavigableEntity[] = [
  {
    entityType: 'incident', label: 'Incident', neo4jLabel: 'Incident', group: 'itsm',
    fields: [
      field('number', 'Number', 'string'),
      field('status', 'Status', 'enum', ['new', 'closed']),
      field('created_at', 'Created at', 'datetime'),
      field('minutes', 'Minutes', 'number'),
      field('major', 'Major', 'boolean'),
    ],
    relations: [
      { relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Team', targetEntityType: 'team', targetLabel: 'Team', targetNeo4jLabel: 'Team' },
    ],
  },
  {
    // A team only has a name: no status, no created_at — used for the "no default group field" paths.
    entityType: 'team', label: 'Team', neo4jLabel: 'Team', group: 'organization',
    fields: [field('name', 'Name', 'string')],
    relations: [
      { relationshipType: 'HANDLES', direction: 'incoming', label: 'Handled', targetEntityType: 'incident', targetLabel: 'Incident', targetNeo4jLabel: 'Incident' },
    ],
  },
  {
    entityType: 'empty', label: 'Empty', neo4jLabel: 'EmptyThing', group: 'itsm',
    fields: [],
    relations: [],
  },
]

const node = (over: Record<string, unknown> = {}) => ({ id: 'a', entita: 'incident', colonne: [], filtri: [], ...over })
const doc = (over: Record<string, unknown> = {}) => ({ grafico: 'bar', nodi: [node()], ...over })
const propose = (over: Record<string, unknown> = {}, entities = ENTITIES) => validaPropostaReport(doc(over), entities)!
const keys = (p: ReturnType<typeof propose>) => p.scartati.map((s) => s.key)
const filtersOf = (filtri: unknown[]) => {
  const p = propose({ nodi: [node({ filtri })] })
  return { filters: p.nodes[0]!.filters === null ? null : JSON.parse(p.nodes[0]!.filters) as unknown[], keys: keys(p) }
}

describe('defensive reading of a malformed document', () => {
  it('a non-object document, or nodes that are not objects, give no proposal', () => {
    expect(validaPropostaReport(null, ENTITIES)).toBeNull()
    expect(validaPropostaReport([doc()], ENTITIES)).toBeNull()
    expect(validaPropostaReport({ nodi: [['incident']] }, ENTITIES)).toBeNull()
  })

  it('a node without an entity name is reported with a placeholder name', () => {
    const p = propose({ nodi: [node(), node({ entita: '' })] })
    expect(p.scartati).toContainEqual({ what: '—', key: 'reportProposal.discard.entityUnknown', params: { name: '—' } })
  })

  it('notes are kept trimmed and empty ones dropped', () => {
    expect(propose({ note: ['  first ', '', 3, 'second'] }).note).toEqual(['first', 'second'])
  })

  it('without a title the root entity label is used; ASC is honoured in any case', () => {
    const p = propose({ ordine: 'asc' })
    expect(p.title).toBe('Incident')
    expect(p.sortDir).toBe('ASC')
    expect(propose({ ordine: 'sideways' }).sortDir).toBe('DESC')
  })
})

describe('edges and reachability', () => {
  it('an edge whose ends are unknown or identical is dropped', () => {
    const p = propose({
      nodi: [node(), node({ id: 'b', entita: 'team' })],
      collegamenti: [
        { da: 'a', verso: 'ghost', relazione: 'ASSIGNED_TO_TEAM' },
        { da: 'a', verso: 'a', relazione: '' },
      ],
    })
    expect(p.scartati.filter((s) => s.key === 'reportProposal.discard.edgeEnds').map((s) => s.what)).toEqual(['ASSIGNED_TO_TEAM', '—'])
  })

  it('edge ends may cite the entity name instead of the node id', () => {
    const p = propose({
      nodi: [node({ id: '' }), node({ id: '', entita: 'Team' })],
      collegamenti: [{ da: 'INCIDENT', verso: 'team', relazione: 'ASSIGNED_TO_TEAM' }],
    })
    expect(p.edges).toEqual([{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: 'Team' }])
  })

  it('a relation declared on the other entity reaches the root backwards, keeping its direction', () => {
    // team -[HANDLES, incoming]-> incident: the root is the TARGET of this edge.
    const p = propose({
      nodi: [node(), node({ id: 'b', entita: 'team' })],
      collegamenti: [{ da: 'b', verso: 'a', relazione: 'HANDLES' }],
    })
    expect(p.nodes.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(p.edges[0]).toMatchObject({ sourceNodeId: 'n2', targetNodeId: 'n1', direction: 'incoming' })
    expect(keys(p)).not.toContain('reportProposal.discard.nodeUnreachable')
  })

  it('a relation that does not start from that entity is dropped, and the stranded node with it', () => {
    const p = propose({
      nodi: [node(), node({ id: 'b', entita: 'team' })],
      collegamenti: [{ da: 'a', verso: 'b', relazione: 'HANDLES' }],
    })
    expect(keys(p)).toEqual(expect.arrayContaining(['reportProposal.discard.relationUnknown', 'reportProposal.discard.nodeUnreachable']))
    expect(p.nodes).toHaveLength(1)
  })

  it('an unnamed unknown relation is reported with a placeholder', () => {
    const p = propose({ nodi: [node(), node({ id: 'b', entita: 'team' })], collegamenti: [{ da: 'a', verso: 'b' }] })
    expect(p.scartati.find((s) => s.key === 'reportProposal.discard.relationUnknown')!.params['name']).toBe('—')
  })
})

describe('chart, grouping and metric', () => {
  it('a missing chart type falls back to bar and says so', () => {
    const p = propose({ grafico: undefined })
    expect(p.chartType).toBe('bar')
    expect(p.scartati[0]).toMatchObject({ what: '—', key: 'reportProposal.discard.chartUnknown' })
  })

  it('grouping on a node cited by entity name, or on an unknown/dropped node, falls back correctly', () => {
    const base = { nodi: [node(), node({ id: 'b', entita: 'team' })], collegamenti: [{ da: 'a', verso: 'b', relazione: 'ASSIGNED_TO_TEAM' }] }
    expect(propose({ ...base, raggruppa_per_entita: 'TEAM', raggruppa_per_campo: 'name' })).toMatchObject({ groupByNodeId: 'n2', groupByField: 'name' })
    expect(propose({ ...base, raggruppa_per_entita: 'nowhere' }).groupByNodeId).toBe('n1')
    // The team node is unreachable without the edge: grouping on it would group on a dropped node.
    expect(propose({ nodi: base.nodi, raggruppa_per_entita: 'b' }).groupByNodeId).toBe('n1')
  })

  it('without a usable group field: series fall back to created_at, categories to status, else null', () => {
    expect(propose({ grafico: 'line' }).groupByField).toBe('created_at')
    expect(propose({ grafico: 'pie' }).groupByField).toBe('status')
    const team = propose({ grafico: 'bar', nodi: [node({ entita: 'team' })] })
    // No invented grouping: the builder asks the person instead.
    expect(team.groupByField).toBeNull()
    expect(propose({ grafico: 'area', nodi: [node({ entita: 'team' })] }).groupByField).toBeNull()
  })

  it('kpi and table do not group', () => {
    expect(propose({ grafico: 'kpi', raggruppa_per_campo: 'status' })).toMatchObject({ groupByNodeId: null, groupByField: null })
  })

  it('an unknown metric becomes a count and is reported', () => {
    const p = propose({ metrica: 'median' })
    expect(p.metric).toBe('count')
    expect(p.scartati).toContainEqual(expect.objectContaining({ what: 'median', key: 'reportProposal.discard.metricUnknown' }))
  })

  it('a metric on a numeric root field is kept', () => {
    expect(propose({ metrica: 'avg', metrica_campo: 'Minutes' })).toMatchObject({ metric: 'avg', metricField: 'minutes' })
  })

  it('a metric without a field, or on a non-numeric one, becomes a count with the right reason', () => {
    const missing = propose({ metrica: 'sum' })
    expect(missing.metric).toBe('count')
    expect(missing.scartati).toContainEqual(expect.objectContaining({ what: 'sum', key: 'reportProposal.discard.metricFieldUnknown', params: { name: '—', entity: 'Incident' } }))
    expect(keys(propose({ metrica: 'avg', metrica_campo: 'status' }))).toContain('reportProposal.discard.metricFieldNotNumber')
  })

  it('the limit is capped to what the builder can show, and defaults to 20 when invalid', () => {
    const capped = propose({ limite: 500 })
    expect(capped.limit).toBe(MAX_LIMITE_PROPONIBILE)
    expect(keys(capped)).toContain('reportProposal.discard.limitCapped')
    expect(propose({ limite: 0 }).limit).toBe(20)
    expect(propose({ limite: 'many' }).limit).toBe(20)
    expect(propose({ limite: 7 }).limit).toBe(7)
  })
})

describe('the period of a date grouping', () => {
  it('an unknown period on a series becomes "day" and is reported', () => {
    const p = propose({ grafico: 'line', raggruppa_per_periodo: 'fortnight' })
    expect(p.groupByGranularity).toBe('day')
    expect(keys(p)).toContain('reportProposal.discard.granularityUnknown')
  })

  it('a bar chart grouped by a date also gets a period', () => {
    expect(propose({ raggruppa_per_campo: 'created_at', raggruppa_per_periodo: 'month' }).groupByGranularity).toBe('month')
  })

  it('a period on a non-date grouping is dropped, naming the field (or a placeholder)', () => {
    const p = propose({ raggruppa_per_campo: 'status', raggruppa_per_periodo: 'week' })
    expect(p.groupByGranularity).toBeNull()
    expect(p.scartati).toContainEqual(expect.objectContaining({ key: 'reportProposal.discard.granularityNotADate', params: { name: 'status' } }))
    const kpi = propose({ grafico: 'kpi', raggruppa_per_periodo: 'week' })
    expect(kpi.scartati).toContainEqual(expect.objectContaining({ key: 'reportProposal.discard.granularityNotADate', params: { name: '—' } }))
  })
})

describe('columns', () => {
  it('blank column names are ignored, duplicates (by name or label) kept once', () => {
    const p = propose({ nodi: [node({ colonne: ['', 'number', 'Number', 'status', 'nope'] })] })
    expect(p.nodes[0]!.selectedFields).toEqual(['number', 'status'])
    expect(keys(p)).toEqual(['reportProposal.discard.fieldUnknown'])
  })

  it('a table on an entity without fields gets no guessed columns (and no false report of one)', () => {
    const p = propose({ grafico: 'table', nodi: [node({ entita: 'EmptyThing' })] })
    expect(p.nodes[0]!.selectedFields).toEqual([])
    expect(keys(p)).not.toContain('reportProposal.discard.columnsGuessed')
  })

  it('non-root nodes are included in the result only when asked', () => {
    const p = propose({
      nodi: [node(), node({ id: 'b', entita: 'team', nel_risultato: 'yes' })],
      collegamenti: [{ da: 'a', verso: 'b', relazione: 'ASSIGNED_TO_TEAM' }],
    })
    // A non-boolean answer is not a yes.
    expect(p.nodes.map((n) => n.isResult)).toEqual([true, false])
  })
})

describe('filters', () => {
  it('a filter without a field name is dropped with a placeholder', () => {
    const r = filtersOf([{ operatore: 'eq', valore: 'x' }])
    expect(r.filters).toBeNull()
    expect(r.keys).toEqual(['reportProposal.discard.filterFieldUnknown'])
  })

  it('the operator defaults to eq; a free-text field keeps any value', () => {
    expect(filtersOf([{ campo: 'number', valore: 'INC-1' }]).filters).toEqual([{ field: 'number', operator: 'eq', value: 'INC-1' }])
  })

  it('"last N days" on a non-date field is dropped: it would make the query explode', () => {
    expect(filtersOf([{ campo: 'status', operatore: 'last_n_days', valore: 7 }]).keys).toEqual(['reportProposal.discard.operatorForType'])
  })

  it('"contains" on a number or a boolean is dropped', () => {
    expect(filtersOf([{ campo: 'minutes', operatore: 'contains', valore: '4' }]).keys).toEqual(['reportProposal.discard.operatorForType'])
    expect(filtersOf([{ campo: 'major', operatore: 'contains', valore: 'tr' }]).keys).toEqual(['reportProposal.discard.operatorForType'])
  })

  it('null checks carry no value', () => {
    expect(filtersOf([{ campo: 'number', operatore: 'is_not_null', valore: 'ignored' }]).filters)
      .toEqual([{ field: 'number', operator: 'is_not_null', value: null }])
  })

  it('"last N days" wants a positive whole number of days', () => {
    expect(filtersOf([{ campo: 'created_at', operatore: 'last_n_days', valore: '14' }]).filters)
      .toEqual([{ field: 'created_at', operator: 'last_n_days', value: 14 }])
    const r = filtersOf([{ campo: 'created_at', operatore: 'last_n_days' }])
    expect(r.filters).toBeNull()
    expect(r.keys).toEqual(['reportProposal.discard.filterDays'])
  })

  it('"in" accepts a list in valori, a list in valore, or a single valore', () => {
    expect(filtersOf([{ campo: 'status', operatore: 'in', valori: ['NEW', 'closed'] }]).filters)
      .toEqual([{ field: 'status', operator: 'in', value: ['new', 'closed'] }])
    expect(filtersOf([{ campo: 'status', operatore: 'in', valore: ['closed'] }]).filters)
      .toEqual([{ field: 'status', operator: 'in', value: ['closed'] }])
    expect(filtersOf([{ campo: 'status', operatore: 'in', valore: 'new' }]).filters)
      .toEqual([{ field: 'status', operator: 'in', value: ['new'] }])
  })

  it('"in" without any value is dropped', () => {
    expect(filtersOf([{ campo: 'status', operatore: 'in', valori: ['', '  '] }]).keys).toEqual(['reportProposal.discard.filterEmpty'])
  })

  it('an equality without a value is dropped', () => {
    expect(filtersOf([{ campo: 'number', operatore: 'neq', valore: '  ' }]).keys).toEqual(['reportProposal.discard.filterEmpty'])
  })

  it('a numeric field gets a number, never the string "443" that would never match', () => {
    expect(filtersOf([{ campo: 'minutes', operatore: 'eq', valore: '443' }]).filters).toEqual([{ field: 'minutes', operator: 'eq', value: 443 }])
    expect(filtersOf([{ campo: 'minutes', operatore: 'eq', valore: 30 }]).filters).toEqual([{ field: 'minutes', operator: 'eq', value: 30 }])
    expect(filtersOf([{ campo: 'minutes', operatore: 'eq', valore: 'lots' }]).keys).toEqual(['reportProposal.discard.filterNotANumber'])
  })

  it('a boolean field gets a boolean, and only true/false are accepted', () => {
    expect(filtersOf([{ campo: 'major', operatore: 'eq', valore: 'TRUE' }]).filters).toEqual([{ field: 'major', operator: 'eq', value: true }])
    expect(filtersOf([{ campo: 'major', operatore: 'neq', valore: 'false' }]).filters).toEqual([{ field: 'major', operator: 'neq', value: false }])
    expect(filtersOf([{ campo: 'major', operatore: 'eq', valore: 'yes' }]).keys).toEqual(['reportProposal.discard.filterNotABoolean'])
  })

  it('a value outside the vocabulary drops the filter instead of keeping a filter that never matches', () => {
    const r = filtersOf([{ campo: 'status', operatore: 'eq', valore: 'Chiuso' }])
    expect(r.filters).toBeNull()
    expect(r.keys).toEqual(['reportProposal.discard.filterValueUnknown'])
  })
})

describe('sezioneDaProposta', () => {
  it('copies nodes and edges into a fresh section, detached from the proposal arrays', () => {
    const p = propose({
      nodi: [node({ colonne: ['number'] }), node({ id: 'b', entita: 'team' })],
      collegamenti: [{ da: 'a', verso: 'b', relazione: 'ASSIGNED_TO_TEAM' }],
    })
    const s = sezioneDaProposta(p)
    expect(s).toMatchObject({ id: 'proposta', order: 0, title: p.title, chartType: 'bar', limit: 20 })
    expect(s.edges).toHaveLength(1)
    // Editing the section in the builder must not mutate the proposal it came from.
    s.nodes[0]!.selectedFields.push('status')
    expect(p.nodes[0]!.selectedFields).toEqual(['number'])
  })
})
