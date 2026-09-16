import type { GraphQLResolveInfo } from 'graphql'
import { requestCustomFieldDefs } from './ticketCustomFields.js'
import { customFieldValueMap, type CustomFieldInput } from '../../lib/ticketCustomFields.js'
import { resolvePriorityPatch } from '../../lib/priority.js'
import { propsToFieldValues as mergedFieldValues } from '../../lib/validateRequiredFields.js'
import { requirePermission } from '../../lib/permissions.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { mapCI, ciTypeFromLabels, withSession } from './ci-utils.js'
import { mapUser, mapTeam, mapIncident } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { getScalarFields } from '../../lib/schemaFields.js'
import type { GraphQLContext } from '../../context.js'
import * as incidentService from '../../services/incidentService.js'
import { audit } from '../../lib/audit.js'
import { validateRequiredFields } from '../../lib/validateRequiredFields.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { assertCIsLinkable } from '../../lib/ticketCIExclusions.js'
import { assertMayAcknowledgeNoSla } from '../../lib/slaAcknowledgement.js'
import { ticketSlaStatusResolver } from './ticketSlaStatus.js'
import { commentAuthorKind, commentAuthorLabel, commentTrace } from '../../lib/commentAuthor.js'
import { writeTicketComment } from '../../lib/ticketComments.js'
import { notifyCommentAudience } from './comments.js'
import { publishTicketUpdated } from '../../lib/ticketUpdated.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { listPage } from '../../lib/listLimit.js'
import { serviceRelPatternForTenant } from '../../lib/ciMetamodelForTenant.js'
import { orderByOrThrow } from '../../lib/sortField.js'
export type { IncidentEventPayload } from '../../services/incidentService.js'

// ── Mapper ───────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

// ── Query resolvers ──────────────────────────────────────────────────────────

/**
 * `number` c'è perché la colonna del web è ordinabile (revisione totale · B-9):
 * mancava, il resolver ricadeva su `created_at DESC` e la tabella mostrava la
 * freccia su una colonna che non ordinava. Il numero è una stringa con lo
 * stesso prefisso e lo stesso numero di cifre, quindi l'ordine lessicale è
 * quello cronologico.
 */
export const INCIDENT_SORT_WHITELIST: Record<string, string> = {
  number:    'number',
  title:     'title',
  severity:  'severity',
  status:    'status',
  createdAt: 'created_at',
}

function incidentOrderBy(sortField?: string | null, sortDirection?: string | null): string {
  // A-22: un campo non ordinabile è un errore, non un ordine diverso in
  // silenzio. Le colonne della whitelist sono senza alias: si aggiunge qui.
  const prefixed = Object.fromEntries(Object.entries(INCIDENT_SORT_WHITELIST).map(([k, v]) => [k, `i.${v}`]))
  return orderByOrThrow(prefixed, sortField, sortDirection ?? 'desc', 'i.created_at DESC', 'incidents(sortField)')
}

