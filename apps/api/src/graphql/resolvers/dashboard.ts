import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { executeReportSection } from '../../lib/reportExecutor.js'
import { withSession } from './ci-utils.js'
import { audit } from '../../lib/audit.js'

type Props = Record<string, unknown>

// ── loadReportSection ─────────────────────────────────────────────────────────

async function loadReportSection(sectionId: string, tenantId: string) {
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

function mapDashboardConfig(props: Props) {
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

function mapDashboardWidget(props: Props) {
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

// ── Query resolvers ───────────────────────────────────────────────────────────

async function myDashboards(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (d:DashboardConfig)
        WHERE d.tenant_id = $tenantId
          AND (
            d.user_id = $userId
            OR d.visibility = 'all'
            OR (d.visibility = 'teams' AND
              EXISTS {
                MATCH (d)-[:SHARED_WITH]->(t:Team)<-[:MEMBER_OF]-(u:User {id: $userId})
              })
          )
        RETURN properties(d) AS props
        ORDER BY d.created_at DESC
        `,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    return result.records.map((r) => mapDashboardConfig(r.get('props') as Props))
  })
}

async function dashboard(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `
        MATCH (d:DashboardConfig {id: $id})
        WHERE d.tenant_id = $tenantId
          AND (
            d.user_id = $userId
            OR d.visibility = 'all'
            OR (d.visibility = 'teams' AND
              EXISTS {
                MATCH (d)-[:SHARED_WITH]->(t:Team)<-[:MEMBER_OF]-(u:User {id: $userId})
              })
          )
        RETURN properties(d) AS props
        `,
        { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    if (!result.records.length) return null
    return mapDashboardConfig(result.records[0].get('props') as Props)
  })
}

async function myDashboard(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    // 1. Dashboard with is_default=true matching user's role
    const r1 = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, is_default: true, role: $role})
         WHERE d.is_shared = true OR d.user_id = $userId
         RETURN properties(d) AS props LIMIT 1`,
        { tenantId: ctx.tenantId, role: ctx.role, userId: ctx.userId },
      ),
    )
    if (r1.records.length) return mapDashboardConfig(r1.records[0].get('props') as Props)

    // 2. Dashboard with is_default=true and no role restriction
    const r2 = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, is_default: true})
         WHERE d.role IS NULL AND (d.is_shared = true OR d.user_id = $userId)
         RETURN properties(d) AS props LIMIT 1`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    if (r2.records.length) return mapDashboardConfig(r2.records[0].get('props') as Props)

    // 3. User's first personal dashboard
    const r3 = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId})
         RETURN properties(d) AS props ORDER BY d.created_at ASC LIMIT 1`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    if (r3.records.length) return mapDashboardConfig(r3.records[0].get('props') as Props)

    return null
  })
}

// ── Field resolvers: DashboardConfig ─────────────────────────────────────────

async function dashboardWidgets(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget)
         RETURN properties(w) AS w ORDER BY w.order ASC`,
        { id: parent.id, tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapDashboardWidget(r.get('w') as Props))
  } finally {
    await session.close()
  }
}

async function dashboardCreatedBy(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:CREATED_BY]->(u:User)
         RETURN properties(u) AS u`,
        { id: parent.id, tenantId: ctx.tenantId },
      ),
    )
    if (!result.records.length) return null
    const u = result.records[0].get('u') as Props
    return { id: u['id'] as string, name: u['name'] as string, email: u['email'] as string }
  })
}

async function dashboardSharedWith(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:SHARED_WITH]->(t:Team)
         RETURN properties(t) AS t`,
        { id: parent.id, tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => {
      const t = r.get('t') as Props
      return { id: t['id'] as string, name: t['name'] as string }
    })
  })
}

// ── Field resolvers: DashboardWidget ─────────────────────────────────────────

async function widgetReportTemplate(
  parent: { reportTemplateId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.reportTemplateId) return null
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (t:ReportTemplate {id: $id, tenant_id: $tenantId}) RETURN properties(t) AS t`,
        { id: parent.reportTemplateId, tenantId: ctx.tenantId },
      ),
    )
    if (!result.records.length) return null
    const t = result.records[0].get('t') as Props
    return {
      id:          t['id']              as string,
      name:        t['name']            as string,
      description: (t['description']   ?? null) as string | null,
      visibility:  (t['visibility']    ?? null) as string | null,
    }
  })
}

