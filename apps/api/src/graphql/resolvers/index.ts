import { mergeResolvers } from '@graphql-tools/merge'
import type { IResolvers } from '@graphql-tools/utils'
import { authResolvers } from './auth.js'
import { incidentResolvers } from './incident.js'
import { problemResolvers } from './problem.js'
import { changeResolvers } from './change/index.js'
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
import { anomalyResolvers } from './anomaly.js'
import { topologyResolvers } from './topology.js'
import { notificationRuleResolvers } from './notificationRules.js'
import { queueStatsResolvers } from './queueStats.js'
import { syncResolvers } from './sync.js'
import { auditLog } from './auditLog.js'
import { enumTypeResolvers } from './enumType.js'
import { monitoringResolvers } from './monitoring.js'
import { approvalResolvers } from './approval.js'
import { attachmentResolvers } from './attachments.js'
import { commentResolvers } from './comments.js'
import { knowledgeBaseResolvers } from './knowledgeBase.js'
import { reportExportResolvers } from './reportExport.js'
import { portalResolvers } from './portal.js'
import { fieldRulesResolvers } from './fieldRules.js'
import { itilRelationsResolvers } from './itilRelations.js'
import { customWidgetResolvers } from './customWidget.js'
import { automationResolvers } from './automation.js'
import { integrationsResolvers } from './integrations.js'
import { collaborationResolvers } from './collaboration.js'
import { standardChangeCatalogResolvers } from './standardChangeCatalog.js'
import { whatifResolvers } from './whatif.js'
import { changeCalendarResolvers } from './changeCalendar.js'
import { ciRelationshipResolvers } from './ciRelationships.js'
import type { GraphQLContext } from '../../context.js'
import type { CITypeWithDefinitions } from '@opengraphity/schema-generator'

// ── me + users stubs ──────────────────────────────────────────────────────────

import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { neo4jDateToISO } from '../../lib/mappers.js'

function mapUser(props: Record<string, unknown>) {
  return {
    id:        props['id']         as string,
    tenantId:  props['tenant_id']  as string,
    email:     props['email']      as string,
    name:      props['name']       as string,
    code:      props['name']       as string,
    firstName: (props['first_name'] as string) ?? null,
    lastName:  (props['last_name']  as string) ?? null,
    role:      props['role']       as string,
    slackId:   (props['slack_id']  as string) ?? null,
    createdAt: neo4jDateToISO(props['created_at']),
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
  users: async (_: unknown, args: { sortField?: string; sortDirection?: string }, ctx: GraphQLContext) => {
    const session = getSession()
    try {
      const sortMap: Record<string, string> = { name: 'u.name', email: 'u.email', role: 'u.role', createdAt: 'u.created_at' }
      const orderBy = sortMap[args.sortField ?? ''] ?? 'u.name'
      const orderDir = args.sortDirection === 'desc' ? 'DESC' : 'ASC'
      type Row = { props: Record<string, unknown>; teamId: string | null }
      const rows = await runQuery<Row>(session, `
        MATCH (u:User {tenant_id: $tenantId})
        RETURN properties(u) AS props, null AS teamId ORDER BY ${orderBy} ${orderDir}
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
      createdAt:   neo4jDateToISO(r.props['created_at']) ?? '',
    }))
  } finally {
    await session.close()
  }
}

// ── createUser mutation ──────────────────────────────────────────────────────

async function createUser(_: unknown, args: { input: { email: string; name: string; password: string; role: string; teamIds?: string[] } }, ctx: GraphQLContext) {
  const { email, name, password, role, teamIds } = args.input
  const tenantId = ctx.tenantId
  const KEYCLOAK_URL  = process.env['KEYCLOAK_URL'] ?? 'http://localhost:8080'
  const KEYCLOAK_ADMIN_USER = process.env['KEYCLOAK_ADMIN_USER'] ?? 'admin'
  const KEYCLOAK_ADMIN_PASS = process.env['KEYCLOAK_ADMIN_PASSWORD'] ?? 'opengrafo_local'

  // 1. Get Keycloak admin token
  const tokenRes = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: KEYCLOAK_ADMIN_USER, password: KEYCLOAK_ADMIN_PASS }),
  })
  if (!tokenRes.ok) throw new Error('Keycloak admin auth failed')
  const { access_token: adminToken } = await tokenRes.json() as { access_token: string }

  // 2. Create user in Keycloak
  const nameParts = name.split(' ')
  const firstName = nameParts[0] ?? name
  const lastName  = nameParts.slice(1).join(' ') || ''
  const kcRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: email, email, emailVerified: true, enabled: true, firstName, lastName }),
  })
  if (kcRes.status !== 201 && kcRes.status !== 409) throw new Error(`Keycloak user creation failed: ${kcRes.status}`)

  // Get user ID
  const usersRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users?email=${encodeURIComponent(email)}&exact=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const kcUsers = await usersRes.json() as { id: string }[]
  const kcUserId = kcUsers[0]?.id
  if (!kcUserId) throw new Error('User not found in Keycloak after creation')

  // Set password
  await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users/${kcUserId}/reset-password`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ type: 'password', value: password, temporary: false }),
  })

  // Assign role
  const rolesRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/roles`, { headers: { Authorization: `Bearer ${adminToken}` } })
  const allRoles = await rolesRes.json() as { id: string; name: string }[]
  let targetRole = allRoles.find(r => r.name === role)
  if (!targetRole) {
    await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/roles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: role }),
    })
    const refreshed = await (await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/roles`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as { id: string; name: string }[]
    targetRole = refreshed.find(r => r.name === role)
  }
  if (targetRole) {
    await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users/${kcUserId}/role-mappings/realm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify([{ id: targetRole.id, name: targetRole.name }]),
    })
  }

  // 3. Create in Neo4j
  const { v4: uuidv4 } = await import('uuid')
  const id  = uuidv4()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(tx => tx.run(`
      MERGE (u:User {email: $email, tenant_id: $tenantId})
      ON CREATE SET u.id = $id, u.name = $name, u.role = $role, u.active = true, u.created_at = $now, u.updated_at = $now
      ON MATCH SET u.name = $name, u.role = $role, u.updated_at = $now
    `, { email, tenantId, id, name, role, now }))

    // Assign to teams
    if (teamIds && teamIds.length > 0) {
      for (const teamId of teamIds) {
        await session.executeWrite(tx => tx.run(`
          MATCH (u:User {email: $email, tenant_id: $tenantId})
          MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
          MERGE (u)-[:MEMBER_OF]->(t)
        `, { email, tenantId, teamId }))
      }
    }
  } finally { await session.close() }

  return { id, tenantId, email, name, role, teamId: null, createdAt: now }
}

