import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { withSession } from '../ci-utils.js'
import { loadReportSection, mapDashboardConfig, mapDashboardWidget, type Props } from './helpers.js'
import { executeReportSection } from '../../../lib/reportExecutor.js'

// ── Query resolvers ───────────────────────────────────────────────────────────

export async function myDashboards(_: unknown, __: unknown, ctx: GraphQLContext) {
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

export async function dashboard(_: unknown, args: { id: string }, ctx: GraphQLContext) {
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

export async function myDashboard(_: unknown, __: unknown, ctx: GraphQLContext) {
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

export async function dashboardWidgets(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
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

export async function dashboardCreatedBy(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
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

export async function dashboardSharedWith(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
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

export async function dashboardCustomWidgets(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
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
}

// ── Field resolvers: DashboardWidget ─────────────────────────────────────────

export async function widgetReportTemplate(
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

export async function widgetReportSection(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.reportSectionId) return null
  return loadReportSection(parent.reportSectionId, ctx.tenantId)
}

// Executes a widget's report section ONCE per request, memoized on the parent
// object shared by the data/error field resolvers. Previously widgetData
// swallowed result.error (empty widget with no explanation) and widgetError
// RE-EXECUTED the whole query just to recover it.
interface WidgetParent {
  reportSectionId: string
  __widgetResult?: Promise<{ data: string | null; error: string | null }>
}

function resolveWidgetResult(parent: WidgetParent, ctx: GraphQLContext) {
  parent.__widgetResult ??= (async () => {
    try {
      const section = await loadReportSection(parent.reportSectionId, ctx.tenantId)
      if (!section) return { data: null, error: 'Sezione non trovata' }
      const result = await executeReportSection(section, ctx.tenantId)
      // Never discard the section error: an empty widget must say WHY.
      return { data: result.error ? null : result.data, error: result.error }
    } catch (err: unknown) {
      return { data: null, error: err instanceof Error ? err.message : String(err) }
    }
  })()
  return parent.__widgetResult
}

export async function widgetData(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.reportSectionId) return null
  return (await resolveWidgetResult(parent, ctx)).data
}

export async function widgetError(
  parent: { reportSectionId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (!parent.reportSectionId) return null
  return (await resolveWidgetResult(parent, ctx)).error
}
