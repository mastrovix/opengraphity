/**
 * CMDB CHAINS (owner, 24 Sep 2026): the chains say which relations between
 * CIs are admitted, and from now on the API refuses the others. A tenant
 * without chains would refuse every relation, so each tenant that has none
 * gets the three that admit what the shipped types are linked by today:
 *
 *  - «Application services» (application): a business application realizes
 *    applications; an application stands on servers (required), may use
 *    databases — each on an instance (required), each instance on servers
 *    (required) — may depend on other applications, and may use
 *    certificates; a certificate may be installed on a server or an instance;
 *  - «Business capabilities» (application): a capability may have child
 *    capabilities and may be enabled by business applications;
 *  - «CI groups» (mixed): a group may have CIs of every shipped type as
 *    members.
 *
 * The same rules the owner gave for the demo (a certificate is an
 * application's, an instance's or a server's alone — never a database's).
 * Written here, not imported: a migration keeps doing what it did the day it
 * was written. A tenant that already has a chain is left alone. Plus the
 * uniqueness of a chain's name in its tenant, case aside. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'

interface Node { id: string; parentId: string | null; ciType: string; relationType: string | null; direction: 'outgoing' | 'incoming' | null; required: boolean }

const root = (id: string, ciType: string): Node => ({ id, parentId: null, ciType, relationType: null, direction: null, required: true })
const link = (id: string, parentId: string, ciType: string, relationType: string, direction: 'outgoing' | 'incoming', required: boolean): Node =>
  ({ id, parentId, ciType, relationType, direction, required })

export const CMDB_STARTING_CHAINS: ReadonlyArray<{ name: string; kind: string; nodes: Node[] }> = [
  {
    name: 'Application services', kind: 'application',
    nodes: [
      root('ba', 'business_application'),
      link('app', 'ba', 'application', 'REALIZES', 'outgoing', true),
      link('app-server', 'app', 'server', 'HOSTED_ON', 'outgoing', true),
      link('app-server-cert', 'app-server', 'certificate', 'INSTALLED_ON', 'incoming', false),
      link('app-db', 'app', 'database', 'DEPENDS_ON', 'outgoing', false),
      link('db-instance', 'app-db', 'database_instance', 'DEPENDS_ON', 'outgoing', true),
      link('instance-cert', 'db-instance', 'certificate', 'INSTALLED_ON', 'incoming', false),
      link('instance-server', 'db-instance', 'server', 'HOSTED_ON', 'outgoing', true),
      link('instance-server-cert', 'instance-server', 'certificate', 'INSTALLED_ON', 'incoming', false),
      link('app-cert', 'app', 'certificate', 'USES_CERTIFICATE', 'outgoing', false),
      link('app-app', 'app', 'application', 'DEPENDS_ON', 'outgoing', false),
    ],
  },
  {
    name: 'Business capabilities', kind: 'application',
    nodes: [
      root('bc', 'business_capability'),
      link('bc-child', 'bc', 'business_capability', 'PARENT_OF', 'outgoing', false),
      link('bc-ba', 'bc', 'business_application', 'ENABLED_BY', 'outgoing', false),
    ],
  },
  {
    name: 'CI groups', kind: 'mixed',
    nodes: [
      root('group', 'dynamic_ci_group'),
      ...['application', 'business_application', 'business_capability', 'server', 'database', 'database_instance', 'certificate']
        .map((t) => link(`member-${t}`, 'group', t, 'HAS_MEMBER', 'outgoing', false)),
    ],
  },
]

export const cmdbChains: Migration = {
  id: '20261011_1080_cmdb_chains',
  description: 'CMDB chains: the relations between CIs each tenant admits — the three starting chains for every tenant without one, and a chain name unique per tenant',
  async up(session) {
    await session.run('CREATE CONSTRAINT cmdb_chain_name_unique IF NOT EXISTS FOR (c:CMDBChain) REQUIRE (c.tenant_id, c.name_key) IS UNIQUE')
    const res = await session.run(`
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL AND NOT EXISTS { MATCH (:CMDBChain {tenant_id: t.id}) }
      UNWIND $chains AS chain
      CREATE (c:CMDBChain {id: randomUUID(), tenant_id: t.id, name: chain.name, name_key: toLower(chain.name), kind: chain.kind,
        nodes_json: chain.nodes, created_at: toString(datetime()), updated_at: toString(datetime()),
        created_by: 'migration', updated_by: 'migration'})
      RETURN count(DISTINCT t) AS tenants, count(c) AS chains
    `, { chains: CMDB_STARTING_CHAINS.map((c) => ({ name: c.name, kind: c.kind, nodes: JSON.stringify(c.nodes) })) })
    const row = res.records[0]
    console.log(`[${cmdbChains.id}] starting chains written: ${String(row?.get('chains') ?? 0)} for ${String(row?.get('tenants') ?? 0)} tenant(s)`)
  },
  // The constraint does not run in the marker's transaction: Neo4j refuses it.
  autocommit: true,
}