async function widgetReportSection(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.reportSectionId) return null
  return loadReportSection(parent.reportSectionId, ctx.tenantId)
}

async function widgetData(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  try {
    const section = await loadReportSection(parent.reportSectionId, ctx.tenantId)
    if (!section) return null
    const result = await executeReportSection(section, ctx.tenantId)
    return result.data
  } catch {
    return null
  }
}

async function widgetError(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  try {
    const section = await loadReportSection(parent.reportSectionId, ctx.tenantId)
    if (!section) return 'Sezione non trovata'
    await executeReportSection(section, ctx.tenantId)
    return null
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createDashboard(
  _: unknown,
  args: {
    input: {
      name: string
      description?: string | null
      role?: string | null
      visibility: string
      isShared?: boolean | null
      sharedWithTeamIds?: string[] | null
    }
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { name, description, role, visibility, isShared, sharedWithTeamIds } = args.input
  const session = getSession(undefined, 'WRITE')
  try {
    // Check if this is the first dashboard for this user
    const countResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) RETURN count(d) AS cnt`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    const isFirst = Math.round(Number(countResult.records[0].get('cnt'))) === 0

    const created = await session.executeWrite((tx) =>
      tx.run(
        `
        CREATE (d:DashboardConfig {
          id: randomUUID(),
          tenant_id: $tenantId,
          user_id: $userId,
          name: $name,
          description: $description,
          role: $role,
          visibility: $visibility,
          is_default: $isDefault,
          is_personal: true,
          is_shared: $isShared,
          created_at: $now,
          updated_at: $now
        })
        RETURN properties(d) AS props
        `,
        {
          tenantId: ctx.tenantId, userId: ctx.userId,
          name, description: description ?? null, role: role ?? null,
          visibility, isDefault: isFirst, isShared: isShared ?? false, now,
        },
      ),
    )
    if (!created.records.length) throw new Error('Failed to create dashboard')

    // Create CREATED_BY rel (best-effort)
    await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (d:DashboardConfig {id: $dashId})
        OPTIONAL MATCH (u:User {id: $userId})
        FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
          CREATE (d)-[:CREATED_BY]->(u)
        )
        `,
        { dashId: (created.records[0].get('props') as Props)['id'] as string, userId: ctx.userId },
      ),
    )
    const props = created.records[0].get('props') as Props
    const dashId = props['id'] as string
    void audit(ctx, 'dashboard.created', 'DashboardConfig', dashId)

    // Create SHARED_WITH rels
    if (sharedWithTeamIds && sharedWithTeamIds.length > 0) {
      await session.executeWrite((tx) =>
        tx.run(
          `
          MATCH (d:DashboardConfig {id: $dashId})
          UNWIND $teamIds AS teamId
          MATCH (t:Team {id: teamId, tenant_id: $tenantId})
          MERGE (d)-[:SHARED_WITH]->(t)
          `,
          { dashId, teamIds: sharedWithTeamIds, tenantId: ctx.tenantId },
        ),
      )
    }

    return mapDashboardConfig(props)
  } finally {
    await session.close()
  }
}

