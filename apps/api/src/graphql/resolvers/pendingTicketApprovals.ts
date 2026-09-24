import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { hasPermission } from '../../lib/permissions.js'

/**
 * Le approvazioni che aspettano l'utente FUORI dalle richieste generiche:
 *
 *  - i requisiti ancora aperti delle change in approvazione, per i team di cui
 *    l'utente è membro (tutti, se è admin: può approvare per qualunque team).
 *    Una change ne ha DUE (`owner_group` e `change_manager`): `approvalKind`
 *    dice quale, se no la pagina mostra due righe identiche (20 set 2026);
 *  - le service request ferme in un passo di scopo `approval`, per chi può
 *    farle avanzare (admin e operator).
 *
 * Prima la pagina Approvazioni e il suo badge contavano solo le
 * `ApprovalRequest` (pubblicazione degli articoli KB): una change con due
 * approvazioni pendenti e una richiesta in approvazione non comparivano da
 * nessuna parte (giro del 14 set 2026). Si decidono nella pagina del ticket:
 * qui c'è il link.
 *
 * WHOSE they are (24 Sep 2026, owner's decisions): «mine» are only those of
 * the teams the person is a member of — a change's requirement of their
 * team, a request assigned to their team. What they may decide only by
 * `approval.override` (or, for a request of another team, `approval.decide`)
 * comes back with `onBehalf`, and the page shows it apart, outside the
 * counter. What the person asked for themselves is not here at all: another
 * member of the group approves it.
 */
export async function pendingTicketApprovals(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
): Promise<Array<{ kind: string; entityId: string; number: string | null; title: string; detail: string | null; approvalKind: string | null; requestedAt: string | null; onBehalf: boolean }>> {
  const session = getSession(undefined, 'READ')
  try {
    const changes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval {status: 'pending'})
      WHERE coalesce(c.deleted, false) = false
        AND NOT exists((c)-[:REQUESTED_BY]->(:User {id: $userId, tenant_id: $tenantId}))
      MATCH (t:Team {id: a.team_id, tenant_id: $tenantId})
      WITH c, a, t, exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(t)) AS member
      WHERE member OR $override
      RETURN c.id AS entityId, c.number AS number, c.title AS title, t.name AS detail,
             a.kind AS approvalKind, a.created_at AS requestedAt, NOT member AS onBehalf
      ORDER BY requestedAt DESC
    `, { tenantId: ctx.tenantId, userId: ctx.userId, override: hasPermission(ctx, 'approval.override') }))
    const requests = hasPermission(ctx, 'approval.decide')
      ? await session.executeRead((tx) => tx.run(`
          MATCH (r:ServiceRequest {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:CURRENT_STEP]->(st:WorkflowStep {purpose: 'approval'})
          WHERE NOT exists((r)-[:REQUESTED_BY]->(:User {id: $userId, tenant_id: $tenantId}))
          OPTIONAL MATCH (r)-[:ASSIGNED_TO_TEAM]->(team:Team {tenant_id: $tenantId})
          WITH r, wi, st, team,
               team IS NULL OR exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)) AS member
          RETURN r.id AS entityId, r.number AS number, r.title AS title,
                 coalesce(team.name, st.label, st.name) AS detail,
                 null AS approvalKind, wi.updated_at AS requestedAt, NOT member AS onBehalf
          ORDER BY requestedAt DESC
        `, { tenantId: ctx.tenantId, userId: ctx.userId }))
      : { records: [] }
    const row = (kind: string) => (r: { get: (k: string) => unknown }) => ({
      kind,
      entityId:    r.get('entityId') as string,
      number:      (r.get('number') ?? null) as string | null,
      title:       (r.get('title') ?? '') as string,
      detail:      (r.get('detail') ?? null) as string | null,
      approvalKind: (r.get('approvalKind') ?? null) as string | null,
      requestedAt: (r.get('requestedAt') ?? null) as string | null,
      onBehalf:    r.get('onBehalf') === true,
    })
    return [...changes.records.map(row('change')), ...requests.records.map(row('service_request'))]
  } finally {
    await session.close()
  }
}