async function incidents(
  _: unknown,
  args: { status?: string; severity?: string; limit?: number; offset?: number; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, severity, filters, sortField, sortDirection } = args
  const { limit, offset } = listPage(args, 50)

  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      severity: severity ?? null,
      offset,
      limit,
    }
    // I campi del cliente si filtrano come quelli del prodotto (ondata 4).
    const allowedFields = new Set([...getScalarFields(info.schema, 'Incident'), ...(await requestCustomFieldDefs(ctx, 'incident')).map((d) => d.name)])
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'i', {}, 'Incident') : ''
    const whereClause = `
      WHERE ($status   IS NULL OR i.status   = $status)
        AND ($severity IS NULL OR i.severity = $severity)
        ${advWhere ? `AND (${advWhere})` : ''}
    `
    const itemRows = await runQuery<{ props: Props; uProps: Props | null; tProps: Props | null; cis: Array<{ props: Props; label: string }> }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
      WITH i, u, t ORDER BY ${incidentOrderBy(sortField, sortDirection)}
      SKIP toInteger($offset) LIMIT toInteger($limit)
      OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
      WITH i, u, t, collect(DISTINCT {props: properties(ci), label: head([l IN labels(ci) WHERE l <> 'ConfigurationItem'])}) AS cis
      RETURN properties(i) AS props, properties(u) AS uProps, properties(t) AS tProps, cis
    `, params)
    const countRows = await runQuery<{ total: number }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(i) AS total
    `, params)
    return {
      items: itemRows.map((r) => {
        const base = mapIncident(r.props) as ReturnType<typeof mapIncident> & { _prefetched: boolean }
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
      total: (countRows[0]?.total as unknown as { toNumber(): number })?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

async function incident(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id,
      tenantId: ctx.tenantId,
    })
    return row ? mapIncident(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createIncident(
  _: unknown,
  args: { input: { title: string; description?: string; severity?: string; impact?: string; urgency?: string; category?: string; affectedCIIds?: string[]; acknowledgeNoSla?: boolean | null ; customFields?: CustomFieldInput[] | null } },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await validateRequiredFields(session, {
      entityType:  'incident',
      // Le regole di obbligatorietà valgono anche sui campi del cliente (ondata 4).
      fieldValues: { ...(args.input as Record<string, unknown>), ...customFieldValueMap(args.input.customFields) },
      tenantId:    ctx.tenantId,
    })
    assertMayAcknowledgeNoSla(ctx, args.input.acknowledgeNoSla)
    const result = await incidentService.createIncident(args.input, ctx)
    void audit(ctx, 'incident.created', 'Incident', result.id as string)
    return result
  })
}

async function updateIncident(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; severity?: string; impact?: string; urgency?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    // Le regole "campo obbligatorio" si valutano sullo stato RISULTANTE
    // (persistito + patch), non sulla sola patch: altrimenti un update parziale
    // fallirebbe sui campi obbligatori non toccati.
    const current = await runQueryOne<{ props: Props }>(session,
      'MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props',
      { id, tenantId: ctx.tenantId })
    if (!current) throw new NotFoundError('Incident', id)
    await validateRequiredFields(session, {
      entityType:  'incident',
      fieldValues: { ...mergedFieldValues(current.props), ...(input as Record<string, unknown>) },
      tenantId:    ctx.tenantId,
    })

    // Priorità (severity) = Impatto × Urgenza, sempre coerenti tra loro:
    //  - impact/urgency nella patch → severity ricalcolata (merge col corrente);
    //  - solo severity nella patch → impact/urgency riallineati alla severity.
    const { severity, impact, urgency } = await resolvePriorityPatch(
      ctx.tenantId,
      { impact: current.props['impact'] as string | null, urgency: current.props['urgency'] as string | null },
      { priority: input.severity, impact: input.impact, urgency: input.urgency },
    )

    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      // La descrizione si può SVUOTARE (revisione totale · B-17): con
      // «coalesce» null e assente erano la stessa cosa, e chi cancellava un
      // testo sbagliato lo ritrovava lì dopo il salvataggio. Ora conta se il
      // campo è presente nell'input. Il titolo no: un ticket senza titolo non
      // si riconosce in nessun elenco.
      SET i += {
        title:       coalesce($title, i.title),
        description: CASE WHEN $descriptionGiven THEN $description ELSE i.description END,
        severity:    coalesce($severity, i.severity),
        impact:      coalesce($impact, i.impact),
        urgency:     coalesce($urgency, i.urgency),
        updated_at:  $now
      }
      RETURN properties(i) as props
    `
    // NB: status is intentionally NOT settable here — an incident's status is
    // the workflow current step and must only change via executeWorkflowTransition
    // (which keeps WorkflowInstance.current_step and the entity status in sync).
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title       ?? null,
      description: input.description ?? null,
      // B-17: «presente nell'input» distingue il vuoto dall'assenza.
      descriptionGiven: Object.prototype.hasOwnProperty.call(input, 'description'),
      severity,
      impact,
      urgency,
      now,
    })
    const row = rows[0]
    if (!row) throw new NotFoundError('Incident', id)
    await publishTicketUpdated(ctx, 'incident', id, current.props, row.props)
    return mapIncident(row.props)
  }, true)
}

async function resolveIncident(
  _: unknown,
  args: { id: string; rootCause?: string },
  ctx: GraphQLContext,
) {
  return incidentService.resolveIncident(args.id, ctx, args.rootCause)
}

async function assignIncidentToTeam(
  _: unknown,
  args: { id: string; teamId: string },
  ctx: GraphQLContext,
) {
  const result = await incidentService.assignIncidentToTeam(args.id, args.teamId, ctx)
  void audit(ctx, 'incident.assigned', 'Incident', args.id)
  return result
}

async function assignIncidentToUser(
  _: unknown,
  args: { id: string; userId: string | null },
  ctx: GraphQLContext,
) {
  const result = await incidentService.assignIncidentToUser(args.id, args.userId, ctx)
  void audit(ctx, 'incident.assigned', 'Incident', args.id)
  return result
}

async function addAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  // CM-8: i tipi di CI esclusi per gli incident non si collegano, qui come
  // alla creazione (prima valevano solo qui, e come elenco degli ammessi).
  await assertCIsLinkable(ctx.tenantId, 'incident', [args.ciId])
  const ciWhereClause = await ciLabelPredicateForTenant('ci', ctx.tenantId)

  return withSession(async (session) => {
    // Righe CONTATE come in `createIncident` (C-2): se il CI non esiste in
    // questo cliente il MERGE non scrive niente — e prima la mutation
    // rispondeva con l'incident intatto, come se il collegamento ci fosse.
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciWhereClause}
      MERGE (i)-[r:AFFECTED_BY]->(ci)
      SET i.updated_at = $now
      RETURN count(r) AS linked
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    if (Number(res.records[0]?.get('linked') ?? 0) === 0) {
      throw new ValidationError(`CI ${args.ciId} not linked to the incident: it does not exist in this tenant`, { key: 'errors.ciLink.incident', params: { ci: args.ciId } })
    }
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new NotFoundError('Incident', args.incidentId)
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function removeAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
            -[r:AFFECTED_BY]->(ci {id: $ciId, tenant_id: $tenantId})
      DELETE r
      SET i.updated_at = $now
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new NotFoundError('Incident', args.incidentId)
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function addIncidentComment(
  _: unknown,
  args: { id: string; text: string; isInternal?: boolean | null },
  ctx: GraphQLContext,
) {
  // Un modello solo (lib/ticketComments.ts). Senza scelta esplicita è una nota
  // interna: una risposta pubblica a chi ha aperto il ticket si chiede.
  const isInternal = args.isInternal !== false
  return withSession(async (session) => {
    const row = await writeTicketComment(session, {
      entityType: 'incident', entityId: args.id, tenantId: ctx.tenantId,
      text: args.text, authorId: ctx.userId, isInternal,
    })
    if (!row) throw new NotFoundError('Incident', args.id)
    void audit(ctx, 'comment.added', 'Incident', args.id, { commentId: row.comment['id'], isInternal })
    // CO-3: stesse notifiche di ogni altro commento (osservatori, menzioni).
    void notifyCommentAudience(ctx, 'incident', args.id, args.text, isInternal)
    return mapComment(row.comment, row.author)
  }, true)
}

function mapComment(c: Props, u: Props | null) {
  return {
    id:          c['id']         as string,
    text:        c['text']       as string,
    isInternal:  c['is_internal'] === true,
    createdAt:   c['created_at'] as string,
    updatedAt:   c['updated_at'] as string,
    author:      u ? mapUser(u) : null,
    authorKind:  commentAuthorKind(c, !!u),
    authorLabel: commentAuthorLabel(c),
    ...commentTrace(c),
  }
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function incidentAssignedTeam(
  parent: { id: string; tenantId: string; assignedTeam?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignedTeam ?? null
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN t
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const t = result.records[0]!.get('t').properties as Props
    return mapTeam(t)
  })
}

async function incidentAssignee(
  parent: { id: string; tenantId: string; assignee?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignee ?? null
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapUser(row.props) : null
  })
}

async function incidentAffectedCIs(
  parent: { id: string; tenantId: string; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return (parent as unknown as { affectedCIs: unknown[] }).affectedCIs
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) as props, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
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

async function incidentImpactedApplications(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // Applicazioni impattate = quelle che dipendono (DEPENDS_ON/HOSTED_ON, anche
    // transitivamente fino a 5 hop) dal CI colpito dall'incident. La lunghezza 0
    // include l'app eventualmente colpita in modo diretto. Per ogni app teniamo
    // il percorso più breve verso un CI colpito; `path` è la catena di CI
    // ORDINATA dal CI colpito → … → applicazione (direzione di propagazione
    // dell'impatto), pronta da disegnare come grafo lato UI.
    // CM-3: le relazioni dei servizi del tenant (anche INSTALLED_ON,
    // USES_CERTIFICATE e quelle del cliente), non due scritte qui.
    const relPattern = await serviceRelPatternForTenant(ctx.tenantId)
    /**
     * Le CANDIDATE prima dei cammini (revisione totale · B-34): la query
     * partiva da OGNI applicazione del cliente e cercava il cammino più breve
     * verso ogni CI colpito — un prodotto cartesiano (500 applicazioni × 5 CI
     * = 2.500 `shortestPath` a ogni apertura del dettaglio). Ora si risale
     * dai CI colpiti, che sono pochi, per trovare le applicazioni davvero
     * collegate; il cammino più breve si calcola solo per quelle.
     */
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(affected)
      WHERE affected.tenant_id = $tenantId
      WITH collect(DISTINCT affected) AS targets
      UNWIND targets AS target
      MATCH (candidate)-[:${relPattern}*0..5]->(target)
      WHERE candidate.tenant_id = $tenantId AND 'Application' IN labels(candidate)
      WITH targets, collect(DISTINCT candidate) AS apps
      UNWIND apps AS app
      UNWIND targets AS affected
      MATCH p = shortestPath( (app)-[:${relPattern}*0..5]->(affected) )
      WITH app, affected, p
      ORDER BY length(p) ASC
      WITH app, head(collect({affected: affected, p: p})) AS best
      RETURN properties(app) AS props, head([l IN labels(app) WHERE l <> 'ConfigurationItem']) AS label,
             length(best.p) AS distance, best.affected.name AS via,
             [n IN reverse(nodes(best.p)) | {id: n.id, name: n.name, type: head([l IN labels(n) WHERE l <> 'ConfigurationItem'])}] AS path
      ORDER BY distance ASC, props.name ASC
    `
    const rows = await runQuery<{ props: Props; label: string; distance: number; via: string | null; path: Array<{ id: string; name: string; type: string }> }>(
      session, cypher, { id: parent.id, tenantId: ctx.tenantId },
    )
    return rows.map((r) => {
      const t = ciTypeFromLabels(ctx.tenantId, [r.label])
      r.props['type'] = t
      const ci = mapCI(r.props) as Record<string, unknown>
      ci['ciType']     = t
      ci['__typename'] = r.label || 'Application'
      return {
        ci,
        distance: Number(r.distance),
        via: r.via,
        path: r.path.map((n) => ({ id: n.id, name: n.name, type: ciTypeFromLabels(ctx.tenantId, [n.type]) })),
      }
    })
  })
}