async function updateDashboard(
  _: unknown,
  args: {
    id: string
    input: {
      name?: string | null
      description?: string | null
      role?: string | null
      visibility?: string | null
      isShared?: boolean | null
      sharedWithTeamIds?: string[] | null
      isDefault?: boolean | null
    }
  },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { name, description, role, visibility, isShared, sharedWithTeamIds, isDefault } = args.input
  const session = getSession(undefined, 'WRITE')
  try {
    const setParts: string[] = ['d.updated_at = $now']
    const params: Record<string, unknown> = { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, now }

    if (name        != null) { setParts.push('d.name = $name');               params['name'] = name }
    if (description != null) { setParts.push('d.description = $description'); params['description'] = description }
    if (role        != null) { setParts.push('d.role = $role');               params['role'] = role }
    if (visibility  != null) { setParts.push('d.visibility = $visibility');   params['visibility'] = visibility }
    if (isShared    != null) { setParts.push('d.is_shared = $isShared');      params['isShared'] = isShared }

    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId, user_id: $userId})
         SET ${setParts.join(', ')}
         RETURN properties(d) AS props`,
        params,
      ),
    )
    if (!result.records.length) throw new Error('Dashboard not found or access denied')

    // Set as default: unset others, then set this
    if (isDefault) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) SET d.is_default = false`,
          { tenantId: ctx.tenantId, userId: ctx.userId },
        ),
      )
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) SET d.is_default = true`,
          { id: args.id, tenantId: ctx.tenantId },
        ),
      )
    }

    // Re-create SHARED_WITH rels if provided
    if (sharedWithTeamIds != null) {
      await session.executeWrite((tx) =>
        tx.run(
          `MATCH (d:DashboardConfig {id: $id})-[r:SHARED_WITH]->() DELETE r`,
          { id: args.id },
        ),
      )
      if (sharedWithTeamIds.length > 0) {
        await session.executeWrite((tx) =>
          tx.run(
            `
            MATCH (d:DashboardConfig {id: $id})
            UNWIND $teamIds AS teamId
            MATCH (t:Team {id: teamId, tenant_id: $tenantId})
            MERGE (d)-[:SHARED_WITH]->(t)
            `,
            { id: args.id, teamIds: sharedWithTeamIds, tenantId: ctx.tenantId },
          ),
        )
      }
    }

    // Refetch updated props
    const updated = await session.executeRead((tx) =>
      tx.run(`MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS props`, { id: args.id, tenantId: ctx.tenantId }),
    )
    void audit(ctx, 'dashboard.updated', 'DashboardConfig', args.id)
    return mapDashboardConfig(updated.records[0].get('props') as Props)
  } finally {
    await session.close()
  }
}

async function deleteDashboard(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    // Check user has more than one dashboard
    const countResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId, user_id: $userId}) RETURN count(d) AS cnt`,
        { tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    const cnt = Math.round(Number(countResult.records[0].get('cnt')))
    if (cnt <= 1) throw new Error('Non puoi eliminare l\'unica dashboard')

    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId, user_id: $userId}) DETACH DELETE d`,
        { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId },
      ),
    )
    void audit(ctx, 'dashboard.deleted', 'DashboardConfig', args.id)
    return true
  } finally {
    await session.close()
  }
}

async function addDashboardWidget(
  _: unknown,
  args: { input: { dashboardId: string; reportTemplateId: string; reportSectionId: string; colSpan: number; order?: number | null } },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const { dashboardId, reportTemplateId, reportSectionId, colSpan } = args.input
  const session = getSession(undefined, 'WRITE')
  try {
    // Get max order
    const orderResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget)
         RETURN coalesce(max(w.order), -1) AS maxOrder`,
        { dashId: dashboardId, tenantId: ctx.tenantId },
      ),
    )
    const maxOrderRaw = orderResult.records[0]?.get('maxOrder')
    const maxOrder = maxOrderRaw != null ? Math.round(Number(maxOrderRaw)) : -1
    const order = Math.round(Number(args.input.order ?? maxOrder + 1))

    // Get dashboard props
    const dashResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId}) RETURN properties(d) AS d`,
        { dashId: dashboardId, tenantId: ctx.tenantId },
      ),
    )
    if (!dashResult.records.length) throw new Error('Dashboard not found')
    const dashProps = dashResult.records[0].get('d') as Props

    // Create widget
    await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (d:DashboardConfig {id: $dashId, tenant_id: $tenantId})
        CREATE (w:DashboardWidget {
          id: randomUUID(),
          dashboard_id: $dashId,
          report_template_id: $reportTemplateId,
          report_section_id: $reportSectionId,
          col_span: toInteger($colSpan),
          order: toInteger($order),
          created_at: $now
        })
        CREATE (d)-[:HAS_WIDGET]->(w)
        `,
        { dashId: dashboardId, tenantId: ctx.tenantId, reportTemplateId, reportSectionId, colSpan: Math.round(Number(colSpan ?? 4)), order, now },
      ),
    )

    return mapDashboardConfig(dashProps)
  } finally {
    await session.close()
  }
}

