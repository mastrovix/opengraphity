import { mergeResolvers } from '@graphql-tools/merge'
import type { IResolvers } from '@graphql-tools/utils'
import { authResolvers } from './auth.js'
import { incidentResolvers } from './incident.js'
import { problemResolvers } from './problem.js'
import { changeResolvers } from './change.js'
import { serviceRequestResolvers } from './service_request.js'
import { teamResolvers } from './team.js'
import { workflowResolvers } from './workflow.js'
import { notificationChannelResolvers } from './notificationChannel.js'
import { reportResolvers } from './report.js'
import { customReportResolvers } from './customReports.js'
import { ciResolvers } from './ci.js'
import { logsResolvers } from './logs.js'
import { dashboardResolvers } from './dashboard.js'
import { buildDynamicCIResolvers } from './dynamic-ci.js'
import type { GraphQLContext } from '../../context.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

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

// Builds a resolver map that combines dynamic CI resolvers (from metamodel)
// with all static non-CI resolvers (incident, change, team, workflow, etc.)
export function buildResolvers(types: CITypeWithDefinitions[]): IResolvers {
  const dynamicCI = buildDynamicCIResolvers(types)

  const staticResolvers = {
    Query: {
      ...incidentResolvers.Query,
      ...problemResolvers.Query,
      ...changeResolvers.Query,
      ...serviceRequestResolvers.Query,
      ...teamResolvers.Query,
      ...workflowResolvers.Query,
      ...notificationChannelResolvers.Query,
      ...reportResolvers.Query,
      ...customReportResolvers.Query,
      ...logsResolvers.Query,
      ...dashboardResolvers.Query,
      ciIncidents: ciResolvers.Query.ciIncidents,
      ciChanges:   ciResolvers.Query.ciChanges,
      ...meStub,
      user: userById,
    },
    Mutation: {
      ...authResolvers.Mutation,
      ...incidentResolvers.Mutation,
      ...problemResolvers.Mutation,
      ...changeResolvers.Mutation,
      ...serviceRequestResolvers.Mutation,
      ...teamResolvers.Mutation,
      ...workflowResolvers.Mutation,
      ...notificationChannelResolvers.Mutation,
      ...reportResolvers.Mutation,
      ...customReportResolvers.Mutation,
      ...dashboardResolvers.Mutation,
    },
    Incident: {
      ...incidentResolvers.Incident,
      ...workflowResolvers.Incident,
    },
    Team:               teamResolvers.Team,
    User:               { teams: userTeams },
    Problem:            { ...problemResolvers.Problem },
    ProblemComment:     {},
    Change:             { ...changeResolvers.Change },
    ChangeTask:         {},
    ServiceRequest:     serviceRequestResolvers.ServiceRequest,
    ReportConversation: reportResolvers.ReportConversation,
    DashboardConfig:    { ...dashboardResolvers.DashboardConfig },
    DashboardWidget:    { ...dashboardResolvers.DashboardWidget },
  }

  return mergeResolvers([dynamicCI as IResolvers, staticResolvers as IResolvers])
}
