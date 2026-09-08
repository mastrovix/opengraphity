/**
 * Single loader for persisted report sections (ReportSection + ReportNode +
 * REPORT_EDGE) → `ReportSectionDef`, the shape `buildReportQuery` consumes.
 *
 * Every execution path (GraphQL executeReport/reportTemplate, PDF/Excel export,
 * dashboard widgets, scheduler) MUST go through here: the review found four
 * loaders with three different semantics (`limit` vs `limit_val`, `selected_fields`
 * parsed vs raw JSON string, nodes/edges never loaded) and the divergences were
 * live bugs (C-04, C-05, C-19).
 *
 * Storage conventions (see customReports.createSectionWithNodesEdges):
 *   ReportSection.limit_val            number | null
 *   ReportNode.selected_fields         JSON string of string[]
 *   REPORT_EDGE                        (source:ReportNode)-[e]->(target:ReportNode)
 */
import type { Session, ManagedTransaction } from 'neo4j-driver'
import { ValidationError } from './errors.js'
import type { ReportEdgeDef, ReportNodeDef, ReportSectionDef } from './reportQueryBuilder.js'
import { toNumber } from '@opengraphity/neo4j'

export type Props = Record<string, unknown>

type Runner = Session | ManagedTransaction

/** `toNumber` (null → 0) with the failure surfaced as a ValidationError of the persisted report. */
function toNum(v: unknown): number {
  try {
    return toNumber(v)
  } catch {
    throw new ValidationError(`Expected a number, got ${JSON.stringify(v)}`)
  }
}

function optInt(v: unknown): number | null {
  if (v == null) return null
  return Math.round(toNum(v))
}

/**
 * `selected_fields` is persisted as a JSON string. A corrupt value must fail
 * the section (it would otherwise silently drop table columns); a Neo4j list
 * is accepted too so a future migration to native lists is a no-op here.
 */
export function parseSelectedFields(raw: unknown, where: string): string[] {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string') throw new ValidationError(`${where}: selected_fields has unexpected type ${typeof raw}`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new ValidationError(`${where}: selected_fields is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  if (!Array.isArray(parsed)) throw new ValidationError(`${where}: selected_fields must be a JSON array`)
  return parsed.map(String)
}

// ── Mappers (the only copies) ─────────────────────────────────────────────────

export function mapSection(p: Props, nodes: ReportNodeDef[] = [], edges: ReportEdgeDef[] = []): ReportSectionDef {
  return {
    id:            p['id']               as string,
    order:         Math.round(toNum(p['order'])),
    title:         (p['title'] ?? '')    as string,
    chartType:     p['chart_type']       as string,
    groupByNodeId: (p['group_by_node_id'] ?? null) as string | null,
    groupByField:  (p['group_by_field']   ?? null) as string | null,
    metric:        (p['metric'] ?? 'count') as string,
    metricField:   (p['metric_field']     ?? null) as string | null,
    limit:         optInt(p['limit_val']),
    sortDir:       (p['sort_dir'] ?? null) as string | null,
    nodes,
    edges,
  }
}

export function mapNode(p: Props): ReportNodeDef {
  const id = p['id'] as string
  return {
    id,
    entityType:     p['entity_type']    as string,
    neo4jLabel:     p['neo4j_label']    as string,
    label:          (p['label'] ?? '')  as string,
    isResult:       p['is_result'] === true,
    isRoot:         p['is_root']   === true,
    positionX:      toNum(p['position_x']),
    positionY:      toNum(p['position_y']),
    filters:        (p['filters'] ?? null) as string | null,
    selectedFields: parseSelectedFields(p['selected_fields'], `report node ${JSON.stringify(id)}`),
  }
}

export function mapEdge(p: Props, sourceNodeId: string, targetNodeId: string): ReportEdgeDef {
  return {
    id:               p['id']                as string,
    sourceNodeId,
    targetNodeId,
    relationshipType: p['relationship_type'] as string,
    direction:        p['direction']         as string,
    label:            (p['label'] ?? '')     as string,
  }
}

// ── Loaders ───────────────────────────────────────────────────────────────────

interface RawEdge { edgeProps: Props; sourceId: string; targetId: string }

// Sections are always reached THROUGH the tenant-scoped template, so a section
// id from another tenant can never be loaded.
const SECTION_GRAPH_CYPHER = `
  OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
  OPTIONAL MATCH (n)-[e:REPORT_EDGE]->(m:ReportNode)
    WHERE (s)-[:HAS_NODE]->(m)
  WITH s,
    collect(DISTINCT properties(n)) AS nodes,
    collect(DISTINCT CASE WHEN e IS NULL THEN null
      ELSE { edgeProps: properties(e), sourceId: n.id, targetId: m.id } END) AS edges
  RETURN properties(s) AS section, nodes, edges
  ORDER BY s.order ASC
`

function rowToSection(row: { get: (k: string) => unknown }): ReportSectionDef {
  const rawNodes = (row.get('nodes') as Array<Props | null>).filter((n): n is Props => !!n && !!n['id'])
  const rawEdges = (row.get('edges') as Array<RawEdge | null>)
    .filter((e): e is RawEdge => !!e && !!e.edgeProps && !!e.edgeProps['id'] && !!e.sourceId && !!e.targetId)
  return mapSection(
    row.get('section') as Props,
    rawNodes.map(mapNode),
    rawEdges.map(e => mapEdge(e.edgeProps, e.sourceId, e.targetId)),
  )
}

async function run(runner: Runner, query: string, params: Props) {
  // A Session gets a managed read transaction; a ManagedTransaction (caller's
  // executeWrite/executeRead) is used directly so the read joins that tx.
  if (typeof (runner as Session).executeRead === 'function') {
    return (runner as Session).executeRead(tx => tx.run(query, params))
  }
  return (runner as ManagedTransaction).run(query, params)
}

/** All sections of a template (ordered), each with its nodes and edges. */
export async function loadTemplateSections(
  runner: Runner,
  templateId: string,
  tenantId: string,
): Promise<ReportSectionDef[]> {
  const res = await run(runner, `
    MATCH (:ReportTemplate {id: $templateId, tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection)
    ${SECTION_GRAPH_CYPHER}
  `, { templateId, tenantId })
  return res.records.map(rowToSection)
}

/** One section by id, reached through its tenant-scoped template. `null` if absent. */
export async function loadSectionById(
  runner: Runner,
  sectionId: string,
  tenantId: string,
): Promise<ReportSectionDef | null> {
  const res = await run(runner, `
    MATCH (:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $sectionId})
    ${SECTION_GRAPH_CYPHER}
  `, { sectionId, tenantId })
  if (!res.records.length) return null
  return rowToSection(res.records[0]!)
}
