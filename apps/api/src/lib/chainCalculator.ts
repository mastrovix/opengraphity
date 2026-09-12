import { getSession } from '@opengraphity/neo4j'

/**
 * Famiglie di catena ammesse su `CITypeDefinition.chain_families` — fonte
 * unica (B0-1). Non è un vocabolario di dominio rinominabile dal cliente: è
 * la dicotomia strutturale su cui la Cypher qui sotto confronta le stringhe
 * (`'["Application"]'`) e su cui il campo base `chain` è costruito. Un valore
 * fuori da qui viene rifiutato dalla mutation, non normalizzato in silenzio.
 */
export const CHAIN_FAMILIES = ['Application', 'Infrastructure'] as const
export type ChainFamily = (typeof CHAIN_FAMILIES)[number]

/**
 * Normalizza una lista di famiglie in JSON canonico per `chain_families`:
 * ordine di CHAIN_FAMILIES, senza doppioni. L'ordine conta perché la Cypher
 * di calcolo confronta la stringa JSON per intero.
 */
export function chainFamiliesToJSON(families: readonly string[]): string {
  const set = new Set(families)
  return JSON.stringify(CHAIN_FAMILIES.filter((f) => set.has(f)))
}

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
      // tenant-ok: tipo CI condiviso per label
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
        // tenant-ok: tipo CI condiviso per label
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
 *
 * Il perimetro è `:ConfigurationItem`, non un elenco di cinque etichette
 * (ondata 6, A-9): la catena è un campo **base** di ogni CI e la vogliono i
 * widget «per catena» e l'analisi d'impatto. Con l'elenco fisso, i CI dei tipi
 * creati dal cliente (e anche i `BusinessApplication`, `BusinessCapability`,
 * `DynamicCIGroup` spediti col prodotto) restavano con `chain` nulla, quindi
 * fuori da ogni conteggio, in silenzio — e il `total` riportato dal ricalcolo
 * ne nascondeva l'assenza perché contava con lo stesso filtro. Qui non serve
 * il predicato per tenant: la domanda è «è un CI?», e ogni CI porta
 * `:ConfigurationItem` (migrazione `20260908_1010`, dal vivo 2049 su 2049);
 * inoltre il tipo viene comunque risolto riga per riga contro
 * `CITypeDefinition`, che è la stessa sorgente del metamodello.
 */
export async function calculateAllChains(tenantId: string): Promise<{ total: number; app: number; infra: number }> {
  const session = getSession(undefined, 'WRITE')
  try {
    // Step 1: Set chain for CIs whose type has a single chain_family
    await session.executeWrite(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      // tenant-ok: tipo CI condiviso per label
      MATCH (td:CITypeDefinition {neo4j_label: lbl})
      WHERE td.chain_families = '["Application"]'
      SET ci.chain = 'Application'
    `, { tenantId }))

    await session.executeWrite(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      // tenant-ok: tipo CI condiviso per label
      MATCH (td:CITypeDefinition {neo4j_label: lbl})
      WHERE td.chain_families = '["Infrastructure"]'
      SET ci.chain = 'Infrastructure'
    `, { tenantId }))

    // Step 2: For CIs with multiple families, check upstream
    await session.executeWrite(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE ci.chain IS NULL
      OPTIONAL MATCH (app:Application {tenant_id: $tenantId})-[:DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE*0..10]->(ci)
      WITH ci, count(app) > 0 AS hasApp
      SET ci.chain = CASE WHEN hasApp THEN 'Application' ELSE 'Infrastructure' END
    `, { tenantId }))

    // Count results
    const r = await session.executeRead(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
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
