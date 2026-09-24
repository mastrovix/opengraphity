/**
 * A business capability has no Support Group (owner, 24 Sep 2026: «Non
 * dovrebbe nemmeno esserci il campo»). A capability is what the business
 * does; no team supports it — incidents go to the applications and the
 * infrastructure that enable it, and those have their Support Group.
 *
 * The shipped type stops declaring the `supportGroup` system relation, so the
 * field disappears from its form and detail and the API refuses it
 * (lib/ciGroups.ts · assertGroupDeclared); and a capability that still has a
 * Support Group loses it — it would route incidents to a team the type says
 * does not exist. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

export const businessCapabilityNoSupportGroup: Migration = {
  id: '20261011_1060_business_capability_no_support_group',
  description: 'Business capabilities have no Support Group: the shipped type no longer declares it, and existing ones are removed',
  async up(session) {
    const declared = await session.run(`
      MATCH (t:CITypeDefinition {name: 'business_capability', tenant_id: 'system'})-[:HAS_SYSTEM_RELATION]->(sr:CISystemRelationDefinition {name: 'supportGroup'})
      WHERE t.scope = 'base'
      DETACH DELETE sr
      RETURN count(sr) AS n
    `)
    const edges = await session.run(`
      MATCH (c:BusinessCapability)-[r:SUPPORTED_BY]->(:Team)
      WITH c.tenant_id AS tenantId, r
      DELETE r
      RETURN tenantId, count(*) AS n
    `)
    console.log(`[${businessCapabilityNoSupportGroup.id}] declarations removed: ${String(declared.records[0]?.get('n') ?? 0)}`)
    for (const rec of edges.records) {
      console.log(`[${businessCapabilityNoSupportGroup.id}] ${String(rec.get('tenantId'))}: Support Group removed from ${String(rec.get('n'))} capabilities`)
    }
  },
}
