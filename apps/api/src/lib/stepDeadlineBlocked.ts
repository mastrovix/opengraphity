/**
 * I ticket che la scadenza del loro passo non è riuscita a spostare, e che sono
 * ancora lì (verifica «Cosa resta cablato», ondata 3). L'esito lo scrive
 * `lib/stepDeadlines.ts` sull'esecuzione del passo; qui la sola lettura, per la
 * diagnostica, senza caricare il motore.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'

export interface BlockedDeadline { number: string; step: string; outcome: string; reason: string }

/**
 * Starts from the executions (index on tenant and deadline outcome), not from
 * the instances: walking every instance and every execution of the tenant
 * took 0.66 s on a million executions, at every refresh of the diagnostics
 * (tour of 23 Sep 2026, D67).
 */
export async function blockedStepDeadlines(session: Session, tenantId: string): Promise<BlockedDeadline[]> {
  const rows = await runQuery<Record<string, unknown>>(session, `
    MATCH (ex:WorkflowStepExecution {tenant_id: $tenantId})
    WHERE ex.deadline_outcome IN ['refused', 'failed'] AND ex.exited_at IS NULL
    MATCH (wi:WorkflowInstance {tenant_id: $tenantId})-[:STEP_HISTORY]->(ex)
    OPTIONAL MATCH (e)-[:HAS_WORKFLOW]->(wi)
    RETURN coalesce(e.number, e.code, wi.entity_id) AS number, ex.step_name AS step,
           ex.deadline_outcome AS outcome, ex.deadline_reason AS reason
    ORDER BY number
  `, { tenantId })
  return rows.map((r) => ({ number: String(r['number']), step: String(r['step']), outcome: String(r['outcome']), reason: String(r['reason'] ?? '') }))
}
