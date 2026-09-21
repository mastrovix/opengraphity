/**
 * La scheda Accesso dell'organizzazione (ondata 8 di «Nulla cablato»): regole
 * delle password e login aziendale, scritti nel realm Keycloak. Le regole in
 * `lib/tenantLogin.ts`; qui l'Audit Log, mai con segreti.
 */
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import {
  deactivateLoginProvider, loginProviderAddresses, loginProviders, passwordRules, passwordRulesOutOfRange, removeLoginProvider, saveLoginProvider, setPasswordRules, testLoginProvider,
  type LoginProviderInput,
} from '../../lib/tenantLogin.js'

export const loginResolvers = {
  Query: {
    loginSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const [rules, providers] = await Promise.all([passwordRules(ctx.tenantId), loginProviders(ctx.tenantId)])
      // A-19: quello che il realm porta fuori intervallo si DICE alla pagina.
      return {
        passwordRules: rules, providers, addresses: loginProviderAddresses(ctx.tenantId),
        passwordRulesOutOfRange: passwordRulesOutOfRange(rules),
      }
    },
  },
  Mutation: {
    setPasswordRules: async (_: unknown, args: { input: unknown }, ctx: GraphQLContext) => {
      const { before, after } = await setPasswordRules(ctx.tenantId, args.input)
      void audit(ctx, 'login.password_rules_changed', 'Tenant', ctx.tenantId, { before, after })
      return after
    },
    testLoginProvider: (_: unknown, args: { input: LoginProviderInput }, ctx: GraphQLContext) => testLoginProvider(ctx.tenantId, args.input),
    saveLoginProvider: async (_: unknown, args: { input: LoginProviderInput; activate: boolean }, ctx: GraphQLContext) => {
      const { provider, test } = await saveLoginProvider(ctx.tenantId, args.input, args.activate)
      void audit(ctx, 'login.provider_saved', 'LoginProvider', provider.kind, {
        activated: provider.enabled, displayName: provider.displayName, clientId: provider.clientId, tenant: provider.tenant,
        hostedDomain: provider.hostedDomain, metadataUrl: provider.metadataUrl, checks: test?.checks.map((c) => `${c.key}:${c.ok ? 'ok' : 'ko'}`) ?? [],
      })
      return provider
    },
    deactivateLoginProvider: async (_: unknown, args: { kind: string }, ctx: GraphQLContext) => {
      const provider = await deactivateLoginProvider(ctx.tenantId, args.kind)
      void audit(ctx, 'login.provider_deactivated', 'LoginProvider', provider.kind)
      return provider
    },
    removeLoginProvider: async (_: unknown, args: { kind: string }, ctx: GraphQLContext) => {
      await removeLoginProvider(ctx.tenantId, args.kind)
      void audit(ctx, 'login.provider_removed', 'LoginProvider', args.kind)
      return true
    },
  },
}
