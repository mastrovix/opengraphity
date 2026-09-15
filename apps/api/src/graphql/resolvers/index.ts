import { GraphQLError } from 'graphql'
import { requirePermission } from '../../lib/permissions.js'
import { setUserRole as setUserRoleInGraph, tenantRoles } from '../../lib/roles.js'
import { audit } from '../../lib/audit.js'
import { roleResolvers } from './roles.js'
import { slackResolvers } from './slack.js'
import { loginResolvers } from './login.js'
import { applyAuthorizationPolicy } from '../../lib/authorization.js'
import { config } from '../../lib/config.js'
import { NotFoundError } from '../../lib/errors.js'
import { mergeResolvers } from '@graphql-tools/merge'
import { ticketCustomFieldResolvers } from './ticketCustomFields.js'
import type { IResolvers } from '@graphql-tools/utils'
import { incidentResolvers } from './incident.js'
import { problemResolvers } from './problem.js'
import {
  linkRelatedTicket, unlinkRelatedTicket,
  incidentRelatedIncidents, incidentRelatedProblems, incidentRelatedChanges,
  problemLinkedIncidents, problemRelatedProblems, problemLinkedChanges,
} from './relatedTickets.js'
import { changeResolvers } from './change/index.js'
import { serviceRequestResolvers } from './service_request.js'
import { teamResolvers } from './team.js'
import { workflowResolvers } from './workflow.js'
import { notificationChannelResolvers } from './notificationChannel.js'
import { reportResolvers } from './report.js'
import { olaResolvers } from './ola.js'
import { customReportResolvers } from './customReports.js'
import { ciResolvers } from './ci.js'
import { ciGroupResolvers } from './ciGroup.js'
import { logsResolvers } from './logs.js'
import { dashboardResolvers } from './dashboard.js'
import { buildDynamicCIResolvers, dynamicCIRootFields } from './dynamic-ci.js'
import { anomalyResolvers } from './anomaly.js'
import { eventResolvers } from './events.js'
import { serviceResolvers } from './services.js'
import { topologyResolvers } from './topology.js'
import { notificationRuleResolvers } from './notificationRules.js'
import { queueStatsResolvers } from './queueStats.js'
import { syncResolvers } from './sync.js'
import { auditLog, auditActions } from './auditLog.js'
import { enumTypeResolvers } from './enumType.js'
import { domainMatrixResolvers } from './domainMatrix.js'
import { monitoringResolvers } from './monitoring.js'
import { approvalResolvers } from './approval.js'
import { attachmentResolvers } from './attachments.js'
import { globalSearchResolvers } from './globalSearch.js'
import { entityFilterFieldsResolvers } from './entityFilterFields.js'
import { commentResolvers } from './comments.js'
import { knowledgeBaseResolvers } from './knowledgeBase.js'
import { reportExportResolvers } from './reportExport.js'
import { portalResolvers } from './portal.js'
import { fieldRulesResolvers } from './fieldRules.js'
import { ticketCIExclusionResolvers } from './ticketCIExclusions.js'
import { customWidgetResolvers } from './customWidget.js'
import { automationResolvers } from './automation.js'
import { integrationsResolvers } from './integrations.js'
import { collaborationResolvers } from './collaboration.js'
import { whatifResolvers } from './whatif.js'
import { similarityResolvers } from './similarity.js'
import { impactResolvers } from './impact.js'
import { ciRelationshipResolvers } from './ciRelationships.js'
import { cmdbResolvers } from './cmdb.js'
import { tenantLanguageResolvers } from './tenantLanguage.js'
import { tenantTimezoneResolvers } from './tenantTimezone.js'
import { organizationSettingsResolvers } from './organizationSettings.js'
import { organizationProfileResolvers } from './organizationProfile.js'
import { meResolvers } from './me.js'
import { inboxResolvers } from './inbox.js'
const { updateCIFields: updateCIFieldsMutation } = cmdbResolvers.Mutation
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
  me: meResolvers.Query.me,
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

/** I permessi del ruolo della persona; per chi è collegato, quelli con cui l'API lo autorizza. */
async function userPermissions(parent: { id: string; role: string }, _: unknown, ctx: GraphQLContext): Promise<string[]> {
  if (parent.id === ctx.userId) return [...ctx.permissions]
  return [...((await tenantRoles(ctx.tenantId)).get(parent.role)?.permissions ?? [])]
}

