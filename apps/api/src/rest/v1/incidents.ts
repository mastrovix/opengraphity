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

  const { rows, total } = await withSession(async (session) => {
    const countRow = await runQueryOne<{ total: unknown }>(session,
      `MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where} RETURN count(i) AS total`, params)
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where}
      RETURN properties(i) AS props
      ORDER BY i.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)
    return { rows, total: Number(countRow?.total ?? 0) }
  })

  res.json({ data: rows.map(r => mapIncident(r.props)), meta: { page, limit, total } })
}))

// GET /api/v1/incidents/:id
router.get('/:id', requirePermission('incidents:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const row = await withSession((session) => runQueryOne<{ props: Props }>(session, `
    MATCH (i:Incident {id: $id, tenant_id: $tenantId})
    RETURN properties(i) AS props
  `, { id, tenantId: apiKeyOf(req).tenantId }))
  if (!row) throw new NotFoundError('Incident', id)
  res.json({ data: mapIncident(row.props) })
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
  const affectedCIIds = body['affectedCIIds']
  if (affectedCIIds !== undefined && (!Array.isArray(affectedCIIds) || affectedCIIds.some((v) => typeof v !== 'string'))) {
    throw new ValidationError('affectedCIIds must be an array of CI ids')
  }

  // incidentService validates the rest (impact+urgency or severity, ≥1 CI).
  const ctx = apiCtx(req)
  const result = await incidentService.createIncident(
    { title, description, severity, impact, urgency, category, affectedCIIds: affectedCIIds as string[] | undefined },
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
  const unknown = Object.keys(body).filter((k) => !(PATCHABLE_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown field(s): ${unknown.join(', ')} — allowed: ${PATCHABLE_FIELDS.join(', ')}`)
  }

  const input: Partial<Record<PatchableField, string>> = {}
  for (const field of PATCHABLE_FIELDS) {
    const v = optionalBodyString(body, field)
    if (v !== undefined) input[field] = v
  }
  if (Object.keys(input).length === 0) throw new ValidationError('No patchable field provided')

  // Same resolver as the UI: required-field rules + Impact×Urgency coherence.
  const updated = await incidentResolvers.Mutation.updateIncident(null, { id: req.params['id']!, input }, apiCtx(req))
  res.json({ data: updated })
}))

// POST /api/v1/incidents/:id/comments
router.post('/:id/comments', requirePermission('incidents:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const text = requiredString(body, 'text').trim()
  const id   = req.params['id']!
  const key  = apiKeyOf(req)

  // Author is the API key (not a User node), so the GraphQL addIncidentComment
  // (which joins the User) is not reusable here.
  const rows = await withSession((session) => runQuery<{ id: string }>(session, `
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
    CREATE (c:Comment {id: randomUUID(), tenant_id: $tenantId, text: $text, author_id: $authorId, created_at: $now, updated_at: $now})
    CREATE (i)-[:HAS_COMMENT]->(c)
    RETURN c.id AS id
  `, { incidentId: id, tenantId: key.tenantId, text, authorId: key.keyId, now: new Date().toISOString() }), true)
  if (!rows[0]) throw new NotFoundError('Incident', id)
  res.status(201).json({ data: { id: rows[0].id, text } })
}))

export { router as incidentsRouter }
