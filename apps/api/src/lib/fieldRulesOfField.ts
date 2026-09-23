/**
 * THE RULES THAT NAME A FIELD GO WITH IT (review of 23 Sep 2026).
 *
 * A requirement rule (`FieldRequirementRule.field_name`) or a visibility rule
 * (`FieldVisibilityRule.trigger_field` / `target_field`) names a field of a
 * type by its name. Deleting the field left them behind: a field «required
 * in step X» that no longer exists blocked every transition into X, with a
 * message about a field nobody could fill; and a field created later with the
 * same name inherited rules nobody wrote for it.
 *
 * Called inside the transaction that deletes the field: both go, or neither.
 */
import type { ManagedTransaction } from 'neo4j-driver'
import { toNumber } from '@opengraphity/neo4j'

export async function deleteFieldRulesOf(
  tx: ManagedTransaction, tenantId: string, entityType: string, fieldName: string,
): Promise<number> {
  const res = await tx.run(`
    OPTIONAL MATCH (req:FieldRequirementRule {tenant_id: $tenantId, entity_type: $entityType, field_name: $fieldName})
    WITH collect(req) AS reqs
    OPTIONAL MATCH (vis:FieldVisibilityRule {tenant_id: $tenantId, entity_type: $entityType})
    WHERE vis.trigger_field = $fieldName OR vis.target_field = $fieldName
    WITH reqs + collect(vis) AS rules
    FOREACH (r IN rules | DETACH DELETE r)
    RETURN size(rules) AS removed
  `, { tenantId, entityType, fieldName })
  return toNumber(res.records[0]?.get('removed'))
}