async function userRoleName(parent: { role: string }, _: unknown, ctx: GraphQLContext): Promise<string | null> {
  return (await tenantRoles(ctx.tenantId)).get(parent.role)?.name ?? null
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
  requirePermission(ctx, 'admin.users')
  const { email, name, password, role, teamIds } = args.input
  if (!(await tenantRoles(ctx.tenantId)).has(role)) {
    throw new GraphQLError(`Invalid role: ${role}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.authz.invalidRole', params: { role } } } })
  }
  const tenantId = ctx.tenantId
  const KEYCLOAK_URL        = config.keycloakUrl
  const KEYCLOAK_ADMIN_USER = config.keycloakAdminUser
  const KEYCLOAK_ADMIN_PASS = config.keycloakAdminPassword   // requireEnv: throws if unset

  // 1. Get Keycloak admin token
  const tokenRes = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: KEYCLOAK_ADMIN_USER, password: KEYCLOAK_ADMIN_PASS }),
  })
  if (!tokenRes.ok) throw new GraphQLError('Keycloak admin auth failed', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
  const { access_token: adminToken } = await tokenRes.json() as { access_token: string }

  // 2. Create user in Keycloak
  const nameParts = name.split(' ')
  const firstName = nameParts[0] ?? name
  const lastName  = nameParts.slice(1).join(' ') || ''
  const kcRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ username: email, email, emailVerified: true, enabled: true, firstName, lastName }),
  })
  if (kcRes.status !== 201 && kcRes.status !== 409) throw new GraphQLError(`Keycloak user creation failed: ${kcRes.status}`, { extensions: { code: 'INTERNAL_SERVER_ERROR' } })

  // Get user ID
  const usersRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users?email=${encodeURIComponent(email)}&exact=true`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const kcUsers = await usersRes.json() as { id: string }[]
  const kcUserId = kcUsers[0]?.id
  if (!kcUserId) throw new GraphQLError('User not found in Keycloak after creation', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })

  // Set password
  const pwRes = await fetch(`${KEYCLOAK_URL}/admin/realms/${tenantId}/users/${kcUserId}/reset-password`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ type: 'password', value: password, temporary: false }),
  })
  if (!pwRes.ok) throw new GraphQLError(`Keycloak set-password failed: ${pwRes.status}`, { extensions: { code: 'INTERNAL_SERVER_ERROR' } })

  // Il ruolo NON si copia in Keycloak (ondata 7): l'app lo legge solo da
  // `User.role` e dai permessi del `:Role`, e una copia nel realm diventerebbe
  // falsa alla prima modifica.

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

/** Il ruolo di una persona (ondata 7): mai l'ultimo che gestisce persone e ruoli. */
async function setUserRole(_: unknown, args: { userId: string; role: string }, ctx: GraphQLContext) {
  const { previousRole } = await setUserRoleInGraph(ctx.tenantId, args.userId, args.role)
  void audit(ctx, 'user.role_changed', 'User', args.userId, { previousRole, role: args.role })
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session,
      'MATCH (u:User {id: $userId, tenant_id: $tenantId}) RETURN properties(u) AS props', { userId: args.userId, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('User', args.userId)
    return mapUser(row.props)
  } finally { await session.close() }
}

