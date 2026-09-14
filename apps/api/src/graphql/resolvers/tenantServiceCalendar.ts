/**
 * Il calendario di servizio del cliente — la porta dall'interfaccia (revisione
 * del 14 set 2026 · F6).
 */
import type { GraphQLContext } from '../../context.js'
import { requireRole } from '../../lib/requireRole.js'
import { audit } from '../../lib/audit.js'
import { setTenantServiceCalendar, tenantServiceCalendar } from '../../lib/tenantServiceCalendar.js'

async function tenantServiceCalendarQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  return tenantServiceCalendar(ctx.tenantId)
}

async function setTenantServiceCalendarMutation(_: unknown, args: { calendar: unknown }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const calendar = await setTenantServiceCalendar(ctx.tenantId, args.calendar)
  void audit(ctx, 'tenant.service_calendar.updated', 'Tenant', ctx.tenantId, { ...calendar })
  return calendar
}

export const tenantServiceCalendarResolvers = {
  Query:    { tenantServiceCalendar: tenantServiceCalendarQuery },
  Mutation: { setTenantServiceCalendar: setTenantServiceCalendarMutation },
}
