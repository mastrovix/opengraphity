/**
 * THE REJECTED REQUEST ENDED BADLY (tour of 23 Sep 2026, D27).
 *
 * The factory step `rejected` of the service-request workflow had category
 * `closed`, the same as a request fulfilled and closed: lists, the Audit Log
 * and the workflow page could not tell a rejection from a fulfilment, and the
 * page drew «Reject» in the style of the main action. The rejection of a
 * problem is `failed` («finito male: annullato, rifiutato, non riuscito»,
 * WORKFLOW_STEP_CATEGORIES); the request's now is too.
 *
 * Only the factory step, only where it still has the factory category: a
 * category the customer chose is not touched. Idempotent by construction.
 */
import type { Migration } from '@opengraphity/neo4j'

export const requestRejectedFailed: Migration = {
  id: '20261007_1060_request_rejected_failed',
  description: 'WorkflowStep.category = failed on the factory step "rejected" of the service-request workflows (it was closed, like a fulfilled request)',
  async up(session) {
    const res = await session.run(`
      MATCH (wd:WorkflowDefinition {entity_type: 'service_request'})-[:HAS_STEP]->(s:WorkflowStep {name: 'rejected'})
      WHERE s.category = 'closed' AND coalesce(s.is_terminal, false) = true
      SET s.category = 'failed'
      RETURN wd.tenant_id AS tenant, wd.name AS definition
      ORDER BY tenant, definition
    `)
    for (const r of res.records) {
      console.log(`[${requestRejectedFailed.id}] ${String(r.get('tenant'))} / "${String(r.get('definition'))}" / rejected → category "failed"`)
    }
    console.log(`[${requestRejectedFailed.id}] ${String(res.records.length)} steps moved to "failed"`)
  },
}
