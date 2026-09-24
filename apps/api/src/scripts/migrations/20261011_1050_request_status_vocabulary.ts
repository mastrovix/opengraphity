/**
 * Tour of 24 Sep 2026: the shipped dictionary «Service Request Status» had
 * four values — open, in_progress, completed, cancelled — while the factory
 * workflow of the requests has six steps (submitted, approval, in_progress,
 * fulfilled, closed, rejected). The values are the steps' names: a rule on
 * the status of a request offered values that never occur.
 *
 * Only the shipped dictionary (tenant `system`), and only while it still has
 * the old list: a customer's own copy stays as the customer made it.
 * Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

const OLD = ['open', 'in_progress', 'completed', 'cancelled']
const NEW = ['submitted', 'approval', 'in_progress', 'fulfilled', 'closed', 'rejected']

export const requestStatusVocabulary: Migration = {
  id: '20261011_1050_request_status_vocabulary',
  description: 'Shipped Service Request Status dictionary: the steps of the factory workflow',
  async up(session) {
    const res = await session.run(`
      MATCH (e:EnumTypeDefinition {tenant_id: 'system', name: 'status_service_request'})
      WHERE e.values = $old
      SET e.values = $new, e.updated_at = toString(datetime())
      RETURN count(e) AS n
    `, { old: OLD, new: NEW })
    console.log(`[${requestStatusVocabulary.id}] updated: ${String(res.records[0]?.get('n') ?? 0)}`)
  },
}
