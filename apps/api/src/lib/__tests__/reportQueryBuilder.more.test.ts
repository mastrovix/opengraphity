/**
 * reportQueryBuilder — validation and graph-walking paths the main suite does
 * not reach.
 *
 * Why it matters: a report section is stored JSON that comes from the
 * designer, the AI, the API and old saved reports. Each of these shapes is a
 * way to get a WRONG number without an error, which is worse than a failure
 * because nobody notices:
 * - filters that are not a list, or a list of non-objects, must fail rather
 *   than be read as "no filter" (an unfiltered report the user thinks is filtered);
 * - a section with no nodes, or a node without id, must be refused;
 * - a period grouping on a grouped (non-root) node must look at THAT node's
 *   declared date fields, not the root's;
 * - two relationships between the same pair of nodes must both apply: the
 *   second one becomes an EXISTS instead of silently disappearing.
 */
import { describe, it, expect, vi } from 'vitest'
import { GraphQLError } from 'graphql'

// The builder is pure; a transitive import would otherwise open a real Neo4j driver.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
import { buildReportQuery, validateReportSection, type ReportSectionDef, type ReportNodeDef, type ReportEdgeDef } from '../reportQueryBuilder.js'
import type { ReportWhitelist } from '../reportWhitelist.js'

const whitelist: ReportWhitelist = {
  labels:            new Set(['Incident', 'Team', 'User']),
  relationshipTypes: new Set(['ASSIGNED_TO_TEAM', 'OWNED_BY', 'MEMBER_OF']),
  temporalFields:    new Map([['Team', new Set(['founded_on'])], ['Incident', new Set(['data_di_consegna'])]]),
}

const node = (o: Partial<ReportNodeDef> & { id: string }): ReportNodeDef => ({
  entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident',
  isResult: false, isRoot: false, positionX: 0, positionY: 0, filters: null, selectedFields: [], ...o,
})
const edge = (o: Partial<ReportEdgeDef> & { id: string; sourceNodeId: string; targetNodeId: string }): ReportEdgeDef =>
  ({ relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '', ...o })
const section = (o: Partial<ReportSectionDef> = {}): ReportSectionDef => ({
  id: 'sec-1', order: 0, title: 'T', chartType: 'kpi', groupByNodeId: null, groupByField: null,
  metric: 'count', metricField: null, limit: null, sortDir: null,
  nodes: [node({ id: 'root', isRoot: true })], edges: [], ...o,
})
const team = (o: Partial<ReportNodeDef> = {}) => node({ id: 'team', entityType: 'Team', neo4jLabel: 'Team', label: 'Team', ...o })

