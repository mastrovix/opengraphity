/**
 * Valutazioni e piano di deploy di una change tutti completati (e almeno un CI).
 *
 * Una funzione sola perché la leggono in due: la condizione
 * `all_assessments_complete` degli archi del workflow (workflow/conditions.ts)
 * e il varco di `windowGate.ts`, che la pretende per QUALUNQUE uscita
 * dall'analisi — anche da un arco senza condizione disegnato dal cliente.
 * Modulo senza effetti collaterali: `workflow/conditions.ts` all'import
 * registra le condizioni sul motore, e il varco non deve trascinarselo.
 */
import type { Session, ManagedTransaction } from 'neo4j-driver'
import { toNumber } from '@opengraphity/neo4j'
import { runQueryOne } from './db.js'
import { TASK_STATUS } from './taskStatus.js'

export async function areAllAssessmentsComplete(
  session: Session | ManagedTransaction, changeId: string, tenantId: string,
): Promise<boolean> {
  const row = await runQueryOne<{ pending: unknown }>(session as Session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    WITH c, count(ci) AS ciCount
    OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(at:AssessmentTask)
      WHERE at.status <> $completedStatus
    OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
      WHERE dp.status <> $completedStatus
    WITH ciCount, count(DISTINCT at) + count(DISTINCT dp) AS pending
    RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
  `, { changeId, tenantId, completedStatus: TASK_STATUS.COMPLETED })
  // Riga assente = change non trovata: 1 pendente, il varco resta chiuso.
  return (row?.pending == null ? 1 : toNumber(row.pending)) === 0
}
