/**
 * THE PLATFORM TYPE, AND OPENGRAFO AS A CI OF EVERY TENANT (26 Sep 2026).
 *
 * The owner, trying the operational remedies: a Problem opened on a remedy
 * that did not hold had no CI and no team, and the notification to the
 * owning team failed. «devi comunque creare un CI "Opengrafo"», a SYSTEM CI of
 * a new shipped type, Platform, with both chain families («così si può usare
 * per altri componenti»), owned by the administrators' team.
 *
 *  1. The shipped type `platform` (`tenant_id: 'system'`, `scope: 'base'`),
 *     as `seed-metamodel.ts` declares it for a new stack. Created only where
 *     missing: a type that exists is left as an administrator may have
 *     changed it. On a stack whose metamodel was never seeded (no `__base__`)
 *     this part does nothing — the seed brings the type.
 *  2. In every tenant, the team «OpenGrafo Administrators» (born with the
 *     users who have the admin role) and the CI «OpenGrafo» it owns
 *     (lib/opengrafoSystemCI.ts, the same function new tenants are provisioned
 *     with).
 *
 * Idempotent: both parts create only what is missing.
 */
import type { Migration } from '@opengraphity/neo4j'
import { ensureOpenGrafoSystemCI } from '../../lib/opengrafoSystemCI.js'

/** The type as shipped on 26 Sep 2026 — frozen here, as a migration is. */
const PLATFORM = {
  name: 'platform', label: 'Platform', icon: 'network', color: '#be185d', neo4jLabel: 'Platform',
  chainFamilies: '["Application","Infrastructure"]', serviceRole: 'component',
  relations: [
    { name: 'dependencies', label: 'Dependencies',     relType: 'DEPENDS_ON',       targetType: 'any',         direction: 'outgoing', order: 1, description: 'CIs this platform depends on' },
    { name: 'dependents',   label: 'Dependents',       relType: 'DEPENDS_ON',       targetType: 'any',         direction: 'incoming', order: 2, description: 'CIs that depend on this platform' },
    { name: 'hostedOn',     label: 'Hosted On',        relType: 'HOSTED_ON',        targetType: 'Server',      direction: 'outgoing', order: 3, description: 'Servers this platform runs on' },
    { name: 'certificates', label: 'Uses Certificate', relType: 'USES_CERTIFICATE', targetType: 'Certificate', direction: 'outgoing', order: 4, description: 'TLS certificates this platform uses' },
  ],
  systemRels: [
    { name: 'ownerGroup',   label: 'Owner Group',   relType: 'OWNED_BY',     required: true,  order: 1 },
    { name: 'supportGroup', label: 'Support Group', relType: 'SUPPORTED_BY', required: false, order: 2 },
  ],
} as const

export const platformTypeAndOpenGrafoCI: Migration = {
  id: '20261012_1010_platform_type_and_opengrafo_ci',
  description: 'The shipped CI type Platform; in every tenant the team OpenGrafo Administrators and the system CI OpenGrafo it owns',
  async up(session) {
    const now = new Date().toISOString()

    // ── 1. The type ─────────────────────────────────────────────────────────
    const created = await session.run(`
      MATCH (base:CITypeDefinition {name: '__base__', tenant_id: 'system'})
      // A type with this name or label anywhere — shipped, or an organization's own — is left alone.
      OPTIONAL MATCH (old:CITypeDefinition) WHERE old.name = $name OR old.neo4j_label = $neo4jLabel
      WITH base, count(old) = 0 AS missing
      WHERE missing
      // The statuses the other shipped types exclude (a certificate's own): the same list as Application's.
      OPTIONAL MATCH (app:CITypeDefinition {name: 'application', tenant_id: 'system'})
      CREATE (t:CITypeDefinition {
        id: randomUUID(), name: $name, tenant_id: 'system', label: $label, icon: $icon, color: $color,
        scope: 'base', neo4j_label: $neo4jLabel, active: true, validation_script: null,
        chain_families: $chainFamilies, status_excluded: app.status_excluded, service_role: $serviceRole, created_at: $now
      })
      CREATE (t)-[:EXTENDS]->(base)
      RETURN t.id AS id
    `, {
      name: PLATFORM.name, label: PLATFORM.label, icon: PLATFORM.icon, color: PLATFORM.color, neo4jLabel: PLATFORM.neo4jLabel,
      chainFamilies: PLATFORM.chainFamilies, serviceRole: PLATFORM.serviceRole, now,
    })
    if (created.records.length > 0) {
      await session.run(`
        MATCH (t:CITypeDefinition {name: $name, tenant_id: 'system'})
        UNWIND $relations AS r
          CREATE (d:CIRelationDefinition {
            id: randomUUID(), name: r.name, tenant_id: 'system', label: r.label, relationship_type: r.relType,
            target_type: r.targetType, cardinality: 'many', direction: r.direction, order: r.order,
            description: r.description, scope: 'base', created_at: $now
          })-[:BELONGS_TO]->(t)
          CREATE (t)-[:HAS_RELATION]->(d)
      `, { name: PLATFORM.name, relations: PLATFORM.relations.map((r) => ({ ...r })), now })
      await session.run(`
        MATCH (t:CITypeDefinition {name: $name, tenant_id: 'system'})
        UNWIND $systemRels AS s
          CREATE (d:CISystemRelationDefinition {
            id: randomUUID(), name: s.name, tenant_id: 'system', label: s.label, relationship_type: s.relType,
            target_entity: 'Team', required: s.required, order: s.order, scope: 'base', created_at: $now
          })-[:BELONGS_TO]->(t)
          CREATE (t)-[:HAS_SYSTEM_RELATION]->(d)
      `, { name: PLATFORM.name, systemRels: PLATFORM.systemRels.map((s) => ({ ...s })), now })
      console.log(`[${platformTypeAndOpenGrafoCI.id}] shipped CI type Platform created`)
    }

    // ── 2. The OpenGrafo CI and its team, in every tenant ───────────────────
    const tenants = await session.run('MATCH (t:Tenant) RETURN t.id AS id ORDER BY id')
    for (const rec of tenants.records) {
      const tenantId = rec.get('id') as string
      const r = await ensureOpenGrafoSystemCI(session, tenantId, now)
      if (r.teamCreated || r.ciCreated) {
        console.log(`[${platformTypeAndOpenGrafoCI.id}] ${tenantId}: ${r.ciCreated ? 'CI OpenGrafo created' : 'CI already there'}; ${r.teamCreated ? `team created with ${String(r.members)} administrator(s)` : 'team already there'}`)
      }
    }
  },
}
