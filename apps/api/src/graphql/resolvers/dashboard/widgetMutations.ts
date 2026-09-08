import { NotFoundError, ValidationError } from '../../../lib/errors.js'
import { getSession, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { audit } from '../../../lib/audit.js'
import { mapDashboardConfig, type Props } from './helpers.js'
import { assertDashboardAccess, assertDashboardOwnerByWidget, assertReportTemplateAccess } from '../reportAccess.js'

// ── Atomic layout save (F-08) ────────────────────────────────────────────────

export interface DashboardLayoutWidgetInput {
  id?: string | null
  reportTemplateId: string
  reportSectionId: string
  colSpan: number
}

/**
 * Replaces the report-widget layout of a dashboard in one transaction.
 * `widgets` is the desired final state in display order:
 *   - entry without id  → CREATE
 *   - entry with id     → SET col_span/order (must belong to this dashboard)
 *   - existing widget not listed → DETACH DELETE
 * Any failure rolls back everything, so the client never ends up with widgets
 * half-persisted (the sequential add/remove/update/reorder it replaced did).
 */
export async function saveDashboardLayout(
  _: unknown,
  args: { dashboardId: string; widgets: DashboardLayoutWidgetInput[] },
  ctx: GraphQLContext,
) {
  const { dashboardId, widgets } = args
  const now = new Date().toISOString()

  const seen = new Set<string>()
  const keepIds: string[] = []
  const updates: Array<{ id: string; colSpan: number; order: number }> = []
  const creates: Array<{ reportTemplateId: string; reportSectionId: string; colSpan: number; order: number }> = []
  widgets.forEach((w, order) => {
    const colSpan = Math.round(Number(w.colSpan))
    if (!Number.isFinite(colSpan) || colSpan < 1 || colSpan > 12) {
      throw new ValidationError(`widget #${order}: colSpan must be between 1 and 12`)
    }
    if (w.id) {
      if (seen.has(w.id)) throw new ValidationError(`widget ${w.id} appears twice in the layout`)
      seen.add(w.id)
      keepIds.push(w.id)
      updates.push({ id: w.id, colSpan, order })
    } else {
      creates.push({ reportTemplateId: w.reportTemplateId, reportSectionId: w.reportSectionId, colSpan, order })
    }
  })

  const session = getSession(undefined, 'WRITE')
  try {
    await assertDashboardAccess(session, dashboardId, ctx, 'write')
    // Every NEW widget must point to a report the caller can read (a widget
    // would otherwise expose someone else's private report on this dashboard).
    for (const templateId of new Set(creates.map(c => c.reportTemplateId))) {
      await assertReportTemplateAccess(session, templateId, ctx, 'read')
    }

    const props = await session.executeWrite(async (tx) => {
      // 1. Delete widgets no longer in the layout
      await tx.run(
        `MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget)
         WHERE NOT w.id IN $keepIds
         DETACH DELETE w`,
        { dashboardId, tenantId: ctx.tenantId, keepIds },
      )

      // 2. Update kept widgets — every id must resolve on THIS dashboard
      if (updates.length) {
        const upd = await tx.run(
          `UNWIND $updates AS u
           MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: u.id})
           SET w.col_span = toInteger(u.colSpan), w.order = toInteger(u.order), w.updated_at = $now
           RETURN count(w) AS n`,
          { updates, dashboardId, tenantId: ctx.tenantId, now },
        )
        const n = toNumber(upd.records[0]?.get('n'))
        if (n !== updates.length) {
          // Throwing inside executeWrite rolls the whole layout back.
          throw new NotFoundError('DashboardWidget', `${updates.length - n} of ${updates.length} widget ids do not belong to dashboard ${dashboardId}`)
        }
      }

      // 3. Create new widgets
      if (creates.length) {
        await tx.run(
          `MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})
           UNWIND $creates AS c
           CREATE (w:DashboardWidget {
             id: randomUUID(),
             dashboard_id: $dashboardId,
             report_template_id: c.reportTemplateId,
             report_section_id: c.reportSectionId,
             col_span: toInteger(c.colSpan),
             order: toInteger(c.order),
             created_at: $now
           })
           CREATE (d)-[:HAS_WIDGET]->(w)`,
          { creates, dashboardId, tenantId: ctx.tenantId, now },
        )
      }

      const dash = await tx.run(
        `MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})
         SET d.updated_at = $now
         RETURN properties(d) AS d`,
        { dashboardId, tenantId: ctx.tenantId, now },
      )
      if (!dash.records.length) throw new NotFoundError('Dashboard', dashboardId)
      return dash.records[0]!.get('d') as Props
    })

    void audit(ctx, 'dashboard.layout_saved', 'DashboardConfig', dashboardId, {
      created: creates.length, kept: updates.length,
    })
    return mapDashboardConfig(props)
  } finally {
    await session.close()
  }
}

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
    // Owner/admin of the dashboard, and the referenced report must be readable
    // by the caller (a widget would otherwise expose someone else's private report).
    await assertDashboardAccess(session, dashboardId, ctx, 'write')
    await assertReportTemplateAccess(session, reportTemplateId, ctx, 'read')

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
    if (!dashResult.records.length) throw new NotFoundError('Dashboard')
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
    await assertDashboardOwnerByWidget(session, args.widgetId, 'widget', ctx)

    // Get the dashboard before deleting
    const dashResult = await session.executeRead((tx) =>
      tx.run(
        `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:HAS_WIDGET]->(w:DashboardWidget {id: $widgetId})
         RETURN properties(d) AS d`,
        { widgetId: args.widgetId, tenantId: ctx.tenantId },
      ),
    )
    const dashProps = dashResult.records.length > 0 ? dashResult.records[0].get('d') as Props : null

    if (!dashProps) throw new NotFoundError('Dashboard')

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
    await assertDashboardOwnerByWidget(session, args.widgetId, 'widget', ctx)
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
    if (!dashResult.records.length) throw new NotFoundError('Dashboard')
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
    await assertDashboardAccess(session, args.dashboardId, ctx, 'write')
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
    if (!dashResult.records.length) throw new NotFoundError('Dashboard')
    return mapDashboardConfig(dashResult.records[0].get('d') as Props)
  } finally {
    await session.close()
  }
}
