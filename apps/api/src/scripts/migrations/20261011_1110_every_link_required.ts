/**
 * EVERY LINK REQUIRED, A CHAIN USED WHOLE (owner, 24 Sep 2026): «in ogni
 * catena tutti i legami sono obbligatori … se sfrutto quell'albero, lo
 * sfrutto tutto, altrimenti cambio albero». What was an optional branch is
 * another chain, an alternative:
 *  - the applications: on servers; on servers with a certificate installed;
 *    on databases (instance, server); on databases with a certificate on the
 *    instance's server; on databases with a certificate the instance uses;
 *    using a certificate installed on a server; depending on applications;
 *  - the capabilities: enabled by business applications; with
 *    sub-capabilities;
 *  - the CI groups: one chain per kind of member.
 *
 * A starting chain (20261011_1100) the tenant has not changed is replaced; one
 * it redrew stays, and a new chain with its name is not created over it.
 * Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CMDB_STARTING_CHAINS_1100 } from './20261011_1100_application_chains_as_alternatives.js'

interface Node { id: string; parentId: string | null; ciType: string; relationType: string | null; direction: 'outgoing' | 'incoming' | null; required: boolean }

const root = (id: string, ciType: string): Node => ({ id, parentId: null, ciType, relationType: null, direction: null, required: true })
const link = (id: string, parentId: string, ciType: string, relationType: string, direction: 'outgoing' | 'incoming'): Node =>
  ({ id, parentId, ciType, relationType, direction, required: true })

const APP = [root('ba', 'business_application'), link('app', 'ba', 'application', 'REALIZES', 'outgoing')]
const ON_SERVER = [...APP, link('app-server', 'app', 'server', 'HOSTED_ON', 'outgoing')]
const ON_DATABASE = [...APP, link('app-db', 'app', 'database', 'DEPENDS_ON', 'outgoing'),
  link('db-instance', 'app-db', 'database_instance', 'DEPENDS_ON', 'outgoing'), link('instance-server', 'db-instance', 'server', 'HOSTED_ON', 'outgoing')]
const GROUP_MEMBERS: ReadonlyArray<[string, string]> = [
  ['application', 'applications'], ['business_application', 'business applications'], ['business_capability', 'business capabilities'],
  ['server', 'servers'], ['database', 'databases'], ['database_instance', 'database instances'], ['certificate', 'certificates'],
]

export const CMDB_STARTING_CHAINS_1110: ReadonlyArray<{ name: string; kind: string; nodes: Node[] }> = [
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
  ...GROUP_MEMBERS.map(([type, words]) => ({
    name: `Groups of ${words}`, kind: 'mixed', nodes: [root('group', 'dynamic_ci_group'), link('member', 'group', type, 'HAS_MEMBER', 'outgoing')],
  })),
]

export const everyLinkRequired: Migration = {
  id: '20261011_1110_every_link_required',
  description: 'CMDB chains: every link required, a chain used whole — the optional branches become alternative chains',
  async up(session) {
    const tenants = await session.run(`MATCH (t:Tenant) WHERE t.id IS NOT NULL RETURN t.id AS id`)
    for (const t of tenants.records) {
      const tenantId = t.get('id') as string
      let replaced = 0
      for (const old of CMDB_STARTING_CHAINS_1100) {
        const res = await session.run(`
          MATCH (c:CMDBChain {tenant_id: $tenantId, name_key: $nameKey}) WHERE c.nodes_json = $nodes
          DETACH DELETE c RETURN count(*) AS n`, { tenantId, nameKey: old.name.toLowerCase(), nodes: JSON.stringify(old.nodes) })
        replaced += Number(res.records[0]?.get('n') ?? 0)
      }
      // Only a tenant that had the starting chains gets the new ones: one with none of them drew its own.
      if (!replaced) {
        console.log(`[${everyLinkRequired.id}] ${tenantId}: no starting chain left unchanged, nothing replaced`)
        continue
      }
      await session.run(`
        UNWIND $chains AS chain
        MERGE (c:CMDBChain {tenant_id: $tenantId, name_key: toLower(chain.name)})
        ON CREATE SET c.id = randomUUID(), c.name = chain.name, c.kind = chain.kind, c.nodes_json = chain.nodes,
          c.created_at = toString(datetime()), c.updated_at = toString(datetime()), c.created_by = 'migration', c.updated_by = 'migration'`,
      { tenantId, chains: CMDB_STARTING_CHAINS_1110.map((c) => ({ name: c.name, kind: c.kind, nodes: JSON.stringify(c.nodes) })) })
      console.log(`[${everyLinkRequired.id}] ${tenantId}: ${String(replaced)} starting chains replaced by ${String(CMDB_STARTING_CHAINS_1110.length)}`)
    }
  },
}
