/**
 * NO EDGE JOINS TWO TENANTS (review of 23 Sep 2026, architecture#7 — wave 7 · A3).
 *
 * The tenant lints check where a query STARTS: a MATCH on a tenant label must
 * name the tenant. A traversal from a scoped anchor is exempt by design —
 * `(i:Incident {tenant_id: $t})-[:AFFECTS]->(ci)` does not ask `ci` for its
 * tenant — and that is sound only while no edge joins two different tenants.
 * Nothing checked it. This does: it counts the edges whose two ends carry
 * different tenants, neither of them the shared `system` one (the shipped
 * metamodel: its CI types point to tenants' assessment questions on purpose).
 *
 * On 24 Sep 2026 the live graph had none, over 4.98 million relationships,
 * in about 3 s. It runs from the platform console (rest/platform-integrity.ts)
 * and, in C2, against the CI's Neo4j (scripts/check-cross-tenant-edges.ts).
 */
import type { Session } from 'neo4j-driver'
import { MAINTENANCE_SCOPE, runInQueryScope, runQuery } from '@opengraphity/neo4j'

export interface CrossTenantEdgeGroup {
  fromTenant: string
  toTenant:   string
  type:       string
  fromLabels: string[]
  toLabels:   string[]
  count:      number
}

/** How many groups (tenants × type × labels) are returned at most: the total is counted apart. */
export const CROSS_TENANT_GROUPS_SHOWN = 100

export const CROSS_TENANT_EDGES_CYPHER = `
  // tenant-ok(piattaforma): the check crosses every tenant by definition, and returns tenant ids and names of labels, never a node's data
  MATCH (a)-[r]->(b)
  WHERE a.tenant_id IS NOT NULL AND b.tenant_id IS NOT NULL AND a.tenant_id <> b.tenant_id
    AND a.tenant_id <> 'system' AND b.tenant_id <> 'system'
  RETURN a.tenant_id AS fromTenant, b.tenant_id AS toTenant, type(r) AS type,
         labels(a) AS fromLabels, labels(b) AS toLabels, count(*) AS count
  ORDER BY count DESC, fromTenant, toTenant, type`

/**
 * The edges between different tenants, grouped. A scan of every relationship:
 * maintenance, not a page (queryScope.ts in @opengraphity/neo4j) — 3 s today,
 * and it grows with the graph.
 */
export async function crossTenantEdges(session: Session): Promise<{ total: number; groups: CrossTenantEdgeGroup[] }> {
  const rows = await runInQueryScope(MAINTENANCE_SCOPE, () => runQuery<CrossTenantEdgeGroup>(session, CROSS_TENANT_EDGES_CYPHER, {}))
  return {
    total:  rows.reduce((n, r) => n + Number(r.count), 0),
    groups: rows.slice(0, CROSS_TENANT_GROUPS_SHOWN).map((r) => ({ ...r, count: Number(r.count) })),
  }
}
