/**
 * Nome, marchio, numerazione, allegati e AI dell'organizzazione (verifica «Cosa
 * resta cablato», ondata 6). Le regole stanno nei moduli di `lib/`; qui si
 * espongono, si scrive l'Audit Log e si limita alla pagina Organizzazione.
 */
import type { GraphQLContext } from '../../context.js'
import { requirePermission } from '../../lib/permissions.js'
import { audit } from '../../lib/audit.js'
import { config } from '../../lib/config.js'
import { setTenantName, tenantName } from '../../lib/tenantName.js'
import { logoUrlOf, setTenantBrandTexts, tenantBrand } from '../../lib/brand.js'
import { setTicketNumbering, ticketNumbering, type TicketNumbering } from '../../lib/ticketNumbering.js'
import { PLATFORM_ATTACHMENT_EXTENSIONS, attachmentPolicy, setAttachmentPolicy, type AttachmentPolicy } from '../../lib/attachmentPolicy.js'
import { aiSettings, setAISettings, type AISettings } from '../../lib/aiSettings.js'
import { getScriptingPlan, setScriptingEnabled } from '../../lib/scriptingPlan.js'

const brandSettingsView = (tenantId: string, b: Awaited<ReturnType<typeof tenantBrand>>) => ({
  displayName: b.displayName, senderName: b.senderName, replyTo: b.replyTo,
  logoUrl: logoUrlOf(tenantId, b), logoMimeType: b.logo?.mimeType ?? null, isDefault: b.isDefault,
})

const numberingView = (n: TicketNumbering & { isDefault: boolean }) => ({
  incident: n.incident, problem: n.problem, change: n.change, serviceRequest: n.service_request, isDefault: n.isDefault,
})

const policyView = (p: AttachmentPolicy & { isDefault: boolean }) => ({
  ...p, platformMaxSizeMb: config.attachmentMaxMbCap, platformExtensions: [...PLATFORM_ATTACHMENT_EXTENSIONS],
})

const aiView = (s: AISettings & { isDefault: boolean }) => ({ ...s, platformConfigured: Boolean(config.anthropicApiKey) })

export const organizationProfileResolvers = {
  Query: {
    tenantName: (_: unknown, __: unknown, ctx: GraphQLContext) => tenantName(ctx.tenantId),
    tenantBrand: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const b = await tenantBrand(ctx.tenantId)
      return { displayName: b.displayName, logoUrl: logoUrlOf(ctx.tenantId, b), isDefault: b.isDefault }
    },
    tenantBrandSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => brandSettingsView(ctx.tenantId, await tenantBrand(ctx.tenantId)),
    ticketNumbering: async (_: unknown, __: unknown, ctx: GraphQLContext) => numberingView(await ticketNumbering(ctx.tenantId)),
    attachmentPolicy: async (_: unknown, __: unknown, ctx: GraphQLContext) => policyView(await attachmentPolicy(ctx.tenantId)),
    aiSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => aiView(await aiSettings(ctx.tenantId)),
    scriptingSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const { plan, enabled } = await getScriptingPlan(ctx.tenantId)
      return { enabled, plan }
    },
  },
  Mutation: {
    setTenantName: async (_: unknown, args: { name: string }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const before = await tenantName(ctx.tenantId)
      const name = await setTenantName(ctx.tenantId, args.name)
      void audit(ctx, 'tenant.name.updated', 'Tenant', ctx.tenantId, { from: before, to: name })
      return name
    },
    setTenantBrand: async (_: unknown, args: { input: { displayName: string; senderName: string; replyTo?: string | null } }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const b = await setTenantBrandTexts(ctx.tenantId, { displayName: args.input.displayName, senderName: args.input.senderName, replyTo: args.input.replyTo ?? null })
      void audit(ctx, 'tenant.brand.updated', 'Tenant', ctx.tenantId, { displayName: b.displayName, senderName: b.senderName, replyTo: b.replyTo })
      return brandSettingsView(ctx.tenantId, b)
    },
    setTicketNumbering: async (_: unknown, args: { input: Record<'incident' | 'problem' | 'change' | 'serviceRequest', { prefix: string; digits: number }> }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const { serviceRequest, ...rest } = args.input
      const n = await setTicketNumbering(ctx.tenantId, { ...rest, service_request: serviceRequest })
      const { isDefault: _d, ...to } = n
      void audit(ctx, 'tenant.ticket_numbering.updated', 'Tenant', ctx.tenantId, { to })
      return numberingView(n)
    },
    setAttachmentPolicy: async (_: unknown, args: { input: { maxSizeMb: number; extensions: string[] } }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const p = await setAttachmentPolicy(ctx.tenantId, { ...args.input })
      void audit(ctx, 'tenant.attachment_policy.updated', 'Tenant', ctx.tenantId, { maxSizeMb: p.maxSizeMb, extensions: p.extensions })
      return policyView(p)
    },
    /**
     * L'interruttore degli script (ondata 6). Sta in Organizzazione e non nel
     * piano: una formula di un campo calcolato è uno script, e legarla al piano
     * vorrebbe dire campi calcolati spenti su metà dei tenant.
     */
    setScriptingEnabled: async (_: unknown, args: { enabled: boolean }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const before = await getScriptingPlan(ctx.tenantId)
      const after = await setScriptingEnabled(ctx.tenantId, args.enabled === true)
      void audit(ctx, 'tenant.scripting.updated', 'Tenant', ctx.tenantId, { from: before.enabled, to: after.enabled })
      return { enabled: after.enabled, plan: after.plan }
    },
    setAISettings: async (_: unknown, args: { input: AISettings }, ctx: GraphQLContext) => {
      requirePermission(ctx, 'config.organization')
      const before = await aiSettings(ctx.tenantId)
      const s = await setAISettings(ctx.tenantId, { ...args.input, features: { ...args.input.features } })
      const { isDefault: _b, ...from } = before
      const { isDefault: _s, ...to } = s
      void audit(ctx, 'tenant.ai_settings.updated', 'Tenant', ctx.tenantId, { from, to })
      return aiView(s)
    },
  },
}
