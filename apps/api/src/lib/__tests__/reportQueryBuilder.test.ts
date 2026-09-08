import { describe, it, expect } from 'vitest'
import { GraphQLError } from 'graphql'
import { buildReportQuery, validateReportSection, type ReportSectionDef, type ReportNodeDef, type ReportEdgeDef } from '../reportQueryBuilder.js'
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
      'WHERE n0.status IN $n0_f0 AND n0.created_at > datetime() - duration({days: $n0_f1}) AND toLower(n0.title) CONTAINS toLower($n0_f2) AND n0.resolved_at IS NULL',
      'MATCH (n0)-[:ASSIGNED_TO_TEAM]->(n1:Team)',
      'RETURN n1.name AS label, count(n0) AS value',
      'ORDER BY value ASC',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    expect(params).toEqual({
      tenantId: TENANT, limit: 5,
      n0_f0: ['open', 'assigned'], n0_f1: 30, n0_f2: 'db',
    })
  })

  it('edge stored from child to root: direction is interpreted relative to the BFS parent (legacy semantics preserved)', () => {
    const build = (direction: string) => buildReportQuery(section({
      chartType: 'pie',
      nodes: [
        node({ id: 'team', isRoot: true, neo4jLabel: 'Team' }),
        node({ id: 'user', neo4jLabel: 'User', filters: JSON.stringify([{ field: 'role', operator: 'neq', value: 'viewer' }]) }),
      ],
      edges: [edge({ id: 'e1', sourceNodeId: 'user', targetNodeId: 'team', relationshipType: 'MEMBER_OF', direction })],
    }), TENANT, whitelist).query

    expect(build('incoming')).toBe([
      'MATCH (n0:Team {tenant_id: $tenantId})',
      'MATCH (n0)<-[:MEMBER_OF]-(n1:User)',
      'WHERE n1.role <> $n1_f0',
      'RETURN n0.status AS label, count(n0) AS value',
      'ORDER BY value DESC',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    expect(build('outgoing')).toContain('MATCH (n0)-[:MEMBER_OF]->(n1:User)')
  })

  it('line chart defaults to created_at', () => {
    const { query } = buildReportQuery(section({ chartType: 'line' }), TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'RETURN date(n0.created_at) AS label, count(n0) AS value',
      'ORDER BY label ASC',
    ].join('\n'))
  })

  it('table: aliases are generated (c0, c1…) and display names come from node labels', () => {
    const sec = section({
      chartType: 'table',
      nodes: [
        node({ id: 'root', isRoot: true, isResult: true, label: 'Incidenti aperti', selectedFields: ['title', 'createdAt'] }),
        node({ id: 'team', neo4jLabel: 'Team', isResult: true, label: 'Team) RETURN 1 //', selectedFields: ['name'] }),
      ],
      edges: [edge({ id: 'e1', sourceNodeId: 'root', targetNodeId: 'team' })],
    })
    const { query, columns } = buildReportQuery(sec, TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'MATCH (n0)-[:ASSIGNED_TO_TEAM]->(n1:Team)',
      'RETURN n0.title AS c0, n0.created_at AS c1, n1.name AS c2',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    // The label text (which may contain anything) is UI-only, never in Cypher.
    expect(query).not.toContain('RETURN 1')
    expect(columns).toEqual([
      { alias: 'c0', name: 'Incidenti_aperti_title' },
      { alias: 'c1', name: 'Incidenti_aperti_createdAt' },
      { alias: 'c2', name: 'Team)_RETURN_1_//_name' },
    ])
  })

  it('table with no selected fields falls back to the root id column', () => {
    const { query, columns } = buildReportQuery(section({ chartType: 'table' }), TENANT, whitelist)
    expect(query).toBe([
      'MATCH (n0:Incident {tenant_id: $tenantId})',
      'RETURN n0.id AS c0',
      'LIMIT toInteger($limit)',
    ].join('\n'))
    expect(columns).toEqual([{ alias: 'c0', name: 'id' }])
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
