/**
 * REST API v1 — Incidents.
 *
 * Writes go through the same code paths as GraphQL (incidentService for
 * creation, the updateIncident resolver for patches) so numbering, workflow
 * instance, SLA, priority derivation and domain events behave identically.
 * `status` is NOT patchable: an incident's status is its workflow step and only
 * changes via workflow transitions (A-08).
 *
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import * as incidentService from '../../services/incidentService.js'
import { incidentResolvers } from '../../graphql/resolvers/incident.js'
import { mapIncident } from '../../lib/mappers.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiCtx, apiKeyOf, optionalBodyString, optionalString, parsePagination, requiredString } from '../apiContext.js'
import { customFieldDefs, parseRestCustomFields, restCustomFieldValues } from '../../lib/ticketCustomFields.js'
import { ticketCustomFieldResolvers } from '../../graphql/resolvers/ticketCustomFields.js'
import { writeTicketComment } from '../../lib/ticketComments.js'
import { notifyCommentAudience } from '../../graphql/resolvers/comments.js'
import { audit } from '../../lib/audit.js'
import { parametro } from '../parametroDiRotta.js'
import { logger } from '../../lib/logger.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

// Fields a REST client may patch. `status` is deliberately absent (see header).
const PATCHABLE_FIELDS = ['title', 'description', 'severity', 'impact', 'urgency'] as const
type PatchableField = (typeof PATCHABLE_FIELDS)[number]

// GET /api/v1/incidents
router.get('/', requirePermission('incidents:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const status   = optionalString(req.query, 'status')
  const severity = optionalString(req.query, 'severity')

  const filters: string[] = []
  const params: Record<string, unknown> = { tenantId: apiKeyOf(req).tenantId, limit, offset }
  if (status)   { filters.push('i.status = $status');     params['status'] = status }
  if (severity) { filters.push('i.severity = $severity'); params['severity'] = severity }
  const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

  const { rows, total, defs } = await withSession(async (session) => {
    const countRow = await runQueryOne<{ total: unknown }>(session,
      `MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where} RETURN count(i) AS total`, params)
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where}
      RETURN properties(i) AS props
      ORDER BY i.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)
    const defs = await customFieldDefs(session, apiKeyOf(req).tenantId, 'incident')
    return { rows, total: Number(countRow?.total ?? 0), defs }
  })

  res.json({ data: rows.map(r => ({ ...mapIncident(r.props), customFields: restCustomFieldValues(defs, r.props) })), meta: { page, limit, total } })
}))

// GET /api/v1/incidents/:id
router.get('/:id', requirePermission('incidents:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = parametro(req, 'id')
  const tenantId = apiKeyOf(req).tenantId
  const { row, defs } = await withSession(async (session) => ({
    row: await runQueryOne<{ props: Props }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) AS props
    `, { id, tenantId }),
    defs: await customFieldDefs(session, tenantId, 'incident'),
  }))
  if (!row) throw new NotFoundError('Incident', id)
  res.json({ data: { ...mapIncident(row.props), customFields: restCustomFieldValues(defs, row.props) } })
}))

// POST /api/v1/incidents
router.post('/', requirePermission('incidents:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const title       = requiredString(body, 'title')
  const description = optionalBodyString(body, 'description')
  const severity    = optionalBodyString(body, 'severity')
  const impact      = optionalBodyString(body, 'impact')
  const urgency     = optionalBodyString(body, 'urgency')
  const category    = optionalBodyString(body, 'category')
  // The team that takes it; absent → the support group of the first impacted CI that has one.
  const teamId      = optionalBodyString(body, 'teamId')
  const affectedCIIds = body['affectedCIIds']
  if (affectedCIIds !== undefined && (!Array.isArray(affectedCIIds) || affectedCIIds.some((v) => typeof v !== 'string'))) {
    throw new ValidationError('affectedCIIds must be an array of CI ids')
  }

  // incidentService validates the rest (impact+urgency or severity, ≥1 CI).
  const ctx = apiCtx(req)
  const result = await incidentService.createIncident(
    { title, description, severity, impact, urgency, category, affectedCIIds: affectedCIIds as string[] | undefined, customFields: parseRestCustomFields(body), teamId },
    { tenantId: ctx.tenantId, userId: ctx.userId },
  )
  res.status(201).json({ data: result })
}))

// PATCH /api/v1/incidents/:id
router.patch('/:id', requirePermission('incidents:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  if (body['status'] !== undefined) {
    throw new ValidationError('status cannot be set directly: use a workflow transition')
  }
  const unknown = Object.keys(body).filter((k) => k !== 'customFields' && !(PATCHABLE_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown field(s): ${unknown.join(', ')} — allowed: ${PATCHABLE_FIELDS.join(', ')}, customFields`)
  }

  const input: Partial<Record<PatchableField, string>> = {}
  for (const field of PATCHABLE_FIELDS) {
    const v = optionalBodyString(body, field)
    if (v !== undefined) input[field] = v
  }
  const customFields = parseRestCustomFields(body)
  if (Object.keys(input).length === 0 && customFields === undefined) throw new ValidationError('No patchable field provided')

  // Same resolvers as the UI: required-field rules, Impact×Urgency coherence,
  // and the customer's fields validated like the detail page (ondata 4).
  const id  = parametro(req, 'id')
  const ctx = apiCtx(req)
  const updated = Object.keys(input).length > 0 ? await incidentResolvers.Mutation.updateIncident(null, { id, input }, ctx) : null
  if (customFields === undefined) {
    res.json({ data: updated })
    return
  }
  await ticketCustomFieldResolvers.Mutation.setTicketCustomFields(null, { entityType: 'incident', id, values: customFields }, ctx)
  const { row, defs } = await withSession(async (session) => ({
    row: await runQueryOne<{ props: Props }>(session, 'MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props', { id, tenantId: ctx.tenantId }),
    defs: await customFieldDefs(session, ctx.tenantId, 'incident'),
  }))
  if (!row) throw new NotFoundError('Incident', id)
  res.json({ data: { ...mapIncident(row.props), customFields: restCustomFieldValues(defs, row.props) } })
}))

// POST /api/v1/incidents/:id/comments
router.post('/:id/comments', requirePermission('incidents:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const text = requiredString(body, 'text').trim()
  const id   = parametro(req, 'id')
  const key  = apiKeyOf(req)
  // Nota interna salvo richiesta esplicita: un'integrazione che vuole
  // rispondere a chi ha aperto il ticket lo dice (lib/ticketComments.ts).
  if (body['isInternal'] !== undefined && typeof body['isInternal'] !== 'boolean') {
    throw new ValidationError('isInternal must be a boolean', { key: 'errors.comment.isInternalBoolean' })
  }
  const isInternal = body['isInternal'] !== false

  // L'autore è la chiave API, non un nodo User: `author_label` porta il nome
  // della chiave, che è ciò che la pagina mostra (revisione totale · D-12 —
  // prima la rotta scriveva un `CREATE (:Comment)` proprio, senza autore
  // leggibile, senza audit e senza le notifiche a chi osserva il ticket,
  // quindi il richiedente non sapeva di aver ricevuto una risposta).
  const ctx = apiCtx(req)
  const written = await withSession((session) => writeTicketComment(session, {
    entityType: 'incident', entityId: id, tenantId: key.tenantId,
    text, authorId: key.keyId, authorLabel: key.name, isInternal,
  }), true)
  if (!written) throw new NotFoundError('Incident', id)
  void audit(ctx, 'comment.added', 'Incident', id, { commentId: written.comment['id'], isInternal, via: 'api_key' })
  // Le stesse notifiche di ogni altro commento: osservatori (una nota interna
  // non esce dal perimetro dello staff, M-16) e menzioni.
  void notifyCommentAudience(ctx, 'incident', id, text, isInternal)
    .catch((err: unknown) => logger.error({ err, incidentId: id }, '[rest] comment audience NOT notified'))
  res.status(201).json({ data: { id: written.comment['id'], text, isInternal } })
}))

export { router as incidentsRouter }
