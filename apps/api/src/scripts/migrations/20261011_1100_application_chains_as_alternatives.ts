/**
 * FOUR TREES, FOUR ALTERNATIVES (owner, 24 Sep 2026): «un'applicazione o può
 * avere un server o può avere un database» — «oggi da application partono
 * quattro rami e quindi da business application partiranno quattro alberi»,
 * «sono quattro alternative». A CI is fine when it satisfies one of the chains
 * that ask something of it (cmdbChains/evaluate.ts).
 *
 * «Application services» (20261011_1080, 1090) put the four branches under
 * one application, the server the only one required: a server-less
 * application on a database was incomplete, and making the server optional
 * would have let an application stand alone. It becomes four chains, each
 * from the business application, each with its branch required:
 *  - «Applications on servers»: Application → Hosted on → Server;
 *  - «Applications on databases»: Application → Database → Instance → Server;
 *  - «Applications with certificates»: Application → Uses certificate →
 *    Certificate → Installed on → Server;
 *  - «Applications depending on applications»: Application → Depends on →
 *    Application.
 * The certificates stay where they were: on a server alone, used by an
 * instance and installed on a server.
 *
 * Only where «Application services» is still the starting chain: one the
 * tenant redrew is theirs, and stays. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CMDB_STARTING_CHAINS_NOW } from './20261011_1090_certificates_on_servers.js'

interface Node { id: string; parentId: string | null; ciType: string; relationType: string | null; direction: 'outgoing' | 'incoming' | null; required: boolean }

const root = (id: string, ciType: string): Node => ({ id, parentId: null, ciType, relationType: null, direction: null, required: true })
const link = (id: string, parentId: string, ciType: string, relationType: string, direction: 'outgoing' | 'incoming', required: boolean): Node =>
  ({ id, parentId, ciType, relationType, direction, required })
const application = [root('ba', 'business_application'), link('app', 'ba', 'application', 'REALIZES', 'outgoing', true)]

export const APPLICATION_ALTERNATIVES: ReadonlyArray<{ name: string; kind: string; nodes: Node[] }> = [
  {
    name: 'Applications on servers', kind: 'application',
    nodes: [
      ...application,
      link('app-server', 'app', 'server', 'HOSTED_ON', 'outgoing', true),
      link('app-server-cert', 'app-server', 'certificate', 'INSTALLED_ON', 'incoming', false),
    ],
  },
  {
    name: 'Applications on databases', kind: 'application',
    nodes: [
      ...application,
      link('app-db', 'app', 'database', 'DEPENDS_ON', 'outgoing', true),
      link('db-instance', 'app-db', 'database_instance', 'DEPENDS_ON', 'outgoing', true),
      link('instance-server', 'db-instance', 'server', 'HOSTED_ON', 'outgoing', true),
      link('instance-server-cert', 'instance-server', 'certificate', 'INSTALLED_ON', 'incoming', false),
      link('instance-cert', 'db-instance', 'certificate', 'USES_CERTIFICATE', 'outgoing', false),
      link('instance-cert-server', 'instance-cert', 'server', 'INSTALLED_ON', 'outgoing', true),
    ],
  },
  {
    name: 'Applications with certificates', kind: 'application',
    nodes: [
      ...application,
      link('app-cert', 'app', 'certificate', 'USES_CERTIFICATE', 'outgoing', true),
      link('app-cert-server', 'app-cert', 'server', 'INSTALLED_ON', 'outgoing', true),
    ],
  },
  {
    name: 'Applications depending on applications', kind: 'application',
    nodes: [...application, link('app-app', 'app', 'application', 'DEPENDS_ON', 'outgoing', true)],
  },
]

const STARTING = JSON.stringify(CMDB_STARTING_CHAINS_NOW.find((c) => c.name === 'Application services')!.nodes)

/** The starting chains as they stand after this migration. */
export const CMDB_STARTING_CHAINS_1100: ReadonlyArray<{ name: string; kind: string; nodes: Node[] }> = [
  ...APPLICATION_ALTERNATIVES,
  ...CMDB_STARTING_CHAINS_NOW.filter((c) => c.name !== 'Application services'),
]

export const applicationChainsAsAlternatives: Migration = {
  id: '20261011_1100_application_chains_as_alternatives',
  description: 'CMDB chains: «Application services» becomes four alternative chains from the business application (servers, databases, certificates, applications)',
  async up(session) {
    const res = await session.run(`
      MATCH (c:CMDBChain {name_key: 'application services'})
      RETURN c.id AS id, c.tenant_id AS tenantId, c.nodes_json AS nodes`)
    let split = 0
    for (const r of res.records) {
      const tenantId = r.get('tenantId') as string
      if (r.get('nodes') !== STARTING) {
        console.log(`[${applicationChainsAsAlternatives.id}] ${tenantId}: «Application services» was redrawn by the tenant, left as it is`)
        continue
      }
      await session.run(`
        MATCH (c:CMDBChain {id: $id, tenant_id: $tenantId})
        DETACH DELETE c
        WITH 1 AS done
        UNWIND $chains AS chain
        MERGE (n:CMDBChain {tenant_id: $tenantId, name_key: toLower(chain.name)})
        ON CREATE SET n.id = randomUUID(), n.name = chain.name, n.kind = chain.kind, n.nodes_json = chain.nodes,
          n.created_at = toString(datetime()), n.updated_at = toString(datetime()), n.created_by = 'migration', n.updated_by = 'migration'`,
      { id: r.get('id'), tenantId, chains: APPLICATION_ALTERNATIVES.map((c) => ({ name: c.name, kind: c.kind, nodes: JSON.stringify(c.nodes) })) })
      split++
    }
    console.log(`[${applicationChainsAsAlternatives.id}] «Application services» split into four alternatives: ${String(split)} of ${String(res.records.length)} tenant(s)`)
  },
}
