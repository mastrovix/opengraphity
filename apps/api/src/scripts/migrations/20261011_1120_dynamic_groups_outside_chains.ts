/**
 * DYNAMIC GROUPS ARE OUTSIDE THE CHAINS (owner, 24 Sep 2026): «un gruppo
 * dinamico per definizione rispetterà una catena perché porterà dentro altri
 * CI che devono rispettare una catena … è per definizione un aggregatore di
 * CI esistenti. Un gruppo dinamico per il momento non ha catene».
 *
 * The seven «Groups of …» chains (20261011_1110) go, where the tenant has not
 * changed them. A type no chain draws is outside the chains: its relations —
 * a group's members — follow the metamodel alone (cmdbChains/admission.ts),
 * and CMDB Health does not judge it. Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'
import { CMDB_STARTING_CHAINS_1110 } from './20261011_1110_every_link_required.js'

const GROUP_CHAINS = CMDB_STARTING_CHAINS_1110.filter((c) => c.nodes.some((n) => n.ciType === 'dynamic_ci_group'))

/** The starting chains as they stand after this migration. */
export const CMDB_STARTING_CHAINS_1120: typeof CMDB_STARTING_CHAINS_1110 = CMDB_STARTING_CHAINS_1110.filter((c) => !GROUP_CHAINS.includes(c))

export const dynamicGroupsOutsideChains: Migration = {
  id: '20261011_1120_dynamic_groups_outside_chains',
  description: 'CMDB chains: dynamic groups have no chain — the «Groups of …» starting chains go, a group\'s members follow the metamodel alone',
  async up(session) {
    let removed = 0
    for (const c of GROUP_CHAINS) {
      const res = await session.run(`
        MATCH (c:CMDBChain {name_key: $nameKey}) WHERE c.nodes_json = $nodes
        DETACH DELETE c RETURN count(*) AS n`, { nameKey: c.name.toLowerCase(), nodes: JSON.stringify(c.nodes) })
      removed += Number(res.records[0]?.get('n') ?? 0)
    }
    console.log(`[${dynamicGroupsOutsideChains.id}] group chains removed: ${String(removed)}`)
  },
}
