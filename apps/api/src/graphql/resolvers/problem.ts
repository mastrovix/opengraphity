import { GraphQLError } from 'graphql'
import { requestCustomFieldDefs } from './ticketCustomFields.js'
import { customFieldValueMap, type CustomFieldInput } from '../../lib/ticketCustomFields.js'
import { withTicketProps } from '../../lib/ticketProps.js'
import type { GraphQLResolveInfo } from 'graphql'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { mapCI, ciTypeFromLabels, withSession } from './ci-utils.js'
import { mapUser, mapTeam } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { getScalarFields } from '../../lib/schemaFields.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { audit } from '../../lib/audit.js'
import { ValidationError } from '../../lib/errors.js'
import {} from '../../lib/stepEvent.js'
import { logger } from '../../lib/logger.js'
import { requirePermission } from '../../lib/permissions.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { TICKET_TEAM_ASSIGNED_EVENT } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { assertCIsLinkable } from '../../lib/ticketCIExclusions.js'
import * as problemService from '../../services/problemService.js'
import { validateRequiredFields, propsToFieldValues } from '../../lib/validateRequiredFields.js'
import { resolvePriorityPatch } from '../../lib/priority.js'
import { assertUserInAssignedTeam, setTicketTeam, setTicketUser } from '../../services/ticketAssignment.js'
import { assertMayAcknowledgeNoSla } from '../../lib/slaAcknowledgement.js'
import { ticketSlaStatusResolver } from './ticketSlaStatus.js'
import { commentAuthorKind, commentAuthorLabel, commentTrace } from '../../lib/commentAuthor.js'
import { transitionFailed } from '../../lib/transitionError.js'
import { getStepNamesByPurpose } from '../../lib/workflowHelpers.js'
import { writeTicketComment } from '../../lib/ticketComments.js'
import { notifyCommentAudience } from './comments.js'
import { publishTicketUpdated } from '../../lib/ticketUpdated.js'
import { listPage } from '../../lib/listLimit.js'
import { orderByOrThrow } from '../../lib/sortField.js'

type Props = Record<string, unknown>

export function mapProblem(props: Props) {
  return withTicketProps({
    id:            props['id']            as string,
    number:        (props['number'] ?? '') as string,
    title:         props['title']         as string,
    description:   (props['description']  ?? null) as string | null,
    // B-25: un problem senza priorità si mostra senza priorità, non «medium».
    priority:      (props['priority']     ?? null) as string | null,
    impact:        (props['impact']       ?? null) as string | null,
    urgency:       (props['urgency']      ?? null) as string | null,
    // B-3: la categoria è sul nodo e va esposta (le policy SLA la leggono).
    category:      (props['category']     ?? null) as string | null,
    status:        props['status']        as string,
    rootCause:     (props['root_cause']   ?? null) as string | null,
    workaround:    (props['workaround']   ?? null) as string | null,
    affectedUsers: props['affected_users'] != null ? Number(props['affected_users']) : null,
    createdAt:     props['created_at']    as string,
    updatedAt:     (props['updated_at']   ?? null) as string | null,
    resolvedAt:    (props['resolved_at']  ?? null) as string | null,
    closedAt:      (props['closed_at']    ?? null) as string | null,
    createdBy:     null,
    assignee:      null,
    assignedTeam:  null,
    affectedCIs:   [],
    relatedIncidents: [],
    relatedChanges:   [],
    workflowInstance:     null,
    availableTransitions: [],
    workflowHistory:      [],
    comments:             [],
  }, props)
}

