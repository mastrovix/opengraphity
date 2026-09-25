import { GraphQLError, type GraphQLResolveInfo } from 'graphql'
import { selectedFields } from '../../lib/selectedFields.js'
import { requirePermission } from '../../lib/permissions.js'
import { setUserActiveInGraph, setUserRole as setUserRoleInGraph, tenantRoles } from '../../lib/roles.js'
import { createRealmUser, deleteRealmUser, emailTakenError, normalizeEmail, setRealmUserEnabled } from '../../lib/tenantUsers.js'
import { logger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { roleResolvers } from './roles.js'
import { slackResolvers } from './slack.js'
import { loginResolvers } from './login.js'
import { applyAuthorizationPolicy } from '../../lib/authorization.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { mergeResolvers } from '@graphql-tools/merge'
import { ticketCustomFieldResolvers } from './ticketCustomFields.js'
import type { IResolvers } from '@graphql-tools/utils'
import { incidentResolvers } from './incident.js'
import { problemResolvers } from './problem.js'
import { changeSuspectResolvers } from './changeSuspects.js'
import { orderByOrThrow } from '../../lib/sortField.js'
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
import { proposalResolvers } from './proposals.js'
import { dailyWorkResolvers } from './dailyWork.js'
import { eventResolvers } from './events.js'
import { serviceResolvers } from './services.js'
import { topologyResolvers } from './topology.js'
import { notificationRuleResolvers } from './notificationRules.js'
import { queueStatsResolvers } from './queueStats.js'
import { syncResolvers } from './sync.js'
import { auditLog, auditActions, auditEntityTypes } from './auditLog.js'
import { ticketTasks, formReferenceFields, claimTicketTask, completeTicketTask, cancelTicketTask } from './ticketTasks.js'
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
import { catalogFormResolvers, formFieldOptions, formFieldTableColumns } from './catalogForm.js'
import { ticketCIExclusionResolvers } from './ticketCIExclusions.js'
import { customWidgetResolvers } from './customWidget.js'
import { automationResolvers } from './automation.js'
import { integrationsResolvers } from './integrations.js'
import { collaborationResolvers } from './collaboration.js'
import { whatifResolvers } from './whatif.js'
import { similarityResolvers } from './similarity.js'
import { impactResolvers } from './impact.js'
import { cmdbHealthResolvers } from './cmdbHealth.js'
import { cmdbChainsResolvers } from './cmdbChains.js'
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

import { getSession, runQuery, runQueryOne, QueryError } from '@opengraphity/neo4j'
import { neo4jDateToISO } from '../../lib/mappers.js'

function mapUser(props: Record<string, unknown>) {
  return {
    id:        props['id']         as string,
    tenantId:  props['tenant_id']  as string,
    email:     props['email']      as string,
    name:      props['name']       as string,
    code:      props['name']       as string,
    active:    props['active'] !== false,
    firstName: (props['first_name'] as string) ?? null,
    lastName:  (props['last_name']  as string) ?? null,
    role:      props['role']       as string,
    slackId:   (props['slack_id']  as string) ?? null,
    createdAt: neo4jDateToISO(props['created_at']),
  }
}

/** Le colonne su cui l'elenco delle persone ordina (guardiano: sortWhitelists.test.ts). */
export const USER_SORT_WHITELIST: Record<string, string> = {
  name:      'u.name',
  email:     'u.email',
  role:      'u.role',
  createdAt: 'u.created_at',
}

const meStub = {
  me: meResolvers.Query.me,
  users: async (_: unknown, args: { sortField?: string; sortDirection?: string }, ctx: GraphQLContext, info?: GraphQLResolveInfo) => {
    const session = getSession()
    try {
      // A-22: un campo non ordinabile è un errore, non un ordine diverso in silenzio.
      const orderBy = orderByOrThrow(USER_SORT_WHITELIST, args.sortField, args.sortDirection, 'u.name ASC', 'users(sortField)')
      // The teams of every user in the SAME query when the client asks for them
      // (review of 23 Sep 2026): User.teams opened one session per user, about
      // 3,000 at once on the demo tenant against a pool of 50.
      type Row = { props: Record<string, unknown>; teams: Record<string, unknown>[] | null }
      const rows = await runQuery<Row>(session, `
        MATCH (u:User {tenant_id: $tenantId})
        RETURN properties(u) AS props,
          CASE WHEN $withTeams THEN [ (u)-[:MEMBER_OF]->(t:Team {tenant_id: $tenantId}) | properties(t) ] END AS teams
        ORDER BY ${orderBy}
      `, { tenantId: ctx.tenantId, withTeams: selectedFields(info).has('teams') })
      return rows.map((r) => (r.teams ? { ...mapUser(r.props), _teams: r.teams } : mapUser(r.props)))
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

function userTeamOf(props: Record<string, unknown>) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    description: props['description'] as string | null,
    type:        props['type']        as string | null,
    createdAt:   neo4jDateToISO(props['created_at']) ?? '',
  }
}

async function userTeams(parent: { id: string; _teams?: Record<string, unknown>[] }, _: unknown, ctx: GraphQLContext) {
  // Prefetched by `users` when the list asked for them: no session per user.
  if (parent._teams) {
    return parent._teams.map(userTeamOf).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }
  const session = getSession()
  try {
    type Row = { props: Record<string, unknown> }
    const rows = await runQuery<Row>(session, `
      MATCH (u:User {id: $id, tenant_id: $tenantId})-[:MEMBER_OF]->(t:Team)
      WHERE t.tenant_id = $tenantId
      RETURN properties(t) AS props
      ORDER BY t.name
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => userTeamOf(r.props))
  } finally {
    await session.close()
  }
}

// ── createUser mutation ──────────────────────────────────────────────────────

/**
 * Una persona nuova (revisione totale · A-2, A-3): e-mail minuscola; un'e-mail
 * già presente nel grafo o nel realm è un errore e non tocca nulla (prima un
 * 409 di Keycloak veniva accettato: password reimpostata, nome e ruolo
 * sovrascritti). Se il grafo rifiuta dopo che l'account è nato nel realm,
 * l'account si toglie: nessuna persona a metà.
 */
async function createUser(_: unknown, args: { input: { email: string; name: string; password: string; role: string; teamIds?: string[] } }, ctx: GraphQLContext) {
  requirePermission(ctx, 'admin.users')
  const { password, role, teamIds } = args.input
  const email = normalizeEmail(args.input.email)
  const name = (args.input.name ?? '').trim()
  if (!name) throw new ValidationError('The person needs a name', { key: 'errors.user.nameRequired' })
  if (!(await tenantRoles(ctx.tenantId)).has(role)) {
    throw new GraphQLError(`Invalid role: ${role}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.authz.invalidRole', params: { role } } } })
  }
  const tenantId = ctx.tenantId

  const pre = getSession(undefined, 'READ')
  try {
    const existing = await runQueryOne<{ id: string }>(pre, 'MATCH (u:User {tenant_id: $tenantId}) WHERE toLower(u.email) = $email RETURN u.id AS id LIMIT 1', { tenantId, email })
    if (existing) throw emailTakenError(email)
    if (teamIds?.length) {
      const found = await runQueryOne<{ n: number }>(pre, 'MATCH (t:Team {tenant_id: $tenantId}) WHERE t.id IN $teamIds RETURN count(t) AS n', { tenantId, teamIds })
      if (Number(found?.n ?? 0) !== new Set(teamIds).size) throw new NotFoundError('Team', teamIds.join(', '))
    }
  } finally { await pre.close() }

  // Il ruolo NON si copia in Keycloak (ondata 7): l'app lo legge solo da
  // `User.role` e dai permessi del `:Role`, e una copia nel realm diventerebbe
  // falsa alla prima modifica.
  const keycloakUserId = await createRealmUser(tenantId, { email, name, password })

  const { v4: uuidv4 } = await import('uuid')
  const id  = uuidv4()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(`
        CREATE (u:User {id: $id, tenant_id: $tenantId, email: $email, name: $name, role: $role, active: true, created_at: $now, updated_at: $now})
      `, { email, tenantId, id, name, role, now })
      if (teamIds?.length) {
        await tx.run(`
          MATCH (u:User {id: $id, tenant_id: $tenantId})
          MATCH (t:Team {tenant_id: $tenantId}) WHERE t.id IN $teamIds
          MERGE (u)-[:MEMBER_OF]->(t)
        `, { id, tenantId, teamIds })
      }
    })
  } catch (err) {
    await deleteRealmUser(tenantId, keycloakUserId).catch((cleanupErr: unknown) => {
      logger.error({ err: cleanupErr, tenantId, email }, '[createUser] the realm account could not be removed after the graph refused the person: remove it in Keycloak')
    })
    if (err instanceof QueryError && err.isConstraintViolation) throw emailTakenError(email)
    throw err
  } finally { await session.close() }

  return mapUser({ id, tenant_id: tenantId, email, name, role, active: true, created_at: now })
}

