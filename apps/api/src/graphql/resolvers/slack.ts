/**
 * Slack dell'organizzazione nella pagina Integrazioni (ondata 8 di «Nulla
 * cablato»). Le regole stanno in `lib/slackConnect.ts`; qui si espongono e si
 * scrive l'Audit Log. I segreti non escono mai.
 */
import { loadSlackInstallation, secretsKeyConfigured } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { ValidationError } from '../../lib/errors.js'
import { connectSlackWithToken, disconnectSlack, slackAppAvailable, slackAuthorizeUrl, slackRequestUrls } from '../../lib/slackConnect.js'
import { extractTenantFromHost } from '../../auth/resolveAuth.js'

export const slackResolvers = {
  Query: {
    slackSettings: async (_: unknown, __: unknown, ctx: GraphQLContext) => ({
      installation:        await loadSlackInstallation(ctx.tenantId),
      appInstallAvailable: slackAppAvailable(),
      secretsConfigured:   secretsKeyConfigured(),
      requestUrls:         slackRequestUrls(),
    }),
  },
  Mutation: {
    startSlackInstall: (_: unknown, args: { returnTo: string }, ctx: GraphQLContext) => {
      let url: URL
      try { url = new URL(args.returnTo) } catch { url = new URL('invalid:') }
      // Si torna solo a una pagina di QUESTA organizzazione: niente reindirizzamenti altrove.
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || extractTenantFromHost(url.host) !== ctx.tenantId) {
        throw new ValidationError('The return page must belong to this organization', { key: 'errors.slack.badReturnTo', params: {} })
      }
      return slackAuthorizeUrl(ctx, url.toString())
    },
    connectSlackWithToken: async (_: unknown, args: { botToken: string; signingSecret: string }, ctx: GraphQLContext) => {
      const installation = await connectSlackWithToken(ctx, args.botToken, args.signingSecret)
      void audit(ctx, 'slack.connected', 'SlackInstallation', installation.teamId, { mode: 'token', team: installation.teamName })
      return installation
    },
    disconnectSlack: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const removed = await disconnectSlack(ctx.tenantId)
      if (removed) void audit(ctx, 'slack.disconnected', 'SlackInstallation', removed.teamId, { mode: removed.mode, team: removed.teamName })
      return removed !== null
    },
  },
}