function mapProblemComment(props: Props, authorProps: Props | null) {
  return {
    id:        props['id']         as string,
    text:      props['text']       as string,
    type:      (props['type']      ?? 'manual') as string,
    isInternal: props['is_internal'] === true,
    createdAt: props['created_at'] as string,
    updatedAt: (props['updated_at'] ?? null) as string | null,
    author:    authorProps ? mapUser(authorProps) : null,
    authorKind:  commentAuthorKind(props, !!authorProps),
    authorLabel: commentAuthorLabel(props),
    ...commentTrace(props),
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

/** `number`: vedi INCIDENT_SORT_WHITELIST (revisione totale · B-9). */
export const PROBLEM_SORT_WHITELIST: Record<string, string> = {
  number:    'number',
  title:     'title',
  priority:  'priority',
  status:    'status',
  createdAt: 'created_at',
}

function problemOrderBy(sortField?: string | null, sortDirection?: string | null): string {
  // A-22: un campo non ordinabile è un errore, non un ordine diverso in
  // silenzio. Le colonne della whitelist sono senza alias: si aggiunge qui.
  const prefixed = Object.fromEntries(Object.entries(PROBLEM_SORT_WHITELIST).map(([k, v]) => [k, `p.${v}`]))
  return orderByOrThrow(prefixed, sortField, sortDirection ?? 'desc', 'p.created_at DESC', 'problems(sortField)')
}

async function problems(
  _: unknown,
  args: { limit?: number; offset?: number; status?: string; priority?: string; search?: string; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, priority, search, filters, sortField, sortDirection } = args
  const { limit, offset } = listPage(args, 50)

  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      priority: priority ?? null,
      // Testo libero dell'utente: CONTAINS, mai una regex. Con `=~` una
      // parentesi o un `+` nella ricerca facevano fallire la query («Invalid
      // Regex»), revisione del 14 set 2026 · IT-1. Stessa forma degli incident.
      search:   search   ? search : null,
      offset,
      limit,
    }
    // I campi del cliente si filtrano come quelli del prodotto (ondata 4).
    const allowedFields = new Set([...getScalarFields(info.schema, 'Problem'), ...(await requestCustomFieldDefs(ctx, 'problem')).map((d) => d.name)])
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'p') : ''
    const whereClause = `
      WHERE ($status   IS NULL OR p.status   = $status)
        AND ($priority IS NULL OR p.priority = $priority)
        AND ($search   IS NULL OR toLower(p.title) CONTAINS toLower($search))
        ${advWhere ? `AND (${advWhere})` : ''}
    `
    const itemRows = await runQuery<{ props: Props; uProps: Props | null; tProps: Props | null; cis: Array<{ props: Props; label: string }> }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})
      ${whereClause}
      OPTIONAL MATCH (p)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (p)-[:ASSIGNED_TO_TEAM]->(t:Team)
      WITH p, u, t ORDER BY ${problemOrderBy(sortField, sortDirection)}
      SKIP toInteger($offset) LIMIT toInteger($limit)
      OPTIONAL MATCH (p)-[:AFFECTS]->(ci)
      WITH p, u, t, collect(DISTINCT {props: properties(ci), label: head([l IN labels(ci) WHERE l <> 'ConfigurationItem'])}) AS cis
      RETURN properties(p) AS props, properties(u) AS uProps, properties(t) AS tProps, cis
    `, params)
    const countRows = await runQuery<{ total: unknown }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(p) AS total
    `, params)
    return {
      items: itemRows.map((r) => {
        const base = mapProblem(r.props) as ReturnType<typeof mapProblem> & { _prefetched: boolean }
        base.assignee     = r.uProps ? mapUser(r.uProps) as unknown as null : null
        base.assignedTeam = r.tProps ? mapTeam(r.tProps) as unknown as null : null
        base.affectedCIs  = r.cis
          .filter((c) => c.props && c.props['id'])
          .map((c) => {
            const t = ciTypeFromLabels(ctx.tenantId, [c.label])
            c.props['type'] = t
            const ci = mapCI(c.props) as Record<string, unknown>
            ci['ciType']     = t
            ci['__typename'] = c.label || 'Application'
            return ci
          }) as unknown as []
        base._prefetched = true
        return base
      }),
      total: (countRows[0]?.total as { toNumber(): number } | undefined)?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

async function problem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      RETURN properties(p) as props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapProblem(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createProblem(
  _: unknown,
  args: { input: { title: string; description?: string; priority?: string; impact?: string; urgency?: string; affectedCIs?: string[]; relatedIncidents?: string[]; workaround?: string; acknowledgeNoSla?: boolean | null ; customFields?: CustomFieldInput[] | null } },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await validateRequiredFields(session, {
      entityType:  'problem',
      // Le regole di obbligatorietà valgono anche sui campi del cliente (ondata 4).
      fieldValues: { ...(args.input as Record<string, unknown>), ...customFieldValueMap(args.input.customFields) },
      tenantId:    ctx.tenantId,
    })
    assertMayAcknowledgeNoSla(ctx, args.input.acknowledgeNoSla)
    const props = await problemService.createProblem(args.input, ctx)
    void audit(ctx, 'problem.created', 'Problem', (props as Props)['id'] as string)
    return mapProblem(props as Props)
  })
}

