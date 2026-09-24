/** CMDB Health: the page's two reads (services/cmdbHealth.ts). */
import type { GraphQLContext } from '../../context.js'
import { cmdbHealthItems, cmdbHealthSummary } from '../../services/cmdbHealth.js'

export const cmdbHealthResolvers = {
  Query: {
    cmdbHealth: (_: unknown, __: unknown, ctx: GraphQLContext) => cmdbHealthSummary(ctx.tenantId),
    cmdbHealthItems: (
      _: unknown,
      args: { check: string; type?: string | null; environment?: string | null; limit?: number | null; offset?: number | null },
      ctx: GraphQLContext,
    ) => cmdbHealthItems(ctx.tenantId, args.check, { type: args.type, environment: args.environment, limit: args.limit, offset: args.offset }),
  },
}
