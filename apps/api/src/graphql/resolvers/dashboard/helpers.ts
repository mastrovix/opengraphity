import { withSession } from '../ci-utils.js'

export type Props = Record<string, unknown>

// ── loadReportSection ─────────────────────────────────────────────────────────

export async function loadReportSection(sectionId: string, tenantId: string) {
  return withSession(async (session) => {
    const r = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (r:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection {id: $id})
        OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
        OPTIONAL MATCH (n)-[e:REPORT_EDGE]->(m:ReportNode)
        RETURN s,
          collect(DISTINCT n) AS nodes,
          collect(DISTINCT { edge: properties(e), sourceId: n.id, targetId: m.id }) AS edges
        `,
        { id: sectionId, tenantId },
      ),
    )
    if (!r.records.length) return null

    const s = r.records[0].get('s').properties as Props
    const nodes = (r.records[0].get('nodes') as Array<{ properties: Props }>)
      .filter((n) => n && n.properties)
      .map((n) => n.properties)
    const edges = (r.records[0].get('edges') as Array<{ edge: Props; sourceId: string; targetId: string }>)
      .filter((e) => e && e.edge && e.edge['id'])

    return {
      id:            s['id']              as string,
      title:         s['title']           as string,
      chartType:     s['chart_type']      as string,
      groupByNodeId: (s['group_by_node_id'] ?? null) as string | null,
      groupByField:  (s['group_by_field']   ?? null) as string | null,
      metric:        (s['metric']           ?? 'count') as string,
      metricField:   (s['metric_field']     ?? null) as string | null,
      order:         Math.round(Number(s['order'] ?? 0)),
      limit:         s['limit'] != null ? Math.round(Number(s['limit'])) : null,
      sortDir:       (s['sort_dir'] ?? null) as string | null,
      nodes: nodes.map((n) => ({
        id:             n['id']              as string,
        entityType:     n['entity_type']     as string,
        neo4jLabel:     n['neo4j_label']     as string,
        label:          n['label']           as string,
        isResult:       (n['is_result'] ?? false) as boolean,
        isRoot:         (n['is_root']   ?? false) as boolean,
        positionX:      Number(n['position_x'] ?? 0),
        positionY:      Number(n['position_y'] ?? 0),
        filters:        (n['filters']         ?? null) as string | null,
        selectedFields: (n['selected_fields'] ?? [])  as string[],
      })),
      edges: edges.map((e) => ({
        id:               e.edge['id']                as string,
        sourceNodeId:     e.sourceId,
        targetNodeId:     e.targetId,
        relationshipType: e.edge['relationship_type'] as string,
        direction:        e.edge['direction']         as string,
        label:            (e.edge['label'] ?? '')       as string,
      })),
    }
  })
}

// ── Mappers ───────────────────────────────────────────────────────────────────

export function mapDashboardConfig(props: Props) {
  return {
    id:          props['id']           as string,
    name:        props['name']         as string,
    description: (props['description'] ?? null) as string | null,
    role:        (props['role']        ?? null) as string | null,
    isDefault:   (props['is_default']  ?? false) as boolean,
    isPersonal:  (props['is_personal'] ?? false) as boolean,
    isShared:    (props['is_shared']   ?? false) as boolean,
    visibility:  (props['visibility']  ?? 'private') as string,
    createdAt:   props['created_at']   as string,
    updatedAt:   (props['updated_at']  ?? null) as string | null,
    // resolved by field resolvers
    widgets:       [] as ReturnType<typeof mapDashboardWidget>[],
    customWidgets: [] as unknown[],
    sharedWith:    [] as unknown[],
    createdBy:     null as unknown,
  }
}

export function mapDashboardWidget(props: Props) {
  return {
    id:               props['id']                 as string,
    order:            Math.round(Number(props['order']    ?? 0)),
    colSpan:          Math.round(Number(props['col_span'] ?? 4)),
    reportTemplateId: props['report_template_id']  as string,
    reportSectionId:  props['report_section_id']   as string,
    data:             null as string | null,
    error:            null as string | null,
  }
}