async function updateProblem(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; priority?: string; impact?: string; urgency?: string; category?: string; rootCause?: string; workaround?: string; affectedUsers?: number } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    // Validazione sullo stato risultante (persistito + patch), non sulla sola
    // patch; e priorità = impatto × urgenza mantenuta coerente (vedi
    // resolvePriorityPatch), come per l'incident.
    const current = await runQueryOne<{ props: Props }>(session,
      'MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) AS props',
      { id, tenantId: ctx.tenantId })
    if (!current) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    await validateRequiredFields(session, {
      entityType:  'problem',
      fieldValues: { ...propsToFieldValues(current.props), ...(input as Record<string, unknown>) },
      tenantId:    ctx.tenantId,
    })
    // B-3: la categoria è un valore del vocabolario del cliente, come per gli
    // incident; prima il problem non la teneva affatto.
    if (input.category !== undefined) await assertDomainValue(ctx.tenantId, 'category', input.category)
    const prio = await resolvePriorityPatch(
      ctx.tenantId,
      { impact: current.props['impact'] as string | null, urgency: current.props['urgency'] as string | null },
      { priority: input.priority, impact: input.impact, urgency: input.urgency },
    )
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      // I campi di TESTO si possono SVUOTARE (revisione totale · B-17): con
      // «coalesce» null e assente erano la stessa cosa, e l'operatore che
      // cancellava un workaround sbagliato lo ritrovava lì. Ora conta se il
      // campo è presente nell'input: presente e vuoto = cancella, assente =
      // non si tocca. Il titolo non si svuota: un ticket senza titolo non si
      // riconosce.
      SET p += {
        title:          coalesce($title,        p.title),
        description:    CASE WHEN $descriptionGiven   THEN $description   ELSE p.description    END,
        priority:       coalesce($priority,     p.priority),
        impact:         coalesce($impact,       p.impact),
        urgency:        coalesce($urgency,      p.urgency),
        category:       coalesce($category,     p.category),
        root_cause:     CASE WHEN $rootCauseGiven     THEN $rootCause     ELSE p.root_cause     END,
        workaround:     CASE WHEN $workaroundGiven    THEN $workaround    ELSE p.workaround     END,
        affected_users: CASE WHEN $affectedUsersGiven THEN $affectedUsers ELSE p.affected_users END,
        updated_at:     $now
      }
      RETURN properties(p) as props
    `, {
      id,
      tenantId:      ctx.tenantId,
      title:         input.title         ?? null,
      description:   input.description   ?? null,
      priority:      prio.severity,
      impact:        prio.impact,
      urgency:       prio.urgency,
      category:      input.category      ?? null,
      // B-17: «presente nell'input» distingue il vuoto dall'assenza.
      descriptionGiven:   Object.prototype.hasOwnProperty.call(input, 'description'),
      rootCauseGiven:     Object.prototype.hasOwnProperty.call(input, 'rootCause'),
      workaroundGiven:    Object.prototype.hasOwnProperty.call(input, 'workaround'),
      affectedUsersGiven: Object.prototype.hasOwnProperty.call(input, 'affectedUsers'),
      rootCause:     input.rootCause     ?? null,
      workaround:    input.workaround    ?? null,
      affectedUsers: input.affectedUsers ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    void audit(ctx, 'problem.updated', 'Problem', id)
    await publishTicketUpdated(ctx, 'problem', id, current.props, row.props)
    return mapProblem(row.props)
  }, true)
}

/**
 * Eliminazione di un problem — revisione del 14 set 2026 · F3.
 *
 * Prima la cascata portava via istanza, storia e commenti ma lasciava il nodo
 * `SLAStatus`, non annullava i job di breach SLA e OLA/UC ancora in coda, non
 * pubblicava nessun evento e non chiedeva un ruolo (bastava essere operatore),
 * mentre una change si elimina solo da admin. Ora:
 *  - solo admin, come le change;
 *  - una transazione porta via il problem e tutto ciò che vive solo per lui:
 *    istanza e storia del workflow, stato SLA, commenti,
 *    allegati, notifiche e osservatori; l'audit resta (è il registro);
 *  - dopo il commit si annullano i job di breach (SLA e OLA/UC) e si pubblica
 *    `problem.deleted`. Un errore qui fa fallire la mutation dopo che il
 *    problem è già stato eliminato: lo si dice, invece di tacerlo, perché un
 *    job rimasto in coda notificherebbe una violazione di un ticket che non c'è.
 */
async function deleteProblem(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'problem.delete')
  const removed = await withSession(async (session) => {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (p)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      OPTIONAL MATCH (wi)-[:STEP_HISTORY]->(e:WorkflowStepExecution)
      OPTIONAL MATCH (p)-[:HAS_COMMENT]->(c)
      OPTIONAL MATCH (p)-[:HAS_SLA]->(sla:SLAStatus)
      // I segmenti della storia dei team vivono SOLO per questo problem
      // (revisione totale · B-20): il DETACH toglieva la relazione e lasciava
      // i nodi nel grafo, con il loro tenant_id, per sempre.
      OPTIONAL MATCH (p)-[:TEAM_SEGMENT]->(seg:TicketTeamSegment)
      WITH p, collect(DISTINCT wi) AS wis, collect(DISTINCT e) AS execs,
           collect(DISTINCT c) AS comments, collect(DISTINCT sla) AS slas,
           collect(DISTINCT seg) AS segments
      // Nodi legati per proprietà (entity_type/entity_id), non per relazione.
      // Aggregato dentro la subquery: una riga sempre, anche senza nodi legati
      // (una CALL senza righe toglierebbe la riga del problem).
      CALL {
        CALL {
          MATCH (x:Attachment {tenant_id: $tenantId, entity_type: 'problem', entity_id: $id}) RETURN x
          UNION
          MATCH (x:Notification {tenant_id: $tenantId, entity_type: 'problem', entity_id: $id}) RETURN x
        }
        RETURN collect(x) AS linkedNodes
      }
      WITH p, wis, execs, comments, slas, segments, linkedNodes,
           [n IN linkedNodes WHERE n:Attachment | n.storage_path] AS files
      FOREACH (x IN execs       | DETACH DELETE x)
      FOREACH (x IN wis         | DETACH DELETE x)
      FOREACH (x IN comments    | DETACH DELETE x)
      FOREACH (x IN slas        | DETACH DELETE x)
      FOREACH (x IN segments    | DETACH DELETE x)
      FOREACH (x IN linkedNodes | DETACH DELETE x)
      DETACH DELETE p
      RETURN files
    `, { id: args.id, tenantId: ctx.tenantId }))
    if (res.records.length === 0) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    return { files: (res.records[0]!.get('files') as Array<string | null>).filter((f): f is string => !!f) }
  }, true)

  void audit(ctx, 'problem.deleted', 'Problem', args.id)

  const { cancelSLAJobs, getActiveOLAContractsFor, cancelOLABreaches } = await import('@opengraphity/sla')
  await cancelSLAJobs(args.id, 'both')
  const contracts = await getActiveOLAContractsFor(ctx.tenantId, 'problem')
  if (contracts.length > 0) await cancelOLABreaches(args.id, contracts.map((c) => c.id))

  const { rm } = await import('node:fs/promises')
  for (const file of removed.files) {
    await rm(file, { force: true }).catch((err: unknown) => {
      logger.error({ err, problemId: args.id, file }, '[deleteProblem] attachment file not removed from storage')
    })
  }

  await publishEvent('problem.deleted', ctx.tenantId, ctx.userId, { id: args.id }, new Date().toISOString())
  return true
}

