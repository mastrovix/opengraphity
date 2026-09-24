/**
 * THE STARTING CMDB CHAINS a tenant is born with (owner, 24 Sep 2026): the
 * chains say which relations between CIs are admitted, and without any the
 * relations follow the metamodel alone. The existing tenants got them from migrations
 * 20261011_1080 to 1120; a new one gets them here, from provisioning — the
 * two must agree, and a test says so (a change here needs a migration for the
 * tenants that already exist).
 *
 * Every link is required and a chain is used whole — «se sfrutto
 * quell'albero, lo sfrutto tutto, altrimenti cambio albero»: what is optional
 * is another chain, an alternative. A CI is fine when, where the chains place
 * it, one of them is followed whole. Dynamic groups have no chain: «un
 * aggregatore di CI esistenti» that «per il momento non ha catene».
 */
import type { Queryable } from '@opengraphity/neo4j'

interface StartingNode { id: string; parentId: string | null; ciType: string; relationType: string | null; direction: 'outgoing' | 'incoming' | null; required: boolean }

const root = (id: string, ciType: string): StartingNode => ({ id, parentId: null, ciType, relationType: null, direction: null, required: true })
const link = (id: string, parentId: string, ciType: string, relationType: string, direction: 'outgoing' | 'incoming'): StartingNode =>
  ({ id, parentId, ciType, relationType, direction, required: true })

const APP = [root('ba', 'business_application'), link('app', 'ba', 'application', 'REALIZES', 'outgoing')]
const ON_SERVER = [...APP, link('app-server', 'app', 'server', 'HOSTED_ON', 'outgoing')]
const ON_DATABASE = [...APP, link('app-db', 'app', 'database', 'DEPENDS_ON', 'outgoing'),
  link('db-instance', 'app-db', 'database_instance', 'DEPENDS_ON', 'outgoing'), link('instance-server', 'db-instance', 'server', 'HOSTED_ON', 'outgoing')]

export const STARTING_CHAINS: ReadonlyArray<{ name: string; kind: string; nodes: StartingNode[] }> = [
  { name: 'Applications on servers', kind: 'application', nodes: ON_SERVER },
  { name: 'Applications on servers with certificates', kind: 'application',
    nodes: [...ON_SERVER, link('app-server-cert', 'app-server', 'certificate', 'INSTALLED_ON', 'incoming')] },
  { name: 'Applications on databases', kind: 'application', nodes: ON_DATABASE },
  { name: 'Applications on databases, certificate on the server', kind: 'application',
    nodes: [...ON_DATABASE, link('instance-server-cert', 'instance-server', 'certificate', 'INSTALLED_ON', 'incoming')] },
  { name: 'Applications on databases, certificate of the instance', kind: 'application',
    nodes: [...ON_DATABASE, link('instance-cert', 'db-instance', 'certificate', 'USES_CERTIFICATE', 'outgoing'), link('instance-cert-server', 'instance-cert', 'server', 'INSTALLED_ON', 'outgoing')] },
  { name: 'Applications with certificates', kind: 'application',
    nodes: [...APP, link('app-cert', 'app', 'certificate', 'USES_CERTIFICATE', 'outgoing'), link('app-cert-server', 'app-cert', 'server', 'INSTALLED_ON', 'outgoing')] },
  { name: 'Applications depending on applications', kind: 'application', nodes: [...APP, link('app-app', 'app', 'application', 'DEPENDS_ON', 'outgoing')] },
  { name: 'Capabilities enabled by business applications', kind: 'application',
    nodes: [root('bc', 'business_capability'), link('bc-ba', 'bc', 'business_application', 'ENABLED_BY', 'outgoing')] },
  { name: 'Capabilities with sub-capabilities', kind: 'application',
    nodes: [root('bc', 'business_capability'), link('bc-child', 'bc', 'business_capability', 'PARENT_OF', 'outgoing')] },
]

/** The starting chains for a tenant that has none; one that has any keeps its own. Returns how many were written. */
export async function seedStartingChains(session: Queryable, tenantId: string): Promise<number> {
  const res = await session.run(`
    MATCH (t:Tenant {id: $tenantId})
    WHERE NOT EXISTS { MATCH (:CMDBChain {tenant_id: $tenantId}) }
    UNWIND $chains AS chain
    CREATE (c:CMDBChain {id: randomUUID(), tenant_id: $tenantId, name: chain.name, name_key: toLower(chain.name), kind: chain.kind,
      nodes_json: chain.nodes, created_at: toString(datetime()), updated_at: toString(datetime()),
      created_by: 'provisioning', updated_by: 'provisioning'})
    RETURN count(c) AS n`,
  { tenantId, chains: STARTING_CHAINS.map((c) => ({ name: c.name, kind: c.kind, nodes: JSON.stringify(c.nodes) })) })
  return Number(res.records[0]?.get('n') ?? 0)
}

/** How many CMDB chains the tenant has drawn: none means every relation between CIs is refused. */
export async function cmdbChainCount(session: Queryable, tenantId: string): Promise<number> {
  const res = await session.run(`MATCH (c:CMDBChain {tenant_id: $tenantId}) RETURN count(c) AS n`, { tenantId })
  return Number(res.records[0]?.get('n') ?? 0)
}
