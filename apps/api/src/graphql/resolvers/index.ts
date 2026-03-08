import { incidentResolvers } from './incident.js'
import { cmdbResolvers } from './cmdb.js'
import { problemResolvers } from './problem.js'
import { changeResolvers } from './change.js'
import { serviceRequestResolvers } from './service_request.js'
import type { GraphQLContext } from '../../context.js'

// ── me stub ───────────────────────────────────────────────────────────────────

const meStub = {
  me: (_: unknown, __: unknown, ctx: GraphQLContext) => ({
    id:       ctx.userId,
    tenantId: ctx.tenantId,
    email:    ctx.userEmail,
    name:     ctx.userEmail,
    role:     ctx.role,
  }),
}

// ── Combined resolvers ────────────────────────────────────────────────────────

export const resolvers = {
  Query: {
    ...incidentResolvers.Query,
    ...cmdbResolvers.Query,
    ...problemResolvers.Query,
    ...changeResolvers.Query,
    ...serviceRequestResolvers.Query,
    ...meStub,
  },
  Mutation: {
    ...incidentResolvers.Mutation,
    ...cmdbResolvers.Mutation,
    ...problemResolvers.Mutation,
    ...changeResolvers.Mutation,
    ...serviceRequestResolvers.Mutation,
  },
  Incident:            incidentResolvers.Incident,
  ConfigurationItem:   cmdbResolvers.ConfigurationItem,
  Problem:             problemResolvers.Problem,
  Change:              changeResolvers.Change,
  ServiceRequest:      serviceRequestResolvers.ServiceRequest,
}