async function linkIncidentToProblem(
  _: unknown,
  args: { problemId: string; incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MERGE (p)-[:CAUSED_BY]->(i)
      SET p.updated_at = $now
    `, { problemId: args.problemId, incidentId: args.incidentId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    return mapProblem(row.props)
  }, true)
}

async function unlinkIncidentFromProblem(
  _: unknown,
  args: { problemId: string; incidentId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[r:CAUSED_BY]->(i:Incident {id: $incidentId, tenant_id: $tenantId})
      DELETE r
      SET p.updated_at = $now
      RETURN 1 AS n
    `, { problemId: args.problemId, incidentId: args.incidentId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    if (res.records.length === 0) throw new GraphQLError('Problem–incident link not found', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.link.problemIncidentNotFound' } } })
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    return mapProblem(row.props)
  }, true)
}

async function addCIToProblem(
  _: unknown,
  args: { problemId: string; ciId: string },
  ctx: GraphQLContext,
) {
  // CM-8: i tipi di CI esclusi per i problem non si collegano.
  await assertCIsLinkable(ctx.tenantId, 'problem', [args.ciId])
  const ciWhereClause = await ciLabelPredicateForTenant('ci', ctx.tenantId)

  return withSession(async (session) => {
    // Righe contate (C-2): un CI che non esiste dava un MERGE muto e una
    // risposta di successo.
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciWhereClause}
      MERGE (p)-[r:AFFECTS]->(ci)
      SET p.updated_at = $now
      RETURN count(r) AS linked
    `, { problemId: args.problemId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    if (Number(res.records[0]?.get('linked') ?? 0) === 0) {
      throw new ValidationError(`CI ${args.ciId} not linked to the problem: it does not exist in this tenant`, { key: 'errors.ciLink.problem', params: { ci: args.ciId } })
    }
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    return mapProblem(row.props)
  }, true)
}

async function removeCIFromProblem(
  _: unknown,
  args: { problemId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[r:AFFECTS]->(ci {id: $ciId, tenant_id: $tenantId})
      DELETE r
      SET p.updated_at = $now
    `, { problemId: args.problemId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    return mapProblem(row.props)
  }, true)
}

async function assignProblemToTeam(
  _: unknown,
  args: { problemId: string; teamId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const { teamName } = await setTicketTeam(session, 'Problem', args.problemId, args.teamId, ctx.tenantId)
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    // SL-10: la policy SLA può dipendere dal gruppo appena assegnato.
    await publishEvent(TICKET_TEAM_ASSIGNED_EVENT, ctx.tenantId, ctx.userId, { entity_type: 'problem', entity_id: args.problemId, team_id: args.teamId })
    // B-18: anche l'assegnazione a un gruppo è un'assegnazione, e va detta.
    await publishEvent('problem.assigned', ctx.tenantId, ctx.userId, {
      id:         args.problemId,
      title:      (row.props['title'] ?? args.problemId) as string,
      priority:   (row.props['priority'] ?? 'medium') as string,
      status:     (row.props['status'] ?? '') as string,
      assignedTo: teamName,
    })
    return mapProblem(row.props)
  }, true)
}

