/**
 * A CERTIFICATE IS INSTALLED ON A SERVER (owner, 24 Sep 2026):
 *  - «se un'applicazione usa un certificato, allora il certificato deve essere
 *    per forza relazionato con un server»;
 *  - «un'istanza usa un certificato che è installato su un server» — the
 *    instance USES the certificate, as an application does; it is no longer
 *    installed on the instance.
 *
 * Two things, on every tenant:
 *  1. the metamodel: a database instance may use a certificate
 *     (DatabaseInstance)-[:USES_CERTIFICATE]->(Certificate), declared on both
 *     ends as the shipped relations are (`seed-metamodel.ts` declares them too
 *     for a new stack);
 *  2. the starting chain «Application services» (20261011_1080): below the
 *     certificate an application uses, Installed on → Server, required; below
 *     the instance, Uses certificate → Certificate → Installed on → Server
 *     (required) instead of the certificate installed on the instance.
 *
 * The chain is changed only where it still has the starting nodes: a chain
 * the tenant redrew is theirs. A declaration that exists is left as it is (an
 * administrator may have relabelled it). Idempotent.
 */
import { v4 as uuidv4 } from 'uuid'
import type { Migration } from '@opengraphity/neo4j'
import { CMDB_STARTING_CHAINS } from './20261011_1080_cmdb_chains.js'

interface Node { id: string; parentId: string | null; ciType: string; relationType: string | null; direction: 'outgoing' | 'incoming' | null; required: boolean }

export const INSTANCE_CERTIFICATE_RELATIONS = [
  { typeName: 'database_instance', name: 'usesCertificates', label: 'Uses Certificate', relationshipType: 'USES_CERTIFICATE',
    targetType: 'Certificate', direction: 'outgoing', order: 5, description: 'TLS certificates this database instance uses' },
  { typeName: 'certificate', name: 'usedByInstances', label: 'Used By Instances', relationshipType: 'USES_CERTIFICATE',
    targetType: 'DatabaseInstance', direction: 'incoming', order: 5, description: 'Database instances that use this certificate' },
] as const

const serverBelow = (id: string, parentId: string): Node =>
  ({ id, parentId, ciType: 'server', relationType: 'INSTALLED_ON', direction: 'outgoing', required: true })

/** «Application services» with its certificates on servers; any other chain, or one redrawn, as it is. */
export function withCertificatesOnServers<T extends Node>(nodes: readonly T[]): Node[] {
  let out: Node[] = [...nodes]
  const has = (id: string) => out.some((n) => n.id === id)
  if (has('app-cert') && !has('app-cert-server')) out.push(serverBelow('app-cert-server', 'app-cert'))
  const installed = out.find((n) => n.id === 'instance-cert' && n.parentId === 'db-instance' && n.relationType === 'INSTALLED_ON' && n.direction === 'incoming')
  if (installed) {
    out = out.map((n) => (n === installed ? { ...n, relationType: 'USES_CERTIFICATE', direction: 'outgoing' as const } : n))
    if (!has('instance-cert-server')) out.push(serverBelow('instance-cert-server', 'instance-cert'))
  }
  return out
}

/** The starting chains as they stand after this migration. */
export const CMDB_STARTING_CHAINS_NOW: ReadonlyArray<{ name: string; kind: string; nodes: Node[] }> =
  CMDB_STARTING_CHAINS.map((c) => ({ ...c, nodes: c.name === 'Application services' ? withCertificatesOnServers(c.nodes) : [...c.nodes] }))

export const certificatesOnServers: Migration = {
  id: '20261011_1090_certificates_on_servers',
  description: 'Certificates on servers: a database instance may use a certificate, and «Application services» requires a server below every certificate',
  async up(session) {
    const shipped = await session.run(`MATCH (t:CITypeDefinition {tenant_id: 'system'}) RETURN count(t) AS n`, {})
    if (Number(shipped.records[0]?.get('n') ?? 0) > 0) {
      for (const r of INSTANCE_CERTIFICATE_RELATIONS) {
        const result = await session.run(`
          MATCH (t:CITypeDefinition {name: $typeName, tenant_id: 'system'})
          MERGE (r:CIRelationDefinition {name: $name, tenant_id: 'system'})-[:BELONGS_TO]->(t)
          ON CREATE SET r.id = $id, r.label = $label, r.relationship_type = $relationshipType, r.target_type = $targetType,
            r.cardinality = 'many', r.direction = $direction, r.order = $order, r.description = $description, r.scope = 'base', r.created_at = $now
          WITH t, r
          MERGE (t)-[:HAS_RELATION]->(r)
          RETURN r.id AS id`, { ...r, id: uuidv4(), now: new Date().toISOString() })
        if (!result.records.length) throw new Error(`[${certificatesOnServers.id}] CI type "${r.typeName}" not found on tenant "system": run seed:metamodel first`)
      }
    } else {
      console.log(`[${certificatesOnServers.id}] no shipped metamodel on this stack yet: seed:metamodel declares the instance's certificates with it`)
    }
    const res = await session.run(`
      MATCH (c:CMDBChain {name_key: 'application services'})
      RETURN c.id AS id, c.tenant_id AS tenantId, c.nodes_json AS nodes`)
    let changed = 0
    for (const r of res.records) {
      const nodes = JSON.parse(r.get('nodes') as string) as Node[]
      const next = withCertificatesOnServers(nodes)
      if (JSON.stringify(next) === JSON.stringify(nodes)) continue
      await session.run(`
        MATCH (c:CMDBChain {id: $id, tenant_id: $tenantId})
        SET c.nodes_json = $nodes, c.updated_at = toString(datetime()), c.updated_by = 'migration'`,
      { id: r.get('id'), tenantId: r.get('tenantId'), nodes: JSON.stringify(next) })
      changed++
    }
    console.log(`[${certificatesOnServers.id}] chains given their certificates' servers: ${String(changed)} of ${String(res.records.length)}`)
  },
}
