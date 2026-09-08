/**
 * Ticket collegati (stile change) per Incident e Problem.
 *
 * Relazioni:
 *   - stesso tipo (incident↔incident, problem↔problem): (a)-[:RELATED_TO]-(b)
 *   - incident↔problem: (problem)-[:CAUSED_BY]->(incident)  (link esistente)
 *   - entity↔change:    (entity)-[:RESOLVED_BY]->(change)   (link esistente)
 *
 * Qui vivono: le mutation generiche RELATED_TO e i field resolver che
 * restituiscono i ticket collegati come LinkedTicketRef {id, number, title, status}.
 */
import { GraphQLError } from 'graphql'
import { withSession, runQuery } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'

const LABEL: Record<string, string> = { incident: 'Incident', problem: 'Problem' }

function labelOf(entityType: string): string {
  const l = LABEL[entityType]
  if (!l) throw new GraphQLError(`Tipo ticket non valido: ${entityType}`, { extensions: { code: 'BAD_USER_INPUT' } })
  return l
}

/** Collega due ticket dello stesso tipo (RELATED_TO, non orientata a livello logico). */
export async function linkRelatedTicket(_: unknown, args: { entityType: string; entityId: string; otherId: string }, ctx: GraphQLContext) {
  const label = labelOf(args.entityType)
  if (args.entityId === args.otherId) throw new GraphQLError('Non puoi collegare un ticket a sé stesso', { extensions: { code: 'BAD_USER_INPUT' } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (a:${label} {id: $entityId, tenant_id: $tenantId})
      MATCH (b:${label} {id: $otherId,  tenant_id: $tenantId})
      MERGE (a)-[:RELATED_TO]-(b)
      RETURN a.id AS id
    `, { entityId: args.entityId, otherId: args.otherId, tenantId: ctx.tenantId }))
    if (r.records.length === 0) throw new GraphQLError('Ticket non trovato', { extensions: { code: 'NOT_FOUND' } })
  }, true)
  return true
}

export async function unlinkRelatedTicket(_: unknown, args: { entityType: string; entityId: string; otherId: string }, ctx: GraphQLContext) {
  const label = labelOf(args.entityType)
  await withSession(async (session) => {
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (a:${label} {id: $entityId, tenant_id: $tenantId})-[r:RELATED_TO]-(b:${label} {id: $otherId, tenant_id: $tenantId})
      DELETE r
      RETURN count(r) AS n
    `, { entityId: args.entityId, otherId: args.otherId, tenantId: ctx.tenantId }))
    const n = Number(res.records[0]?.get('n') ?? 0)
    // Fail-loud: un id sbagliato o un link già rimosso non è "successo".
    if (n === 0) throw new GraphQLError('Collegamento non trovato', { extensions: { code: 'NOT_FOUND' } })
  }, true)
  return true
}

// ── Field resolvers ────────────────────────────────────────────────────────────

interface Ref { id: string; number: string; title: string; status: string; severity?: string | null; priority?: string | null; removable?: boolean | null }

async function query(cypher: string, params: Record<string, unknown>): Promise<Ref[]> {
  return withSession(async (session) => {
    const rows = await runQuery<Ref>(session, cypher, params)
    return rows.map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, severity: r.severity ?? null, priority: r.priority ?? null, removable: r.removable ?? true }))
  })
}

// Incident: incident collegati (RELATED_TO), problem che lo includono
// (CAUSED_BY entrante), change che lo risolvono (RESOLVED_BY).
export function incidentRelatedIncidents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (i:Incident {id: $id, tenant_id: $t})-[:RELATED_TO]-(o:Incident {tenant_id: $t})
    RETURN o.id AS id, o.number AS number, o.title AS title, o.status AS status, o.severity AS severity
    ORDER BY o.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}
export function incidentRelatedProblems(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (p:Problem {tenant_id: $t})-[:CAUSED_BY]->(i:Incident {id: $id, tenant_id: $t})
    RETURN p.id AS id, p.number AS number, p.title AS title, p.status AS status, p.priority AS priority
    ORDER BY p.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}
export function incidentRelatedChanges(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (i:Incident {id: $id, tenant_id: $t})-[rel:RESOLVED_BY]->(c:Change {tenant_id: $t})
    WHERE coalesce(c.deleted, false) = false
    RETURN c.id AS id, c.code AS number, c.title AS title, coalesce(c.approval_status,'') AS status, (NOT coalesce(rel.auto, false)) AS removable
    ORDER BY c.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}

// Problem: incident collegati (CAUSED_BY), problem collegati (RELATED_TO),
// change che lo risolvono (RESOLVED_BY). Shape uniforme LinkedTicketRef.
export function problemLinkedIncidents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (p:Problem {id: $id, tenant_id: $t})-[:CAUSED_BY]->(i:Incident {tenant_id: $t})
    RETURN i.id AS id, i.number AS number, i.title AS title, i.status AS status, i.severity AS severity
    ORDER BY i.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}
export function problemRelatedProblems(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (p:Problem {id: $id, tenant_id: $t})-[:RELATED_TO]-(o:Problem {tenant_id: $t})
    RETURN o.id AS id, o.number AS number, o.title AS title, o.status AS status, o.priority AS priority
    ORDER BY o.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}
export function problemLinkedChanges(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return query(`
    MATCH (p:Problem {id: $id, tenant_id: $t})-[rel:RESOLVED_BY]->(c:Change {tenant_id: $t})
    WHERE coalesce(c.deleted, false) = false
    RETURN c.id AS id, c.code AS number, c.title AS title, coalesce(c.approval_status,'') AS status, (NOT coalesce(rel.auto, false)) AS removable
    ORDER BY c.created_at DESC
  `, { id: parent.id, t: ctx.tenantId })
}