/**
 * `userId` null = togli l'assegnazione, come per l'incident (revisione totale
 * · B-18: il problem non si poteva disassegnare). L'assegnazione pubblica
 * `problem.assigned`: prima non esisteva nessun evento su cui agganciare una
 * regola «problem assegnato → notifica all'assegnatario».
 */
async function assignProblemToUser(
  _: unknown,
  args: { problemId: string; userId?: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Regola ITSM condivisa con l'incident (services/ticketAssignment.ts):
    // prima il gruppo, poi un utente di quel gruppo.
    if (args.userId) await assertUserInAssignedTeam(session, 'Problem', args.problemId, args.userId, ctx.tenantId)
    const { userName } = await setTicketUser(session, 'Problem', args.problemId, args.userId ?? null, ctx.tenantId)
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    await publishEvent('problem.assigned', ctx.tenantId, ctx.userId, {
      id:         args.problemId,
      title:      (row.props['title'] ?? args.problemId) as string,
      priority:   (row.props['priority'] ?? 'medium') as string,
      status:     (row.props['status'] ?? '') as string,
      assignedTo: userName ?? '—',
    })
    void audit(ctx, args.userId ? 'problem.assigned_user' : 'problem.unassigned_user', 'Problem', args.problemId, { userId: args.userId ?? null })
    return mapProblem(row.props)
  }, true)
}

