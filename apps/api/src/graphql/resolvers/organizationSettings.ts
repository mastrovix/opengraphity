/**
 * Impostazioni dell'organizzazione con una porta dall'interfaccia: i
 * calendari di servizio con nome e la conservazione delle notifiche della
 * campanella (verifica «Cosa resta cablato», ondata 2).
 */
import type { GraphQLContext } from '../../context.js'
import { requirePermission } from '../../lib/permissions.js'
import { audit } from '../../lib/audit.js'
import { createServiceCalendar, deleteServiceCalendar, serviceCalendars, updateServiceCalendar } from '../../lib/serviceCalendars.js'
import { setTenantInAppRetentionDays, tenantInAppRetentionDays } from '../../lib/tenantInAppRetention.js'

async function serviceCalendarsQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  return serviceCalendars(ctx.tenantId)
}

async function createServiceCalendarMutation(_: unknown, args: { name: string; calendar: unknown }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.organization')
  const calendar = await createServiceCalendar(ctx.tenantId, args)
  void audit(ctx, 'service_calendar.created', 'ServiceCalendar', calendar.id, { name: calendar.name })
  return calendar
}

async function updateServiceCalendarMutation(_: unknown, args: { id: string; name?: string | null; calendar?: unknown }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.organization')
  const calendar = await updateServiceCalendar(ctx.tenantId, args.id, {
    ...(args.name != null ? { name: args.name } : {}),
    ...(args.calendar != null ? { calendar: args.calendar } : {}),
  })
  void audit(ctx, 'service_calendar.updated', 'ServiceCalendar', calendar.id, { name: calendar.name })
  return calendar
}

async function deleteServiceCalendarMutation(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.organization')
  await deleteServiceCalendar(ctx.tenantId, args.id)
  void audit(ctx, 'service_calendar.deleted', 'ServiceCalendar', args.id)
  return true
}

async function tenantInAppRetentionDaysQuery(_: unknown, __: unknown, ctx: GraphQLContext) {
  return tenantInAppRetentionDays(ctx.tenantId)
}

async function setTenantInAppRetentionDaysMutation(_: unknown, args: { days: number }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.organization')
  const days = await setTenantInAppRetentionDays(ctx.tenantId, args.days)
  void audit(ctx, 'tenant.inapp_retention.updated', 'Tenant', ctx.tenantId, { days })
  return days
}

export const organizationSettingsResolvers = {
  Query:    { serviceCalendars: serviceCalendarsQuery, tenantInAppRetentionDays: tenantInAppRetentionDaysQuery },
  Mutation: {
    createServiceCalendar: createServiceCalendarMutation,
    updateServiceCalendar: updateServiceCalendarMutation,
    deleteServiceCalendar: deleteServiceCalendarMutation,
    setTenantInAppRetentionDays: setTenantInAppRetentionDaysMutation,
  },
}
