/**
 * Policy di autorizzazione centrale per i campi root Query/Mutation.
 *
 * Prima di questa policy esistevano 17 `requireRole` sparsi: team, workflow,
 * webhook, sync, CMDB, automazione erano scrivibili da `viewer` e dall'
 * `end_user` del portale. Qui la regola è unica, dichiarativa e applicata a
 * OGNI campo root da `applyAuthorizationPolicy` (chiamata in buildResolvers):
 *
 *   - default Query    → admin, operator, viewer
 *   - default Mutation → admin, operator
 *   - liste esplicite  → admin-only (configurazione), viewer-consentite
 *                        (azioni personali), end_user-consentite (portale)
 *
 * `end_user` è default-deny: vede solo l'allowlist del portale. Un ruolo
 * sconosciuto (dati legacy) è rifiutato con messaggio esplicito, non
 * degradato a viewer. I `requireRole` locali restano validi come seconda
 * linea; questa policy può solo restringere, mai allargare.
 *
 * Fail-fast: ogni nome nelle liste statiche deve esistere nella mappa dei
 * resolver, altrimenti l'avvio fallisce (un refuso non deve diventare un
 * campo silenziosamente aperto o chiuso).
 */
import type { GraphQLResolveInfo } from 'graphql'
import { USER_ROLES } from '@opengraphity/types'
import { ForbiddenError } from './errors.js'
import type { GraphQLContext } from '../context.js'

export type Role = GraphQLContext['role']
export type RootKind = 'Query' | 'Mutation'

/**
 * I ruoli veri, in un posto solo: `USER_ROLES` di @opengraphity/types, la
 * stessa lista che `assertRole` applica al login (auth/resolveAuth.ts) e che
 * gli script di onboarding usano. Qui prima c'era una seconda lista letterale
 * identica: due copie che potevano divergere in silenzio (D-13).
 */
export const ROLES: readonly Role[] = USER_ROLES

const DEFAULT_QUERY_ROLES:    readonly Role[] = ['admin', 'operator', 'viewer']
const DEFAULT_MUTATION_ROLES: readonly Role[] = ['admin', 'operator']

/** Configurazione del tenant: solo admin. */
export const ADMIN_ONLY_QUERIES: ReadonlySet<string> = new Set([
  // `auditActions` sta col registro: elenca le azioni presenti nell'audit del
  // tenant (D-22), e chi non può leggere il registro non deve poterne dedurre
  // il contenuto dalla tendina del filtro.
  'logs', 'auditLog', 'auditActions', 'queueStats', 'queueJobs', 'systemHealth', 'systemMetrics', 'traceInfo',
  'apiKeys', 'inboundWebhooks', 'outboundWebhooks',
  'syncSources', 'syncSource', 'syncRuns', 'syncConflicts', 'syncStats', 'availableConnectors', 'syncChangeHistory',
  'notificationChannels', 'notificationRules',
  'autoTriggers', 'businessRules', 'slaPolicies',
  'assessmentQuestionsAdmin', 'questionCITypeAssignments',
  // Event Management: la configurazione delle sorgenti (mappature, script di
  // trasformazione, ultimo errore col contenuto del payload) e gli strumenti
  // del wizard admin. La console usa `monitoringSourceRefs` (riferimenti
  // leggeri, ruoli predefiniti) e `Event.source` è un MonitoringSourceRef.
  'monitoringSources', 'monitoringSource', 'payloadKeys', 'sampleInboundPayload',
  // Servizi monitorati: le BusinessApplication candidate alla creazione di una
  // mappa sono uno strumento della mutation admin createServiceMap; il diff con
  // il grafo e l'anteprima del calcolo sono gli strumenti della configurazione
  // (ondata 2). Le letture (serviceMaps, serviceMap, servicesImpactedByCI)
  // restano a ruoli predefiniti.
  'serviceMapCandidates', 'serviceMapProposal', 'serviceImpactPreview',
  // Ondata 6 · C-3: i tipi di relazione percorribili servono al dialogo di
  // creazione della mappa, che è admin. È una lettura del metamodello, non
  // della pagina Servizi.
  'serviceRelationshipTypes',
  // Ondata 7 · A7-4: le matrici di dominio sono configurazione del tenant
  // (priorità = impatto × urgenza, criticità → impatto, …), come i vocabolari.
  'domainMatrices',
])

