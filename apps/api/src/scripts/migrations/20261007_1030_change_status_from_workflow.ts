/**
 * EVERY CHANGE HAS A STATUS (browser tour of 23 Sep 2026, D3).
 *
 * `createChangeRFC` created the change without `status` — incidents and
 * problems are born with the name of their initial step, changes were not —
 * and the status appeared only at the first transition. On the demo tenant
 * the 177 changes still in assessment showed as «(none)» in «Changes by
 * status», the «Open Changes» KPI counted 425 instead of 602, and the AI
 * assistant left them out of «changes in flight».
 *
 * Creation now writes the initial step; this migration fills the status of
 * the changes created before, from the step their workflow instance is in.
 * Only changes without a status are touched, so it is idempotent and never
 * overwrites a status the workflow has written. `autocommit`: `CALL … IN
 * TRANSACTIONS` cannot run inside the migration marker's transaction.
 */
import type { Migration } from '@opengraphity/neo4j'

export const changeStatusFromWorkflow: Migration = {
  id: '20261007_1030_change_status_from_workflow',
  description: 'Give every change without a status the name of the step its workflow instance is in',
  autocommit: true,

  async up(session) {
    const result = await session.run(`
      MATCH (c:Change)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE c.status IS NULL AND wi.current_step IS NOT NULL
      CALL (c, wi) { SET c.status = wi.current_step } IN TRANSACTIONS OF 1000 ROWS
      RETURN count(c) AS updated
    `, {})
    const updated = Number(result.records[0]?.get('updated') ?? 0)
    console.log(`[${changeStatusFromWorkflow.id}] ${updated === 0 ? 'every change already has a status' : `status written on ${String(updated)} changes`}`)
  },
}
