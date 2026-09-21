/**
 * Il fuso orario del cliente — la porta dall'interfaccia (revisione del 14 set
 * 2026 · F7). Si scriveva solo con `onboard-tenant.ts`; ora si sceglie dalla
 * pagina Organizzazione, accanto alla lingua.
 */
import type { GraphQLContext } from '../../context.js'
import { requirePermission } from '../../lib/permissions.js'
import { audit } from '../../lib/audit.js'
import { availableTimeZones, setTenantTimezone, tenantTimezone } from '../../lib/tenantTimezone.js'

async function settings(tenantId: string) {
  return { timezone: await tenantTimezone(tenantId), available: availableTimeZones() }
}

async function tenantTimezoneSettings(_: unknown, __: unknown, ctx: GraphQLContext) {
  return settings(ctx.tenantId)
}

async function setTenantTimezoneMutation(_: unknown, args: { timezone: string }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.organization')
  const timezone = await setTenantTimezone(ctx.tenantId, args.timezone)
  void audit(ctx, 'tenant.timezone.updated', 'Tenant', ctx.tenantId, { timezone })
  return settings(ctx.tenantId)
}

export const tenantTimezoneResolvers = {
  Query:    { tenantTimezoneSettings },
  Mutation: { setTenantTimezone: setTenantTimezoneMutation },
}