export const ADMIN_ONLY_MUTATIONS: ReadonlySet<string> = new Set([
  // utenti e team
  'createUser', 'updateUserTeams', 'createTeam', 'setTeamManager', 'removeTeamManager', 'setChangeManagerTeam',
  // definizioni di workflow
  'addWorkflowStep', 'removeWorkflowStep', 'updateWorkflowStep',
  'addWorkflowTransition', 'removeWorkflowTransition', 'updateWorkflowTransition',
  'saveWorkflowLayout', 'saveWorkflowChanges',
  // notifiche
  'createNotificationChannel', 'updateNotificationChannel', 'deleteNotificationChannel', 'testNotificationChannel',
  'createNotificationRule', 'updateNotificationRule', 'deleteNotificationRule',
  // integrazioni
  'createInboundWebhook', 'updateInboundWebhook', 'deleteInboundWebhook', 'regenerateWebhookToken',
  'createOutboundWebhook', 'updateOutboundWebhook', 'deleteOutboundWebhook', 'testOutboundWebhook',
  'createApiKey', 'updateApiKey', 'deleteApiKey', 'regenerateApiKey',
  // discovery / sync (credenziali cloud, scritture di massa sul CMDB)
  'createSyncSource', 'updateSyncSource', 'deleteSyncSource', 'triggerSync', 'resolveConflict', 'testSyncConnection',
  // automazione e SLA/OLA
  'createAutoTrigger', 'updateAutoTrigger', 'deleteAutoTrigger',
  'createBusinessRule', 'updateBusinessRule', 'deleteBusinessRule', 'reorderBusinessRules',
  'createSLAPolicy', 'updateSLAPolicy', 'deleteSLAPolicy',
  'createOLAContract', 'updateOLAContract',
  // metamodello e regole di campo
  'updateITILType', 'createITILField', 'updateITILField', 'deleteITILField',
  'createITILCIRelationRule', 'deleteITILCIRelationRule',
  'createEnumType', 'updateEnumType', 'deleteEnumType', 'customizeEnumType',
  'updateDomainMatrix',
  'createFieldVisibilityRule', 'updateFieldVisibilityRule', 'deleteFieldVisibilityRule',
  'setFieldRequirement', 'deleteFieldRequirement',
  // cataloghi e questionari
  'createServiceCatalogItem', 'updateServiceCatalogItem',
  'createAssessmentQuestion', 'updateAssessmentQuestion', 'deleteAssessmentQuestion',
  'assignQuestionToCIType', 'removeQuestionFromCIType', 'setQuestionCore',
  // operazioni di sistema
  'runAnomalyScanner', 'retryQueueJob', 'updateReportSchedule', 'deleteChange',
  // Event Management (alias dei CI, policy del tenant, prova di una sorgente,
  // anteprima del wizard: strumento admin come payloadKeys/sampleInboundPayload).
  // acknowledgeEvent/resolveEvent/linkEventToCI/createIncidentFromEvent/
  // setCIHealthOverride/reevaluateEvent restano admin/operator (default delle
  // mutation); le query events/eventStats/ciHealth/ciHealthOverview/
  // monitoringSourceRefs restano a ruoli predefiniti (admin, operator, viewer):
  // console e pagina Salute CI sono per lo staff. Tabella completa pinnata in
  // lib/__tests__/authorization.test.ts.
  'createCIAlias', 'deleteCIAlias', 'updateEventPolicy', 'sendSampleEvent', 'previewInboundEvents',
  // Servizi monitorati (configurazione del tenant: mappe dei servizi). Tabella
  // completa pinnata in lib/__tests__/authorization.test.ts.
  'createServiceMap', 'reevaluateServiceMap', 'setServiceMapStatus', 'deleteServiceMap',
  'updateServiceImpactRules', 'updateServiceMapNodes', 'applyServiceMapProposal', 'removeServiceMapExclusion',
  'setServiceMapAutoSync', 'syncServiceMap',
])

/**
 * Mutation admin-only registrate dai resolver dinamici del metamodello
 * (ciTypeMetamodel): non stanno nello SDL base, quindi sono verificate solo
 * se presenti nella mappa a runtime.
 */
export const ADMIN_ONLY_DYNAMIC_MUTATIONS: ReadonlySet<string> = new Set([
  'createCIType', 'updateCIType', 'deleteCIType',
  'addCIField', 'removeCIField', 'addCIRelation', 'removeCIRelation',
])

