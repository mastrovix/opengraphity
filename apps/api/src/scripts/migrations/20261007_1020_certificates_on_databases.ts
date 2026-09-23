/**
 * CERTIFICATES ON DATABASES AND DATABASE INSTANCES (23 Sep 2026).
 *
 * A TLS certificate is installed on a database instance (the listener that
 * encrypts connections) and used by a database, exactly as it is installed on
 * a server and used by an application. The metamodel declared only the second
 * pair, so the app refused the first — `addCIRelationship` rejects a relation
 * no type declares — and the CI page did not show it even when it existed.
 * The owner of the product asked for it on every tenant.
 *
 * Four declarations, both ends of the two edges, in the form the shipped ones
 * have (`seed-metamodel.ts`, which declares them too for a new stack):
 *   (Certificate)-[:INSTALLED_ON]->(DatabaseInstance)
 *   (Database)-[:USES_CERTIFICATE]->(Certificate)
 *
 * Idempotent: a declaration is matched by (type, name) and only created when
 * missing; one that exists is left as it is, because an administrator may
 * have relabelled it from the CI type designer.
 */
import { v4 as uuidv4 } from 'uuid'
import type { Migration } from '@opengraphity/neo4j'

interface RelationDeclaration {
  typeName: string
  name: string
  label: string
  relationshipType: string
  targetType: string
  direction: 'outgoing' | 'incoming'
  order: number
  description: string
}

export const CERTIFICATE_DATABASE_RELATIONS: readonly RelationDeclaration[] = [
  { typeName: 'database', name: 'certificates', label: 'Uses Certificate', relationshipType: 'USES_CERTIFICATE',
    targetType: 'Certificate', direction: 'outgoing', order: 3, description: 'TLS certificates used by this database' },
  { typeName: 'database_instance', name: 'certificates', label: 'Installed Certificates', relationshipType: 'INSTALLED_ON',
    targetType: 'Certificate', direction: 'incoming', order: 4, description: 'Certificates installed on this database instance' },
  { typeName: 'certificate', name: 'installedOnInstance', label: 'Installed On Instance', relationshipType: 'INSTALLED_ON',
    targetType: 'DatabaseInstance', direction: 'outgoing', order: 3, description: 'Database instances this certificate is installed on' },
  { typeName: 'certificate', name: 'usedByDatabases', label: 'Used By Databases', relationshipType: 'USES_CERTIFICATE',
    targetType: 'Database', direction: 'incoming', order: 4, description: 'Databases that use this certificate' },
]

export const certificatesOnDatabases: Migration = {
  id: '20261007_1020_certificates_on_databases',
  description: 'Declare certificates installed on database instances and used by databases, for every tenant',

  async up(session) {
    const created: string[] = []
    for (const r of CERTIFICATE_DATABASE_RELATIONS) {
      const result = await session.run(`
        MATCH (t:CITypeDefinition {name: $typeName, tenant_id: 'system'})
        MERGE (r:CIRelationDefinition {name: $name, tenant_id: 'system'})-[:BELONGS_TO]->(t)
        ON CREATE SET
          r.id                = $id,
          r.label             = $label,
          r.relationship_type = $relationshipType,
          r.target_type       = $targetType,
          r.cardinality       = 'many',
          r.direction         = $direction,
          r.order             = $order,
          r.description       = $description,
          r.scope             = 'base',
          r.created_at        = $now
        WITH t, r
        MERGE (t)-[:HAS_RELATION]->(r)
        RETURN r.created_at = $now AS wasCreated
      `, { ...r, id: uuidv4(), now: new Date().toISOString() })
      if (result.records.length === 0) {
        // The shipped type is missing: the metamodel was never seeded on this
        // stack. Say it instead of reporting a declaration that was not made.
        throw new Error(`[${certificatesOnDatabases.id}] CI type "${r.typeName}" not found on tenant "system": run seed:metamodel first`)
      }
      if (result.records[0]!.get('wasCreated') === true) created.push(`${r.typeName}.${r.name}`)
    }
    console.log(`[${certificatesOnDatabases.id}] ${created.length ? `declared: ${created.join(', ')}` : 'already declared'}`)
  },
}
