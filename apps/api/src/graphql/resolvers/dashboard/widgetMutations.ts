import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { mapDashboardConfig, type Props } from './helpers.js'

// ── Widget Mutations ─────────────────────────────────────────────────────────

export async function addDashboardWidget(
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

export async function removeDashboardWidget(
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

export async function updateDashboardWidget(
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

export async function reorderDashboardWidgets(
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