async function updateUserTeams(_: unknown, args: { userId: string; teamIds: string[] }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    // Una transazione sola: prima le cancellazioni e le creazioni erano
    // scritture separate, e un errore a metà lasciava l'utente senza team.
    await session.executeWrite(async (tx) => {
      await tx.run(`
        MATCH (u:User {id: $userId, tenant_id: $tenantId})-[r:MEMBER_OF]->(:Team)
        DELETE r
      `, { userId: args.userId, tenantId: ctx.tenantId })
      await tx.run(`
        MATCH (u:User {id: $userId, tenant_id: $tenantId})
        UNWIND $teamIds AS teamId
        MATCH (t:Team {id: teamId, tenant_id: $tenantId})
        MERGE (u)-[:MEMBER_OF]->(t)
      `, { userId: args.userId, tenantId: ctx.tenantId, teamIds: args.teamIds })
    })

    // Return updated user
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN properties(u) AS props
    `, { userId: args.userId, tenantId: ctx.tenantId })

    if (!row) throw new NotFoundError('User')
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
      ...olaResolvers.Query,
      ...ticketCustomFieldResolvers.Query,
      ...customReportResolvers.Query,
      ...logsResolvers.Query,
      ...dashboardResolvers.Query,
      ...anomalyResolvers.Query,
      ...eventResolvers.Query,
      ...serviceResolvers.Query,
      ...topologyResolvers.Query,
      ...notificationRuleResolvers.Query,
      ...queueStatsResolvers.Query,
      ...monitoringResolvers.Query,
      ...syncResolvers.Query,
      ...enumTypeResolvers.Query,
      ...domainMatrixResolvers.Query,
      ...approvalResolvers.Query,
      ...attachmentResolvers.Query,
      ...globalSearchResolvers.Query,
      ...entityFilterFieldsResolvers.Query,
      ...commentResolvers.Query,
      ...knowledgeBaseResolvers.Query,
      ...portalResolvers.Query,
      ...fieldRulesResolvers.Query,
      ...ticketCIExclusionResolvers.Query,
      ...customWidgetResolvers.Query,
      ...automationResolvers.Query,
      ...integrationsResolvers.Query,
      ...collaborationResolvers.Query,
      ...whatifResolvers.Query,
      ...similarityResolvers.Query,
      ...impactResolvers.Query,
      ...tenantLanguageResolvers.Query,
      ...tenantTimezoneResolvers.Query,
      ...organizationSettingsResolvers.Query,
      ...organizationProfileResolvers.Query,
      ...roleResolvers.Query,
      ...slackResolvers.Query,
      ...loginResolvers.Query,
      ...inboxResolvers.Query,
      auditLog,
      auditActions,
      ciIncidents: ciResolvers.Query.ciIncidents,
      ciChanges:   ciResolvers.Query.ciChanges,
      ciProblems:  ciResolvers.Query.ciProblems,
      ciServiceRequests: ciResolvers.Query.ciServiceRequests,
      ciGroupMembers: ciGroupResolvers.Query.ciGroupMembers,
      ...meStub,
      user: userById,
    },
    Mutation: {
      ...incidentResolvers.Mutation,
      ...problemResolvers.Mutation,
      ...changeResolvers.Mutation,
      linkRelatedTicket,
      unlinkRelatedTicket,
      ...serviceRequestResolvers.Mutation,
      updateCIFields: updateCIFieldsMutation,
      ...teamResolvers.Mutation,
      ...workflowResolvers.Mutation,
      ...notificationChannelResolvers.Mutation,
      ...reportResolvers.Mutation,
      ...olaResolvers.Mutation,
      ...customReportResolvers.Mutation,
      ...dashboardResolvers.Mutation,
      ...anomalyResolvers.Mutation,
      ...eventResolvers.Mutation,
      ...serviceResolvers.Mutation,
      ...similarityResolvers.Mutation,
      ...tenantLanguageResolvers.Mutation,
      ...tenantTimezoneResolvers.Mutation,
      ...organizationSettingsResolvers.Mutation,
      ...organizationProfileResolvers.Mutation,
      ...roleResolvers.Mutation,
      ...slackResolvers.Mutation,
      ...loginResolvers.Mutation,
      ...meResolvers.Mutation,
      ...inboxResolvers.Mutation,
      ...notificationRuleResolvers.Mutation,
      ...syncResolvers.Mutation,
      ...enumTypeResolvers.Mutation,
      ...domainMatrixResolvers.Mutation,
      ...approvalResolvers.Mutation,
      ...attachmentResolvers.Mutation,
      ...commentResolvers.Mutation,
      ...knowledgeBaseResolvers.Mutation,
      ...reportExportResolvers.Mutation,
      ...portalResolvers.Mutation,
      ...fieldRulesResolvers.Mutation,
      ...ticketCIExclusionResolvers.Mutation,
      ...customWidgetResolvers.Mutation,
      ...automationResolvers.Mutation,
      ...integrationsResolvers.Mutation,
      ...collaborationResolvers.Mutation,
      ...queueStatsResolvers.Mutation,
      ...ciRelationshipResolvers.Mutation,
      ...ticketCustomFieldResolvers.Mutation,
      createUser,
      updateUserTeams,
      setUserRole,
    },
    Incident: {
      ...incidentResolvers.Incident,
      ...workflowResolvers.Incident,
      ...eventResolvers.Incident,   // correlatedEvents (Event Management)
      ...serviceResolvers.Incident, // impactedServices (Servizi monitorati)
      linkedIncidents: incidentRelatedIncidents,
      linkedProblems:  incidentRelatedProblems,
      linkedChanges:   incidentRelatedChanges,
      ...ticketCustomFieldResolvers.Incident,
    },
    Change: {
      ...ticketCustomFieldResolvers.Change,
      ...workflowResolvers.Change,
      ...changeResolvers.Change,
      ...eventResolvers.Change,     // suppressedEvents (Event Management)
    },
    /*
      `valueLabels(language)`: l'unico posto che conosce la lingua chiesta.
      Dimenticato QUI la prima volta, ed e' andata esattamente come dice il
      commento sotto — il resolver predefinito trovava `undefined` e la pagina
      riceveva «Cannot return null for non-nullable field
      EnumTypeDefinition.valueLabels». Il test `resolverWiring` doveva
      prenderlo e non l'ha fatto: la sua lista dei moduli era anch'essa a mano.
      Ora quel test scopre i moduli da se.
    */
    EnumTypeDefinition: {
      ...enumTypeResolvers.EnumTypeDefinition,
    },
    // `currentInstances`: quante istanze stanno ORA su uno step. Era stata
    // aggiunta allo SDL e a `workflowResolvers` senza essere unita QUI: i
    // resolver si uniscono tipo per tipo, a mano, quindi un tipo nuovo che non
    // viene aggiunto a questo elenco resta senza resolver. Lo schema
    // dichiarava `Int!`, il resolver predefinito restituiva `undefined`, e il
    // disegnatore riceveva «Cannot return null for non-nullable field». Il test
    // `resolverWiring.test.ts` ora impedisce che ricapiti.
    WorkflowStep:       { ...workflowResolvers.WorkflowStep },
    WorkflowTransition:    { ...workflowResolvers.WorkflowTransition },
    WorkflowTransitionDef: { ...workflowResolvers.WorkflowTransitionDef },
    Team:               teamResolvers.Team,
    User:               { teams: userTeams, permissions: userPermissions, roleName: userRoleName },
    Problem:            {
      ...problemResolvers.Problem,
      linkedIncidents: problemLinkedIncidents,
      linkedProblems:  problemRelatedProblems,
      linkedChanges:   problemLinkedChanges,
      ...ticketCustomFieldResolvers.Problem,
    },
    ProblemComment:     {},
    ServiceRequest:     {
      ...serviceRequestResolvers.ServiceRequest,
      ...workflowResolvers.ServiceRequest,
      ...ticketCustomFieldResolvers.ServiceRequest,
    },
    CIFieldDef:         ticketCustomFieldResolvers.CIFieldDef,
    CustomFieldValue:   ticketCustomFieldResolvers.CustomFieldValue,
    SLAPolicyNode:      automationResolvers.SLAPolicyNode,  // il nome del calendario (ondata 2)
    OLAContract:        olaResolvers.OLAContract,           // il nome del calendario (ondata 2)
    TicketOLA:          olaResolvers.TicketOLA,             // il riquadro OLA/UC del ticket (secondo giro UI del 15 set 2026)
    Event:              eventResolvers.Event,
    EventHistoryEntry:  eventResolvers.EventHistoryEntry,   // cronologia dell'allarme (Event Management)
    ServiceMap:         serviceResolvers.ServiceMap,        // servizi monitorati: nodes/edges/history sono field resolver
    ReportConversation: reportResolvers.ReportConversation,
    DashboardConfig:    { ...dashboardResolvers.DashboardConfig },
    DashboardWidget:    { ...dashboardResolvers.DashboardWidget },
  }

  const merged = mergeResolvers([dynamicCI as IResolvers, staticResolvers as IResolvers])
  // Policy dei permessi su ogni campo root (lib/authorization.ts): unica fonte di
  // verità per "chi può fare cosa"; i controlli locali restano come seconda linea.
  return applyAuthorizationPolicy(merged as Parameters<typeof applyAuthorizationPolicy>[0], { dynamicCI: dynamicCIRootFields(types) }) as IResolvers
}
