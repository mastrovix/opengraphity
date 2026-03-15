import { authResolvers } from './auth.js'
import { incidentResolvers } from './incident.js'
import { cmdbResolvers } from './cmdb.js'
import { problemResolvers } from './problem.js'
import { changeResolvers } from './change.js'
import { serviceRequestResolvers } from './service_request.js'
import { teamResolvers } from './team.js'
import { workflowResolvers } from './workflow.js'
import { notificationChannelResolvers } from './notificationChannel.js'
import { reportResolvers } from './report.js'
import type { GraphQLContext } from '../../context.js'

// ── me + users stubs ──────────────────────────────────────────────────────────

import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

function mapUser(props: Record<string, unknown>) {
  return {
    id:        props['id']         as string,
    tenantId:  props['tenant_id']  as string,
    email:     props['email']      as string,
    name:      props['name']       as string,
    role:      props['role']       as string,
    teamId:    null,
    createdAt: props['created_at'] as string | null,
  }
}

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
        RETURN properties(u) AS props, null AS teamId ORDER BY u.name
      `, { tenantId: ctx.tenantId })
      return rows.map((r) => mapUser(r.props))
    } finally {
      await session.close()
    }
  },
}

async function userById(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (u:User {id: $id, tenant_id: $tenantId})
      RETURN properties(u) AS props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  } finally {
    await session.close()
  }
}

async function userTeams(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Record<string, unknown> }
    const rows = await runQuery<Row>(session, `
      MATCH (u:User {id: $id})-[:MEMBER_OF]->(t:Team)
      WHERE t.tenant_id = $tenantId
      RETURN properties(t) AS props
      ORDER BY t.name
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({
      id:          r.props['id']          as string,
      tenantId:    r.props['tenant_id']   as string,
      name:        r.props['name']        as string,
      description: r.props['description'] as string | null,
      type:        r.props['type']        as string | null,
      createdAt:   r.props['created_at']  as string,
    }))
  } finally {
    await session.close()
  }
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
    ...reportResolvers.Query,
    ...meStub,
    user: userById,
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
    ...reportResolvers.Mutation,
  },
  Incident: {
    ...incidentResolvers.Incident,
    ...workflowResolvers.Incident,
  },
  ConfigurationItem: {
    ...cmdbResolvers.ConfigurationItem,
    ...teamResolvers.ConfigurationItem,
  },
  Team:                teamResolvers.Team,
  User:                { teams: userTeams },
  Problem:             problemResolvers.Problem,
  Change: {
    ...changeResolvers.Change,
  },
  DeployStep:     {},
  AssessmentTask: {},
  ChangeValidation: {},
  ServiceRequest:      serviceRequestResolvers.ServiceRequest,
  ReportConversation:  reportResolvers.ReportConversation,
}