async function removeDashboardWidget(
  _: unknown,
  args: { widgetId: string },
  ctx: GraphQLContext,
) {
  const session = getSession(undefined, 'WRITE')
  try {
    // Get the dashboard before deleting
    const dashResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: $widgetId})
         RETURN properties(d) AS d`,
        { widgetId: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    const dashProps = dashResult.records.length > 0 ? dashResult.records[0].get('d') as Props : null

    if (!dashProps) throw new Error('Dashboard not found')

    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: $widgetId}) DETACH DELETE w`,
        { widgetId: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    return mapDashboardConfig(dashProps)
  } finally {
    await session.close()
  }
}

async function updateDashboardWidget(
  _: unknown,
  args: { widgetId: string; input: { colSpan?: number | null; order?: number | null } },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()
  const setParts: string[] = ['w.updated_at = $now']
  const params: Record<string, unknown> = { widgetId: args.widgetId, now }

  if (args.input.colSpan != null) {
    setParts.push('w.col_span = $colSpan')
    params['colSpan'] = args.input.colSpan
  }
  if (args.input.order != null) {
    setParts.push('w.order = $order')
    params['order'] = args.input.order
  }

  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: $widgetId}) SET ${setParts.join(', ')}`,
        { ...params, tenantId: ctx.tenantId },
      ),
    )
    // Return the parent dashboard
    const dashResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: $widgetId})
         RETURN properties(d) AS d`,
        { widgetId: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    if (!dashResult.records.length) throw new Error('Dashboard not found')
    return mapDashboardConfig(dashResult.records[0].get('d') as Props)
  } finally {
    await session.close()
  }
}