async function incidentComments(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
      OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
      RETURN properties(c) AS cProps, properties(u) AS uProps
      ORDER BY c.created_at ASC
    `
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapComment(r.cProps, r.uProps))
  })
}

const incidentSlaStatus = ticketSlaStatusResolver('Incident')

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Dichiarare (o ritirare) un Major Incident — revisione del 14 set 2026 · IT-24:
 * prima scriveva il flag e l'audit e basta. Nessun evento, quindi nessuna
 * regola di notifica, automazione o webhook poteva reagire proprio nel momento
 * in cui serve di più. L'evento parte solo quando il flag cambia davvero.
 */
async function setIncidentMajor(_: unknown, args: { id: string; major: boolean }, ctx: GraphQLContext) {
  requirePermission(ctx, 'incident.write')
  const now = new Date().toISOString()
  const { props, changed } = await withSession(async (session) => {
    const rows = await runQuery<{ props: Props; was: unknown }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      WITH i, coalesce(i.major, false) AS was
      SET i.major = $major, i.updated_at = $now
      RETURN properties(i) as props, was
    `, { id: args.id, tenantId: ctx.tenantId, major: args.major, now })
    if (!rows[0]) throw new NotFoundError('Incident', args.id)
    return { props: rows[0].props, changed: rows[0].was !== args.major }
  }, true)
  if (changed) {
    const type = args.major ? 'incident.major_declared' : 'incident.major_cleared'
    void audit(ctx, type, 'Incident', args.id)
    await publishEvent(type, ctx.tenantId, ctx.userId, {
      id: args.id, title: props['title'] as string, severity: props['severity'] as string, status: props['status'] as string,
      number: (props['number'] ?? null) as string | null,
    }, now)
  }
  return mapIncident(props)
}

export const incidentResolvers = {
  Query: { incidents, incident },

  Mutation: { createIncident, updateIncident, resolveIncident, assignIncidentToTeam, assignIncidentToUser, addIncidentComment, addAffectedCI, removeAffectedCI, setIncidentMajor },
  Incident: {
    assignee:        incidentAssignee,
    assignedTeam:    incidentAssignedTeam,
    affectedCIs:     incidentAffectedCIs,
    impactedApplications: incidentImpactedApplications,
    comments:        incidentComments,
    slaStatus:       incidentSlaStatus,
  },
}