function expectBadInput(fn: () => unknown, part: string | RegExp) {
  let thrown: unknown
  try { fn() } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(GraphQLError)
  expect((thrown as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  expect((thrown as GraphQLError).message).toMatch(part)
}

describe('filters shape', () => {
  it('a JSON value that is not an array is refused, not read as "no filter"', () => {
    expectBadInput(() => validateReportSection(section({ nodes: [node({ id: 'root', isRoot: true, filters: '{"field":"status"}' })] }), whitelist),
      'filters must be a JSON array')
  })
  it.each([['null', '[null]'], ['a string', '["status=open"]']])('a filter that is %s is refused', (_l, json) => {
    expectBadInput(() => validateReportSection(section({ nodes: [node({ id: 'root', isRoot: true, filters: json })] }), whitelist),
      'filter #0 must be an object')
  })
  it('is_not_null becomes IS NOT NULL with no parameter', () => {
    const built = buildReportQuery(section({ nodes: [node({ id: 'root', isRoot: true, filters: JSON.stringify([{ field: 'resolvedAt', operator: 'is_not_null', value: 'ignored' }]) })] }), 't1', whitelist)
    expect(built.query).toContain('WHERE n0.resolved_at IS NOT NULL')
    expect(Object.keys(built.params).filter((k) => k.includes('_f'))).toEqual([])
  })
})

describe('nodes', () => {
  it('a section with no nodes is refused', () => {
    expectBadInput(() => validateReportSection(section({ nodes: [] }), whitelist), 'at least one node is required')
    expectBadInput(() => validateReportSection(section({ nodes: undefined as never }), whitelist), 'at least one node is required')
  })
  it('a node without id is refused', () => {
    expectBadInput(() => validateReportSection(section({ nodes: [node({ id: '', isRoot: true })] }), whitelist), 'node id is required')
  })
})

describe('period grouping on a grouped node', () => {
  const grouped = (field: string) => section({
    chartType: 'bar', groupByNodeId: 'team', groupByField: field, groupByGranularity: 'month',
    nodes: [node({ id: 'root', isRoot: true }), team()],
    edges: [edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' })],
  })

  it('a date field declared on the grouped entity is accepted', () => {
    expect(() => validateReportSection(grouped('founded_on'), whitelist)).not.toThrow()
  })
  it('a date field declared only on the ROOT entity is not a date on the grouped one', () => {
    expectBadInput(() => validateReportSection(grouped('data_di_consegna'), whitelist), /needs a date field .*"data_di_consegna"/)
  })
})

describe('edges the BFS does not walk', () => {
  it('two relationships from the root to the same node: the second becomes an EXISTS', () => {
    const built = buildReportQuery(section({
      nodes: [node({ id: 'root', isRoot: true }), team()],
      edges: [
        edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' }),
        edge({ id: 'e2', sourceNodeId: 'root', targetNodeId: 'team', relationshipType: 'OWNED_BY' }),
      ],
    }), 't1', whitelist)
    expect(built.query).toContain('MATCH (n0)-[:ASSIGNED_TO_TEAM]->(n1:Team)')
    expect(built.query).toContain('WHERE EXISTS { (n0)-[:OWNED_BY]->(n1) }')
  })

  it('two relationships INTO the root from the same node: the second keeps its direction as an EXISTS', () => {
    const built = buildReportQuery(section({
      nodes: [node({ id: 'root', isRoot: true }), team()],
      edges: [
        edge({ id: 'e1', sourceNodeId: 'team', targetNodeId: 'root' }),
        edge({ id: 'e2', sourceNodeId: 'team', targetNodeId: 'root', relationshipType: 'OWNED_BY', direction: 'incoming' }),
      ],
    }), 't1', whitelist)
    // Walked from the target side: team -[ASSIGNED_TO_TEAM]-> root reads as root <- team.
    expect(built.query).toContain('MATCH (n0)<-[:ASSIGNED_TO_TEAM]-(n1:Team)')
    expect(built.query).toContain('WHERE EXISTS { (n1)<-[:OWNED_BY]-(n0) }')
  })

  // Review of 23 Sep 2026: `WHERE …` / `WHERE EXISTS …` is a Cypher syntax error.
  it('after a filtered node, and with two such edges, there is ONE WHERE that ANDs them', () => {
    const built = buildReportQuery(section({
      nodes: [node({ id: 'root', isRoot: true }), team({ filters: JSON.stringify([{ field: 'name', operator: 'eq', value: 'Desk' }]) })],
      edges: [
        edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' }),
        edge({ id: 'e2', sourceNodeId: 'root', targetNodeId: 'team', relationshipType: 'OWNED_BY' }),
        edge({ id: 'e3', sourceNodeId: 'root', targetNodeId: 'team', relationshipType: 'MEMBER_OF' }),
      ],
    }), 't1', whitelist)
    const lines = built.query.split('\n').map((l) => l.trim())
    const wheres = lines.filter((l) => l.startsWith('WHERE '))
    expect(wheres).toHaveLength(1)
    expect(wheres[0]).toMatch(/^WHERE n1\.name = \$\w+ AND EXISTS \{ \(n0\)-\[:OWNED_BY\]->\(n1\) \} AND EXISTS \{ \(n0\)-\[:MEMBER_OF\]->\(n1\) \}$/)
  })

  it('an edge between two nodes not connected to the root is not applied (nothing to bind it to)', () => {
    const built = buildReportQuery(section({
      nodes: [node({ id: 'root', isRoot: true }), team(), node({ id: 'user', entityType: 'User', neo4jLabel: 'User', label: 'User' })],
      edges: [edge({ id: 'e1', sourceNodeId: 'user', targetNodeId: 'team', relationshipType: 'MEMBER_OF' })],
    }), 't1', whitelist)
    expect(built.query).not.toContain('MEMBER_OF')
    expect(built.query).not.toContain('n1')
  })
})

// Review of 23 Sep 2026: an incident's priority is stored in `severity` — the builder read `priority`, which does not exist.
describe('the fields the graph stores under another name', () => {
  it('an incident\'s priority is read from severity: in the filter, the grouping and the table', () => {
    const built = buildReportQuery(section({
      chartType: 'table',
      nodes: [node({ id: 'root', isRoot: true, isResult: true, selectedFields: ['priority', 'title'], filters: JSON.stringify([{ field: 'priority', operator: 'eq', value: 'critical' }]) })],
    }), 't1', whitelist)
    expect(built.query).toMatch(/WHERE n0\.severity = \$/)
    expect(built.query).toContain('n0.severity AS c0')
    expect(built.query).toContain('n0.title AS c1')
    const grouped = buildReportQuery(section({ chartType: 'bar', groupByField: 'priority' }), 't1', whitelist)
    expect(grouped.query).toContain('n0.severity')
    expect(grouped.query).not.toContain('n0.priority')
  })

  it('a field of another entity keeps its own name', () => {
    const built = buildReportQuery(section({ chartType: 'bar', groupByNodeId: 'team', groupByField: 'priority',
      nodes: [node({ id: 'root', isRoot: true }), team()], edges: [edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' })] }), 't1', whitelist)
    expect(built.query).toContain('n1.priority')
  })
})
