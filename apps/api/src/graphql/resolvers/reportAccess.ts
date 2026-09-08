// Ownership / visibility checks for report templates and dashboards.
//
// Report visibility (ReportTemplate.visibility): 'private' | 'all' | 'groups'
//   read : owner, or everyone in the tenant ('all'), or members of a SHARED_WITH team ('groups')
//   write: owner; tenant admin on non-private templates
// Dashboard (DashboardConfig.user_id owner, visibility 'private' | 'all' | 'teams'):
//   read : owner, or 'all', or members of a SHARED_WITH team ('teams')
//   write: owner or tenant admin
//
// Every helper resolves the entity by (id, tenant_id) first: a missing entity
// is a NotFoundError, an entity of another user is a ForbiddenError — never a
// silent no-op.

import type { Session } from 'neo4j-driver'
import type { GraphQLContext } from '../../context.js'
import { ForbiddenError, NotFoundError } from '../../lib/errors.js'

export type AccessMode = 'read' | 'write'

export interface ReportTemplateAccess {
  createdBy:    string | null
  visibility:   string
  isOwner:      boolean
  isTeamMember: boolean
}

export async function assertReportTemplateAccess(
  session: Session,
  templateId: string,
  ctx: GraphQLContext,
  mode: AccessMode,
): Promise<ReportTemplateAccess> {
  const res = await session.executeRead(tx =>
    tx.run(`
      MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (r)-[:SHARED_WITH]->(t:Team {tenant_id: $tenantId})<-[:MEMBER_OF]-(u:User {id: $userId, tenant_id: $tenantId})
      RETURN r.created_by AS createdBy, r.visibility AS visibility, count(t) > 0 AS isTeamMember
    `, { id: templateId, tenantId: ctx.tenantId, userId: ctx.userId }),
  )
  if (!res.records.length) throw new NotFoundError('ReportTemplate', templateId)

  const row = res.records[0]!
  const createdBy    = (row.get('createdBy') as string | null) ?? null
  const visibility   = (row.get('visibility') as string | null) ?? 'private'
  const isTeamMember = row.get('isTeamMember') === true
  const isOwner      = createdBy !== null && createdBy === ctx.userId
  const isAdmin      = ctx.role === 'admin'

  if (mode === 'read') {
    if (isOwner || visibility === 'all' || (visibility === 'groups' && isTeamMember)) {
      return { createdBy, visibility, isOwner, isTeamMember }
    }
    throw new ForbiddenError(`ReportTemplate ${templateId} is not shared with you`)
  }

  if (isOwner || (isAdmin && visibility !== 'private')) {
    return { createdBy, visibility, isOwner, isTeamMember }
  }
  throw new ForbiddenError(`Only the owner${visibility === 'private' ? '' : ' or a tenant admin'} can modify ReportTemplate ${templateId}`)
}

export interface DashboardAccess {
  ownerId:      string | null
  visibility:   string
  isOwner:      boolean
  isTeamMember: boolean
}

export async function assertDashboardAccess(
  session: Session,
  dashboardId: string,
  ctx: GraphQLContext,
  mode: AccessMode,
): Promise<DashboardAccess> {
  const res = await session.executeRead(tx =>
    tx.run(`
      MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (d)-[:SHARED_WITH]->(t:Team {tenant_id: $tenantId})<-[:MEMBER_OF]-(u:User {id: $userId, tenant_id: $tenantId})
      RETURN d.user_id AS ownerId, d.visibility AS visibility, count(t) > 0 AS isTeamMember
    `, { id: dashboardId, tenantId: ctx.tenantId, userId: ctx.userId }),
  )
  if (!res.records.length) throw new NotFoundError('Dashboard', dashboardId)

  const row = res.records[0]!
  const ownerId      = (row.get('ownerId') as string | null) ?? null
  const visibility   = (row.get('visibility') as string | null) ?? 'private'
  const isTeamMember = row.get('isTeamMember') === true
  const isOwner      = ownerId !== null && ownerId === ctx.userId
  const isAdmin      = ctx.role === 'admin'

  if (mode === 'read') {
    if (isOwner || visibility === 'all' || (visibility === 'teams' && isTeamMember)) {
      return { ownerId, visibility, isOwner, isTeamMember }
    }
    throw new ForbiddenError(`Dashboard ${dashboardId} is not shared with you`)
  }

  if (isOwner || isAdmin) return { ownerId, visibility, isOwner, isTeamMember }
  throw new ForbiddenError(`Only the owner or a tenant admin can modify Dashboard ${dashboardId}`)
}

/** Convenience: owner-or-admin check by dashboard id (write mode). */
export async function assertDashboardOwner(session: Session, dashboardId: string, ctx: GraphQLContext): Promise<DashboardAccess> {
  return assertDashboardAccess(session, dashboardId, ctx, 'write')
}

export type DashboardWidgetKind = 'widget' | 'customWidget'

/**
 * Resolves the dashboard a widget belongs to (tenant-scoped). Throws
 * NotFoundError when the widget does not exist in this tenant.
 */
export async function resolveDashboardIdForWidget(
  session: Session,
  widgetId: string,
  kind: DashboardWidgetKind,
  tenantId: string,
): Promise<string> {
  const rel   = kind === 'widget' ? 'HAS_WIDGET' : 'HAS_CUSTOM_WIDGET'
  const label = kind === 'widget' ? 'DashboardWidget' : 'CustomWidget'
  const res = await session.executeRead(tx =>
    tx.run(
      `MATCH (d:DashboardConfig {tenant_id: $tenantId})-[:${rel}]->(w:${label} {id: $widgetId})
       RETURN d.id AS dashboardId`,
      { widgetId, tenantId },
    ),
  )
  if (!res.records.length) throw new NotFoundError(label, widgetId)
  return res.records[0]!.get('dashboardId') as string
}

/** Owner-or-admin check for the dashboard that contains `widgetId`. */
export async function assertDashboardOwnerByWidget(
  session: Session,
  widgetId: string,
  kind: DashboardWidgetKind,
  ctx: GraphQLContext,
): Promise<string> {
  const dashboardId = await resolveDashboardIdForWidget(session, widgetId, kind, ctx.tenantId)
  await assertDashboardAccess(session, dashboardId, ctx, 'write')
  return dashboardId
}