/** Azioni personali consentite anche in sola lettura (viewer). */
export const VIEWER_ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  'watchEntity', 'unwatchEntity', 'linkSlackAccount', 'rateKBArticle', 'deleteReportConversation',
  'createDashboard', 'updateDashboard', 'deleteDashboard', 'cloneDashboard',
  'addDashboardWidget', 'removeDashboardWidget', 'updateDashboardWidget', 'reorderDashboardWidgets',
  'createCustomWidget', 'updateCustomWidget', 'deleteCustomWidget', 'reorderCustomWidgets',
])

/** Superficie del portale self-service: tutto il resto è negato a end_user. */
export const END_USER_ALLOWED_QUERIES: ReadonlySet<string> = new Set([
  'me', 'myTickets', 'myTicket', 'myTicketStats', 'serviceCatalogItems',
  'kbArticles', 'kbArticle', 'kbArticleBySlug', 'kbCategories',
  'fieldVisibilityRules', 'fieldRequirementRules',
])
export const END_USER_ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  'createTicket', 'addTicketComment', 'reopenTicket', 'createServiceRequest', 'rateKBArticle',
])

/** Ruoli ammessi per un campo root. Pura: usata anche dai test. */
export function allowedRoles(kind: RootKind, field: string): readonly Role[] {
  if (kind === 'Query') {
    if (ADMIN_ONLY_QUERIES.has(field)) return ['admin']
    return END_USER_ALLOWED_QUERIES.has(field) ? [...DEFAULT_QUERY_ROLES, 'end_user'] : DEFAULT_QUERY_ROLES
  }
  if (ADMIN_ONLY_MUTATIONS.has(field) || ADMIN_ONLY_DYNAMIC_MUTATIONS.has(field)) return ['admin']
  const roles: Role[] = [...DEFAULT_MUTATION_ROLES]
  if (VIEWER_ALLOWED_MUTATIONS.has(field)) roles.push('viewer')
  if (END_USER_ALLOWED_MUTATIONS.has(field)) roles.push('end_user')
  return roles
}

export function authorize(kind: RootKind, field: string, role: string): void {
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new ForbiddenError(`Ruolo sconosciuto '${role}': nessuna operazione consentita`)
  }
  const roles = allowedRoles(kind, field)
  if (!roles.includes(role as Role)) {
    throw new ForbiddenError(`Il ruolo '${role}' non può eseguire ${kind}.${field} (richiesto: ${roles.join(', ')})`)
  }
}

type RootResolver = (parent: unknown, args: unknown, ctx: GraphQLContext, info: GraphQLResolveInfo) => unknown
type RootMap = Record<string, RootResolver | undefined>

/**
 * Avvolge ogni campo root con il controllo di ruolo. Verifica anche che le
 * liste statiche puntino a campi esistenti (fail-fast all'avvio).
 */
export function applyAuthorizationPolicy<T extends { Query?: RootMap; Mutation?: RootMap }>(resolvers: T): T {
  const query    = resolvers.Query    ?? {}
  const mutation = resolvers.Mutation ?? {}

  const missing: string[] = []
  for (const name of ADMIN_ONLY_QUERIES)    if (!(name in query))    missing.push(`Query.${name}`)
  for (const name of [...ADMIN_ONLY_MUTATIONS, ...VIEWER_ALLOWED_MUTATIONS, ...END_USER_ALLOWED_MUTATIONS]) {
    if (!(name in mutation)) missing.push(`Mutation.${name}`)
  }
  for (const name of END_USER_ALLOWED_QUERIES) if (!(name in query)) missing.push(`Query.${name}`)
  if (missing.length) {
    throw new Error(`[authorization] la policy cita campi inesistenti: ${missing.join(', ')}`)
  }

  const wrap = (kind: RootKind, map: RootMap): RootMap => {
    const out: RootMap = {}
    for (const [field, fn] of Object.entries(map)) {
      if (typeof fn !== 'function') { out[field] = fn; continue }
      out[field] = (parent, args, ctx, info) => {
        authorize(kind, field, ctx.role)
        return fn(parent, args, ctx, info)
      }
    }
    return out
  }

  return { ...resolvers, Query: wrap('Query', query), Mutation: wrap('Mutation', mutation) }
}
