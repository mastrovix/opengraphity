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
 * have relabelled it from the CI type designer. On a stack whose metamodel
 * was never seeded it does nothing: the seed brings these declarations.
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
    /*
     * A NEW STACK (wave 7 · C2, found by the first run on an empty database):
     * the migrations run before `seed:metamodel` (docs/DEPLOY.md: `neo4j:init`,
     * then the tenant, then the metamodel), and `seed:metamodel` declares these
     * four relations with the rest. With no shipped type at all there is
     * nothing to complete; a metamodel that exists without one of the types is
     * still an error, below.
     */
    const shipped = await session.run(`MATCH (t:CITypeDefinition {tenant_id: 'system'}) RETURN count(t) AS n`, {})
    if (Number(shipped.records[0]?.get('n') ?? 0) === 0) {
      console.log(`[${certificatesOnDatabases.id}] no shipped metamodel on this stack yet: seed:metamodel declares these relations with it`)
      return
    }
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
