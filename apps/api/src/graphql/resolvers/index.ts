import { authResolvers } from './auth.js'
import { incidentResolvers } from './incident.js'
import { cmdbResolvers } from './cmdb.js'
import { problemResolvers } from './problem.js'
import { changeResolvers } from './change.js'
import { serviceRequestResolvers } from './service_request.js'
import { teamResolvers } from './team.js'
import { workflowResolvers } from './workflow.js'
import { notificationChannelResolvers } from './notificationChannel.js'
import type { GraphQLContext } from '../../context.js'

// ── me + users stubs ──────────────────────────────────────────────────────────

import { getSession, runQuery } from '@opengraphity/neo4j'

const meStub = {
  me: (_: unknown, __: unknown, ctx: GraphQLContext) => ({
    id:       ctx.userId,
    tenantId: ctx.tenantId,
    email:    ctx.userEmail,
    name:     ctx.userEmail,
    role:     ctx.role,
  }),
  users: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
    const session = getSession()
    try {
      type Row = { props: Record<string, unknown>; teamId: string | null }
      const rows = await runQuery<Row>(session, `
        MATCH (u:User {tenant_id: $tenantId})
        OPTIONAL MATCH (u)-[:MEMBER_OF]->(t:Team)
        RETURN properties(u) AS props, t.id AS teamId ORDER BY u.name
      `, { tenantId: ctx.tenantId })
      return rows.map((r) => ({
        id:       r.props['id']        as string,
        tenantId: r.props['tenant_id'] as string,
        email:    r.props['email']     as string,
        name:     r.props['name']      as string,
        role:     r.props['role']      as string,
        teamId:   r.teamId ?? null,
      }))
    } finally {
      await session.close()
    }
  },
}

// ── Combined resolvers ────────────────────────────────────────────────────────

export const resolvers = {
  Query: {
    ...incidentResolvers.Query,
    ...cmdbResolvers.Query,
    ...problemResolvers.Query,
    ...changeResolvers.Query,
    ...serviceRequestResolvers.Query,
    ...teamResolvers.Query,
    ...workflowResolvers.Query,
    ...notificationChannelResolvers.Query,
    ...meStub,
  },
  Mutation: {
    ...authResolvers.Mutation,
    ...incidentResolvers.Mutation,
    ...cmdbResolvers.Mutation,
    ...problemResolvers.Mutation,
    ...changeResolvers.Mutation,
    ...serviceRequestResolvers.Mutation,
    ...teamResolvers.Mutation,
    ...workflowResolvers.Mutation,
    ...notificationChannelResolvers.Mutation,
  },
  Incident: {
    ...incidentResolvers.Incident,
    ...workflowResolvers.Incident,
  },
  ConfigurationItem: {
    ...cmdbResolvers.ConfigurationItem,
    ...teamResolvers.ConfigurationItem,
  },
  Problem:             problemResolvers.Problem,
  Change: {
    ...changeResolvers.Change,
  },
  DeployStep:     {},
  AssessmentTask: {},
  ChangeValidation: {},
  ServiceRequest:      serviceRequestResolvers.ServiceRequest,
}
