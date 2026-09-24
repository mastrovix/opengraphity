/**
 * Fails when an edge joins two different tenants (wave 7 · A3,
 * lib/crossTenantEdges.ts). For the CI against a real Neo4j (C2) and for an
 * operator: it only reads.
 *
 *   pnpm --filter @opengraphity/api check:cross-tenant-edges
 */
import { getSession } from '@opengraphity/neo4j'
import { runScript } from './lib/runScript.js'
import { crossTenantEdges } from '../lib/crossTenantEdges.js'

runScript('check-cross-tenant-edges', async () => {
  const session = getSession(undefined, 'READ')
  try {
    const { total, groups } = await crossTenantEdges(session)
    if (total === 0) {
      console.log('✓ no relationship between different tenants')
      return
    }
    for (const g of groups) {
      console.error(`  ${g.fromTenant} ${g.fromLabels.join(':')} -[:${g.type}]-> ${g.toLabels.join(':')} ${g.toTenant}: ${String(g.count)}`)
    }
    throw new Error(`${String(total)} relationship(s) join two different tenants`)
  } finally {
    await session.close()
  }
})
