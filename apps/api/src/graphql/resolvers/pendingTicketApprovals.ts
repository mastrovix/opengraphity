import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'

/**
 * Le approvazioni che aspettano l'utente FUORI dalle richieste generiche:
 *
 *  - i requisiti ancora aperti delle change in approvazione, per i team di cui
 *    l'utente è membro (tutti, se è admin: può approvare per qualunque team);
 *  - le service request ferme in un passo di scopo `approval`, per chi può
 *    farle avanzare (admin e operator).
 *
 * Prima la pagina Approvazioni e il suo badge contavano solo le
 * `ApprovalRequest` (pubblicazione degli articoli KB): una change con due
 * approvazioni pendenti e una richiesta in approvazione non comparivano da
 * nessuna parte (giro del 14 set 2026). Si decidono nella pagina del ticket:
 * qui c'è il link.
 */
export async function pendingTicketApprovals(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
): Promise<Array<{ kind: string; entityId: string; number: string | null; title: string; detail: string | null; requestedAt: string | null }>> {
  const session = getSession(undefined, 'READ')
  try {
    const changes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval {status: 'pending'})
      WHERE coalesce(c.deleted, false) = false
      MATCH (t:Team {id: a.team_id, tenant_id: $tenantId})
      WHERE $isAdmin OR exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(t))
      RETURN c.id AS entityId, c.number AS number, c.title AS title, t.name AS detail, a.created_at AS requestedAt
      ORDER BY requestedAt DESC
    `, { tenantId: ctx.tenantId, userId: ctx.userId, isAdmin: ctx.role === 'admin' }))
    const requests = ctx.role === 'admin' || ctx.role === 'operator'
      ? await session.executeRead((tx) => tx.run(`
          MATCH (r:ServiceRequest {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(st:WorkflowStep {purpose: 'approval'})
          RETURN r.id AS entityId, r.number AS number, r.title AS title, coalesce(st.label, st.name) AS detail, wi.updated_at AS requestedAt
          ORDER BY requestedAt DESC
        `, { tenantId: ctx.tenantId }))
      : { records: [] }
    const row = (kind: string) => (r: { get: (k: string) => unknown }) => ({
      kind,
      entityId:    r.get('entityId') as string,
      number:      (r.get('number') ?? null) as string | null,
      title:       (r.get('title') ?? '') as string,
      detail:      (r.get('detail') ?? null) as string | null,
      requestedAt: (r.get('requestedAt') ?? null) as string | null,
    })
    return [...changes.records.map(row('change')), ...requests.records.map(row('service_request'))]
  } finally {
    await session.close()
  }
}