/** Disattiva o riattiva una persona (revisione totale · M-6). */
async function setUserActive(_: unknown, args: { userId: string; active: boolean }, ctx: GraphQLContext) {
  requirePermission(ctx, 'admin.users')
  const { userId, active } = args
  if (active) {
    // Riattivare: prima il realm (senza account non potrebbe entrare), poi il grafo.
    const session = getSession()
    let email: string
    try {
      const row = await runQueryOne<{ email: string }>(session, 'MATCH (u:User {id: $userId, tenant_id: $tenantId}) RETURN u.email AS email', { userId, tenantId: ctx.tenantId })
      if (!row) throw new NotFoundError('User', userId)
      email = row.email
    } finally { await session.close() }
    await setRealmUserEnabled(ctx.tenantId, email, true)
    const { changed } = await setUserActiveInGraph(ctx.tenantId, userId, true, ctx.userId)
    if (changed) void audit(ctx, 'user.reactivated', 'User', userId, {})
  } else {
    // Disattivare: prima il grafo (da lì in poi l'API la rifiuta anche con un token valido), poi il realm.
    const { email, changed } = await setUserActiveInGraph(ctx.tenantId, userId, false, ctx.userId)
    const realm = await setRealmUserEnabled(ctx.tenantId, email, false)
    if (changed) void audit(ctx, 'user.deactivated', 'User', userId, { realmAccount: realm })
  }
  return userById(null, { id: userId }, ctx)
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
      ...changeSuspectResolvers.Query,
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
      ...proposalResolvers.Query,
      ...dailyWorkResolvers.Query,
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
      ...catalogFormResolvers.Query,
      ...ticketCIExclusionResolvers.Query,
      ...customWidgetResolvers.Query,
      ...automationResolvers.Query,
      ...integrationsResolvers.Query,
      ...collaborationResolvers.Query,
      ...whatifResolvers.Query,
      ...similarityResolvers.Query,
      ...impactResolvers.Query,
      ...cmdbHealthResolvers.Query,
      ...cmdbChainsResolvers.Query,
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
      ticketTasks,
      formReferenceFields,
      auditEntityTypes,
      ciIncidents: ciResolvers.Query.ciIncidents,
      ciChanges:   ciResolvers.Query.ciChanges,
      ciProblems:  ciResolvers.Query.ciProblems,
      ciServiceRequests: ciResolvers.Query.ciServiceRequests,
      ciGroupMembers: ciGroupResolvers.Query.ciGroupMembers,
      ...meStub,
      user: userById,
    },
    Mutation: {
      ...cmdbChainsResolvers.Mutation,
      claimTicketTask,
      completeTicketTask,
      cancelTicketTask,
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
      ...proposalResolvers.Mutation,
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
      ...catalogFormResolvers.Mutation,
      ...ticketCIExclusionResolvers.Mutation,
      ...customWidgetResolvers.Mutation,
      ...automationResolvers.Mutation,
      ...integrationsResolvers.Mutation,
      ...collaborationResolvers.Mutation,
      ...queueStatsResolvers.Mutation,
      ...ciRelationshipResolvers.Mutation,
      ...ticketCustomFieldResolvers.Mutation,
      createUser,
      setUserActive,
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
    // Moduli del catalogo (ondata 1): le scelte del vocabolario risolte dall'API,
    // perche' le rende anche il portale, che non ha accesso al Dizionario.
    FormField: { options: formFieldOptions, tableColumns: formFieldTableColumns },
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
    // L'iter della voce di catalogo (moduli del catalogo, ondata 3).
    ServiceCatalogItem: { ...serviceRequestResolvers.ServiceCatalogItem },
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
    // Il nome di chi ha risolto l'anomalia, letto solo se il client lo chiede
    // (revisione totale · ANO-8): il campo c'era ma la mappa non era unita qui.
    KBArticle:          knowledgeBaseResolvers.KBArticle,   // myVote: one vote per person (24 Sep 2026)
    Anomaly:            anomalyResolvers.Anomaly,
    Proposal:           proposalResolvers.Proposal,
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
