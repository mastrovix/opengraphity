/**
 * The infrastructure flag, a field of every CI (owner, 24 Sep 2026): the
 * servers of backup, monitoring, jump hosts and the directory serve the whole
 * company, not one application, and no application chain reaches them — they
 * are marked `isInfrastructure` and left out of the chains (CMDB Health does
 * not count them as outside every application chain).
 *
 * A base field, like status and environment: declared once on `__base__`, it
 * reaches every CI type, shipped or the customer's. Absent on a CI = not
 * flagged. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

export const ciIsInfrastructureField: Migration = {
  id: '20261011_1070_ci_is_infrastructure_field',
  description: 'Base field isInfrastructure (boolean) on every CI: shared infrastructure stays out of the application chains',
  async up(session) {
    const res = await session.run(`
      MATCH (t:CITypeDefinition {name: '__base__', tenant_id: 'system'})
      MERGE (f:CIFieldDefinition {name: 'isInfrastructure', tenant_id: 'system'})-[:BELONGS_TO]->(t)
      ON CREATE SET f.id = randomUUID(), f.label = 'Infrastructure', f.field_type = 'boolean', f.required = false,
        f.default_value = null, f.enum_values = null, f.order = 9, f.scope = 'base', f.is_system = true,
        f.validation_script = null, f.visibility_script = null, f.default_script = null, f.created_at = toString(datetime())
      MERGE (t)-[:HAS_FIELD]->(f)
      RETURN count(f) AS n
    `)
    console.log(`[${ciIsInfrastructureField.id}] base field present: ${String(res.records[0]?.get('n') ?? 0)}`)
  },
}
