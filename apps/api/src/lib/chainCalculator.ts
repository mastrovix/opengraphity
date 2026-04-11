import { getSession } from '@opengraphity/neo4j'

/**
 * Calculate chain for a single CI based on chain_families of its type and upstream dependencies.
 */
export async function calculateChain(ciId: string, tenantId: string): Promise<string> {
  const session = getSession(undefined, 'WRITE')
  try {
    const result = await session.executeWrite(tx => tx.run(`
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      OPTIONAL MATCH (td:CITypeDefinition {neo4j_label: lbl})
      WITH ci, td, td.chain_families AS families
      WHERE td IS NOT NULL
      LIMIT 1
      WITH ci, CASE
        WHEN families IS NULL THEN '["Application","Infrastructure"]'
        ELSE families
      END AS rawFamilies
      WITH ci, rawFamilies
      // If only one family, use it directly
      WITH ci, rawFamilies,
        CASE WHEN rawFamilies = '["Application"]' THEN 'Application'
             WHEN rawFamilies = '["Infrastructure"]' THEN 'Infrastructure'
             ELSE null
        END AS directChain
      // If ambiguous, check upstream for Application-only types
      CALL {
        WITH ci
        OPTIONAL MATCH (upstream)-[:DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE*1..10]->(ci)
        WHERE upstream.tenant_id = ci.tenant_id
        WITH upstream, labels(upstream) AS uLabels
        UNWIND uLabels AS uLbl
        OPTIONAL MATCH (utd:CITypeDefinition {neo4j_label: uLbl})
        WHERE utd.chain_families = '["Application"]'
        RETURN count(utd) > 0 AS hasAppUpstream
      }
      SET ci.chain = CASE
        WHEN directChain IS NOT NULL THEN directChain
        WHEN hasAppUpstream THEN 'Application'
        ELSE 'Infrastructure'
      END
      RETURN ci.chain AS chain
    `, { ciId, tenantId }))
    return (result.records[0]?.get('chain') as string) ?? 'Infrastructure'
  } finally {
    await session.close()
  }
}

/**
 * Recalculate chain for ALL CIs in a tenant.
 * Uses batch approach: first set single-family types, then resolve ambiguous ones.
 */
export async function calculateAllChains(tenantId: string): Promise<{ total: number; app: number; infra: number }> {
  const session = getSession(undefined, 'WRITE')
  try {
    // Step 1: Set chain for CIs whose type has a single chain_family
    await session.executeWrite(tx => tx.run(`
      MATCH (ci {tenant_id: $tenantId})
      WHERE ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      MATCH (td:CITypeDefinition {neo4j_label: lbl})
      WHERE td.chain_families = '["Application"]'
      SET ci.chain = 'Application'
    `, { tenantId }))

    await session.executeWrite(tx => tx.run(`
      MATCH (ci {tenant_id: $tenantId})
      WHERE ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      MATCH (td:CITypeDefinition {neo4j_label: lbl})
      WHERE td.chain_families = '["Infrastructure"]'
      SET ci.chain = 'Infrastructure'
    `, { tenantId }))

    // Step 2: For CIs with multiple families, check upstream
    await session.executeWrite(tx => tx.run(`
      MATCH (ci {tenant_id: $tenantId})
      WHERE ci.chain IS NULL
        AND (ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate)
      OPTIONAL MATCH (app:Application {tenant_id: $tenantId})-[:DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE*0..10]->(ci)
      WITH ci, count(app) > 0 AS hasApp
      SET ci.chain = CASE WHEN hasApp THEN 'Application' ELSE 'Infrastructure' END
    `, { tenantId }))

    // Count results
    const r = await session.executeRead(tx => tx.run(`
      MATCH (ci {tenant_id: $tenantId})
      WHERE ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate
      RETURN count(ci) AS total,
        sum(CASE WHEN ci.chain = 'Application' THEN 1 ELSE 0 END) AS app,
        sum(CASE WHEN ci.chain = 'Infrastructure' THEN 1 ELSE 0 END) AS infra
    `, { tenantId }))

    const rec = r.records[0]
    return {
      total: Number(rec?.get('total') ?? 0),
      app: Number(rec?.get('app') ?? 0),
      infra: Number(rec?.get('infra') ?? 0),
    }
  } finally {
    await session.close()
  }
}