async function updateUserTeams(_: unknown, args: { userId: string; teamIds: string[] }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    // Remove all existing MEMBER_OF relationships
    await session.executeWrite(tx => tx.run(`
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[r:MEMBER_OF]->(:Team)
      DELETE r
    `, { userId: args.userId, tenantId: ctx.tenantId }))

    // Create new MEMBER_OF relationships
    for (const teamId of args.teamIds) {
      await session.executeWrite(tx => tx.run(`
        MATCH (u:User {id: $userId, tenant_id: $tenantId})
        MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
        CREATE (u)-[:MEMBER_OF]->(t)
      `, { userId: args.userId, tenantId: ctx.tenantId, teamId }))
    }

    // Return updated user
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN properties(u) AS props
    `, { userId: args.userId, tenantId: ctx.tenantId })

    if (!row) throw new Error('User not found')
    return mapUser(row.props)
  } finally { await session.close() }
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
      ...anomalyResolvers.Query,
      ...topologyResolvers.Query,
      ...notificationRuleResolvers.Query,
      ...queueStatsResolvers.Query,
      ...monitoringResolvers.Query,
      ...syncResolvers.Query,
      ...enumTypeResolvers.Query,
      ...approvalResolvers.Query,
      ...attachmentResolvers.Query,
      ...commentResolvers.Query,
      ...knowledgeBaseResolvers.Query,
      ...portalResolvers.Query,
      ...fieldRulesResolvers.Query,
      ...itilRelationsResolvers.Query,
      ...customWidgetResolvers.Query,
      ...automationResolvers.Query,
      ...integrationsResolvers.Query,
      ...collaborationResolvers.Query,
      ...standardChangeCatalogResolvers.Query,
      ...whatifResolvers.Query,
      ...changeCalendarResolvers.Query,
      auditLog,
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
      ...anomalyResolvers.Mutation,
      ...notificationRuleResolvers.Mutation,
      ...syncResolvers.Mutation,
      ...enumTypeResolvers.Mutation,
      ...approvalResolvers.Mutation,
      ...attachmentResolvers.Mutation,
      ...commentResolvers.Mutation,
      ...knowledgeBaseResolvers.Mutation,
      ...reportExportResolvers.Mutation,
      ...portalResolvers.Mutation,
      ...fieldRulesResolvers.Mutation,
      ...itilRelationsResolvers.Mutation,
      ...customWidgetResolvers.Mutation,
      ...automationResolvers.Mutation,
      ...integrationsResolvers.Mutation,
      ...collaborationResolvers.Mutation,
      ...standardChangeCatalogResolvers.Mutation,
      ...queueStatsResolvers.Mutation,
      ...ciRelationshipResolvers.Mutation,
      createUser,
      updateUserTeams,
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
    ChangeTask:         { ...changeResolvers.ChangeTask },
    ServiceRequest:     serviceRequestResolvers.ServiceRequest,
    ReportConversation: reportResolvers.ReportConversation,
    DashboardConfig:    { ...dashboardResolvers.DashboardConfig },
    DashboardWidget:    { ...dashboardResolvers.DashboardWidget },
    StandardChangeCatalogEntry: { ...standardChangeCatalogResolvers.StandardChangeCatalogEntry },
  }

  return mergeResolvers([dynamicCI as IResolvers, staticResolvers as IResolvers])
}