async function executeProblemTransition(
  _: unknown,
  args: { problemId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { problemId: args.problemId, tenantId: ctx.tenantId }))
    if (!wiResult.records.length) throw new GraphQLError('Workflow instance not found for this problem')
    const instanceId = wiResult.records[0]!.get('instanceId') as string

    const result = await workflowEngine.transition(
      session,
      { instanceId, toStepName: args.toStep, triggeredBy: ctx.userId, triggerType: 'manual', notes: args.notes ?? undefined, tenantId: ctx.tenantId },
      { userId: ctx.userId, entityData: {} },
    )

    if (!result.success) {
      throw transitionFailed(result, 'Transition failed')
    }
    if (result.actionErrors?.length) {
      logger.error({ problemId: args.problemId, actionErrors: result.actionErrors },
        '[problem] transition persisted but step actions failed')
    }

    // L'ingresso nel passo: l'evento con il tipo STABILE
    // `problem.step_entered` (più l'alias storico `problem.<passo>`) lo
    // pubblica l'hook `onStepEntered` del motore, che vede anche i cammini
    // automatici (revisione totale · C-1); qui resta l'azione di audit
    // stabile, con il passo nei dettagli (D-22).
    // ATTESA, non `void`: una sessione Neo4j non regge due operazioni in
    // parallelo. Lasciata partire e non attesa, la lettura dei fatti del passo
    // era ancora aperta quando partiva la query qui sotto, e il driver
    // rispondeva «Queries cannot be run directly on a session with an open
    // transaction» — messaggio che finiva a schermo all'operatore DOPO che la
    // transizione era già avvenuta: lo stato avanzava e l'interfaccia diceva
    // che era fallita. Trovato dal browser su un problem vero (terza
    // revisione). L'audit non deve far fallire la mutazione: il suo errore si
    // registra e si va avanti — ma in fila, non in parallelo.
    // La voce di audit la scrive l'hook `onStepEntered` per TUTTI i cammini
    // (revisione totale · B-5): le transizioni del problem guidate dalla sua
    // change non la scrivevano, e la storia del problem aveva dei buchi.
    // Scriverla anche qui la sdoppierebbe sulla transizione manuale.

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) as props
    `, { id: args.problemId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    // Azioni di step fallite dopo il commit: esposte come Problem.actionErrors.
    return { ...mapProblem(row.props), actionErrors: result.actionErrors?.length ? result.actionErrors : null }
  }, true)
}

async function addProblemComment(
  _: unknown,
  args: { problemId: string; text: string; isInternal?: boolean | null },
  ctx: GraphQLContext,
) {
  // Un modello solo (lib/ticketComments.ts): prima `ProblemComment`, che né il
  // portale né le regole vedevano. Senza scelta esplicita è una nota interna.
  const isInternal = args.isInternal !== false
  return withSession(async (session) => {
    const row = await writeTicketComment(session, {
      entityType: 'problem', entityId: args.problemId, tenantId: ctx.tenantId,
      text: args.text, authorId: ctx.userId, isInternal,
    })
    if (!row) throw new GraphQLError('Problem not found', { extensions: { code: 'NOT_FOUND' } })
    void audit(ctx, 'comment.added', 'Problem', args.problemId, { commentId: row.comment['id'], isInternal })
    // CO-3: stesse notifiche di ogni altro commento (osservatori, menzioni).
    void notifyCommentAudience(ctx, 'problem', args.problemId, args.text, isInternal)
    return mapProblemComment(row.comment, row.author)
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function problemAffectedCIs(
  parent: { id: string; affectedCIs?: unknown[]; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.affectedCIs ?? []
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:AFFECTS]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) as props, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      const t = ciTypeFromLabels(ctx.tenantId, [r.label])
      r.props['type'] = t
      const ci = mapCI(r.props) as Record<string, unknown>
      ci['ciType']     = t
      ci['__typename'] = r.label || 'Application'
      return ci
    })
  })
}

async function problemWorkflowInstance(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const wi = result.records[0]!.get('wi').properties as Props
    return {
      id:          wi['id']           as string,
      currentStep: wi['current_step'] as string,
      status:      wi['status']       as string,
      createdAt:   wi['created_at']   as string,
      updatedAt:   wi['updated_at']   as string,
    }
  })
}

async function problemAvailableTransitions(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const wiResult = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!wiResult.records.length) return []
    const instanceId = wiResult.records[0]!.get('instanceId') as string
    return workflowEngine.getAvailableTransitions(session, instanceId)
  })
}

async function problemWorkflowHistory(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (wi)-[:STEP_HISTORY]->(e:WorkflowStepExecution)
      RETURN e
      ORDER BY e.entered_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId }))
    return result.records.map((rec) => {
      const e = rec.get('e').properties as Props
      return {
        id:          e['id']           as string,
        stepName:    e['step_name']    as string,
        enteredAt:   e['entered_at']   as string,
        exitedAt:    (e['exited_at']   ?? null) as string | null,
        durationMs:  e['duration_ms'] != null ? Number(e['duration_ms']) : null,
        triggeredBy: e['triggered_by'] as string,
        triggerType: e['trigger_type'] as string,
        notes:       (e['notes']       ?? null) as string | null,
      }
    })
  })
}

async function problemComments(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
      OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
      RETURN properties(c) AS cProps, properties(u) AS uProps
      ORDER BY c.created_at ASC
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => mapProblemComment(r.cProps, r.uProps))
  })
}

async function problemAssignee(
  parent: { id: string; assignee?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignee ?? null
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  })
}

async function problemAssignedTeam(
  parent: { id: string; assignedTeam?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignedTeam ?? null
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN t
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const t = result.records[0]!.get('t').properties as Props
    return mapTeam(t)
  })
}

async function problemCreatedBy(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId})-[:CREATED_BY]->(u:User)
      RETURN properties(u) as props
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  })
}

const problemSlaStatus = ticketSlaStatusResolver('Problem')

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * La KEDB: i problem che stanno in un passo con SCOPO `known_error`.
 *
 * Prima filtrava `status: 'known_error'`, il nome di fabbrica del passo: un
 * cliente che lo rinominava («Errore noto») vedeva la KEDB vuota, senza un
 * errore (revisione del 14 set 2026 · IT-1). Un workflow in cui nessun passo
 * dichiara lo scopo è un errore che lo dice: una lista vuota si leggerebbe
 * come «nessun errore noto».
 */
async function knownErrors(_: unknown, args: { search?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const search = (args.search ?? '').trim()
    const steps = await getStepNamesByPurpose(session, ctx.tenantId, 'problem', ['known_error'])
    if (steps.length === 0) {
      throw new ValidationError(
        'No step of the problem workflow declares the «known_error» purpose: the Known Error Database has no step to list. '
        + 'Assign the purpose to the step where problems are documented as known errors, in the workflow designer.',
        { key: 'errors.problem.noKnownErrorStep' },
      )
    }
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})
      WHERE p.status IN $steps
      ${search ? "AND (toLower(p.title) CONTAINS toLower($search) OR toLower(coalesce(p.workaround,'')) CONTAINS toLower($search) OR toLower(coalesce(p.root_cause,'')) CONTAINS toLower($search))" : ''}
      RETURN properties(p) AS props ORDER BY p.updated_at DESC
    `, { tenantId: ctx.tenantId, search, steps })
    return rows.map((r) => mapProblem(r.props))
  })
}

export const problemResolvers = {
  Query: { problems, problem, knownErrors },
  Mutation: {
    createProblem,
    updateProblem,
    deleteProblem,
    linkIncidentToProblem,
    unlinkIncidentFromProblem,
    addCIToProblem,
    removeCIFromProblem,
    assignProblemToTeam,
    assignProblemToUser,
    executeProblemTransition,
    addProblemComment,
  },
  Problem: {
    slaStatus:            problemSlaStatus,
    affectedCIs:          problemAffectedCIs,
    workflowInstance:     problemWorkflowInstance,
    availableTransitions: problemAvailableTransitions,
    workflowHistory:      problemWorkflowHistory,
    comments:             problemComments,
    assignee:             problemAssignee,
    assignedTeam:         problemAssignedTeam,
    createdBy:            problemCreatedBy,
  },
}