async function reorderDashboardWidgets(
  _: unknown,
  args: { dashboardId: string; widgetIds: string[] },
  ctx: GraphQLContext,
) {
  const items = args.widgetIds.map((id, i) => ({ id, order: i }))
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `
        UNWIND $items AS item
        MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: item.id})
        SET w.order = item.order
        `,
        { items, dashboardId: args.dashboardId, tenantId: ctx.tenantId },
      ),
    )
    const dashResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS d`,
        { id: args.dashboardId, tenantId: ctx.tenantId },
      ),
    )
    if (!dashResult.records.length) throw new Error('Dashboard not found')
    return mapDashboardConfig(dashResult.records[0].get('d') as Props)
  } finally {
    await session.close()
  }
}

async function cloneDashboard(_: unknown, args: { id: string; newName: string }, ctx: GraphQLContext) {
  const newId = uuidv4()
  const now   = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    // Load source dashboard
    const src = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS p`,
        { id: args.id, tenantId: ctx.tenantId },
      ),
    )
    if (!src.records.length) throw new Error('Dashboard non trovata')
    const sp = src.records[0].get('p') as Props

    // Create cloned dashboard
    await session.executeWrite((tx) =>
      tx.run(
        `CREATE (d:DashboardConfig {
           id: $newId, tenant_id: $tenantId, user_id: $userId,
           name: $name, description: $description, role: $role,
           visibility: $visibility, is_default: false,
           is_personal: true, is_shared: $isShared,
           created_at: $now, updated_at: $now
         })`,
        {
          newId, tenantId: ctx.tenantId, userId: ctx.userId,
          name:        args.newName,
          description: (sp['description'] ?? null) as string | null,
          role:        (sp['role']        ?? null) as string | null,
          visibility:  (sp['visibility']  ?? 'private') as string,
          isShared:    (sp['is_shared']   ?? false) as boolean,
          now,
        },
      ),
    )

    // Clone legacy DashboardWidget nodes
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (src:DashboardConfig {id: $srcId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget)
         MATCH (dst:DashboardConfig {id: $dstId, tenant_id: $tenantId})
         CREATE (wc:DashboardWidget {
           id: randomUUID(), dashboard_id: $dstId,
           report_template_id: w.report_template_id,
           report_section_id:  w.report_section_id,
           col_span: w.col_span, order: w.order, created_at: $now
         })
         CREATE (dst)-[:HAS_WIDGET]->(wc)`,
        { srcId: args.id, dstId: newId, tenantId: ctx.tenantId, now },
      ),
    )

    // Clone CustomWidget nodes
    await session.executeWrite((tx) =>
      tx.run(
        `MATCH (src:DashboardConfig {id: $srcId, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
         MATCH (dst:DashboardConfig {id: $dstId, tenant_id: $tenantId})
         CREATE (wc:CustomWidget {
           id: randomUUID(), tenant_id: $tenantId, dashboard_id: $dstId,
           title: w.title, widget_type: w.widget_type, entity_type: w.entity_type,
           metric: w.metric, group_by_field: w.group_by_field,
           filter_field: w.filter_field, filter_value: w.filter_value,
           time_range: w.time_range, size: w.size, color: w.color,
           position: w.position, created_by: $userId, created_at: $now
         })
         CREATE (dst)-[:HAS_CUSTOM_WIDGET]->(wc)`,
        { srcId: args.id, dstId: newId, tenantId: ctx.tenantId, userId: ctx.userId, now },
      ),
    )

    void audit(ctx, 'dashboard.cloned', 'DashboardConfig', newId, { sourceDashboardId: args.id })

    const res = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId}) RETURN properties(d) AS p`,
        { id: newId, tenantId: ctx.tenantId },
      ),
    )
    return mapDashboardConfig(res.records[0].get('p') as Props)
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const dashboardResolvers = {
  Query: {
    myDashboards,
    myDashboard,
    dashboard,
  },
  Mutation: {
    createDashboard,
    updateDashboard,
    deleteDashboard,
    cloneDashboard,
    addDashboardWidget,
    removeDashboardWidget,
    updateDashboardWidget,
    reorderDashboardWidgets,
  },
  DashboardConfig: {
    widgets:    dashboardWidgets,
    createdBy:  dashboardCreatedBy,
    sharedWith: dashboardSharedWith,
    customWidgets: async (parent: { id: string }, _: unknown, ctx: GraphQLContext) => {
      const session = getSession(undefined, 'READ')
      try {
        const result = await session.executeRead((tx) =>
          tx.run(
            `MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:HAS_CUSTOM_WIDGET]->(w:CustomWidget)
             RETURN properties(w) AS w ORDER BY w.position ASC`,
            { id: parent.id, tenantId: ctx.tenantId },
          ),
        )
        return result.records.map((r) => {
          const p = r.get('w') as Props
          return {
            id: p['id'] as string, title: p['title'] as string,
            widgetType: p['widget_type'] as string, entityType: p['entity_type'] as string,
            metric: p['metric'] as string,
            groupByField: (p['group_by_field'] ?? null) as string | null,
            filterField:  (p['filter_field']   ?? null) as string | null,
            filterValue:  (p['filter_value']   ?? null) as string | null,
            timeRange:    (p['time_range']      ?? null) as string | null,
            size:    (p['size']  ?? 'medium') as string,
            color:   (p['color'] ?? '#0EA5E9') as string,
            position: Math.round(Number(p['position'] ?? 0)),
            dashboardId: p['dashboard_id'] as string,
          }
        })
      } finally {
        await session.close()
      }
    },
  },
  DashboardWidget: {
    reportTemplate: widgetReportTemplate,
    reportSection:  widgetReportSection,
    data:           widgetData,
    error:          widgetError,
  },
}
