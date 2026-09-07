/**
 * Creazione dei requisiti di approvazione all'ingresso nello step "approval".
 * Isolato (nessun import da helpers/autoTransitions) per evitare cicli: è
 * chiamato da afterEnterStep. Vedi approvalGate.ts per approva/rigetta/gate.
 */
import { runQuery, runQueryOne } from '../ci-utils.js'
import { logger } from '../../../lib/logger.js'

type Session = Parameters<typeof runQuery>[0]

/** Crea i record di approvazione (idempotente). Standard = pre-approvata (nessun record). */
export async function createChangeApprovals(session: Session, changeId: string, tenantId: string): Promise<void> {
  const change = await runQueryOne<{ changeType: string; existing: number }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    OPTIONAL MATCH (c)-[:HAS_APPROVAL]->(a:ChangeApproval)
    RETURN c.change_type AS changeType, count(a) AS existing
  `, { changeId, tenantId })
  if (!change) return
  if (change.changeType === 'standard') return
  if (Number(change.existing) > 0) return

  const now = new Date().toISOString()
  // 1) Change Manager team designato (is_change_manager)
  await runQuery(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    MATCH (cm:Team {tenant_id: $tenantId, is_change_manager: true})
    CREATE (c)-[:HAS_APPROVAL]->(:ChangeApproval {
      id: randomUUID(), tenant_id: $tenantId, kind: 'change_manager',
      team_id: cm.id, status: 'pending', created_at: $now
    })
  `, { changeId, tenantId, now })

  // 2) Un requisito per ciascun owner group DISTINTO dei CI affected
  await runQuery(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)-[:OWNED_BY]->(og:Team)
    WITH c, collect(DISTINCT og) AS groups
    UNWIND groups AS og
    CREATE (c)-[:HAS_APPROVAL]->(:ChangeApproval {
      id: randomUUID(), tenant_id: $tenantId, kind: 'owner_group',
      team_id: og.id, status: 'pending', created_at: $now
    })
  `, { changeId, tenantId, now })

  const cm = await runQueryOne<{ n: number }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval {kind: 'change_manager'})
    RETURN count(a) AS n
  `, { changeId, tenantId })
  if (!cm || Number(cm.n) === 0) {
    logger.error({ changeId, tenantId }, '[approvalGate] nessun team Change Manager designato (is_change_manager): la change non potrà essere approvata finché non ne configuri uno')
  }
}
