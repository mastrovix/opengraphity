import type { Session } from 'neo4j-driver'
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
/**
 * Le relazioni lungo cui la catena si propaga: quelle dei servizi del tenant
 * (revisione del 15 set 2026 · CM-3), non `DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE`
 * scritto qui. Import dinamico: `ciMetamodelForTenant` legge `CHAIN_FAMILIES` da
 * questo modulo.
 */
async function chainRelPattern(tenantId: string): Promise<string> {
  const { serviceRelPatternForTenant } = await import('./ciMetamodelForTenant.js')
  return serviceRelPatternForTenant(tenantId)
}

/**
 * A CERTIFICATE FOLLOWS WHERE IT IS INSTALLED (owner, 24 Sep 2026).
 *
 * A certificate is used by an application (and installed on its servers), or
 * installed on a database instance, or installed on a server alone. The last
 * two have nothing above them — the instance or the server is BELOW the
 * certificate — so the rule «Application if an application reaches it» left
 * them outside every application chain even when their host runs one. Their
 * chain is now also their host's: Application when a CI they point to (along
 * the tenant's service relations) is in an application chain.
 *
 * Literal and parameterized: the relation types and the certificate labels
 * come from the tenant's metamodel, the ids are the ones just recomputed
 * (`null` = the whole tenant). Run after the hosts' own chains are set.
 * Returns the ids it moved to Application.
 */
const CERTIFICATE_HOST_CHAIN = `
  MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
  WHERE ($ids IS NULL OR ci.id IN $ids) AND any(l IN labels(ci) WHERE l IN $certificateLabels)
    AND coalesce(ci.chain, '') <> $application
    AND EXISTS { MATCH (ci)-[r]->(host:ConfigurationItem {tenant_id: $tenantId}) WHERE type(r) IN $relTypes AND host.chain = $application }
  SET ci.chain = $application
  RETURN ci.id AS id`

async function certificateContext(tenantId: string): Promise<{ certificateLabels: string[]; relTypes: string[] }> {
  const { serviceRolesForTenant, serviceRelationshipTypesForTenant } = await import('./ciMetamodelForTenant.js')
  const [roles, relTypes] = await Promise.all([serviceRolesForTenant(tenantId), serviceRelationshipTypesForTenant(tenantId)])
  return { certificateLabels: [...roles.entries()].filter(([, r]) => r === 'certificate').map(([l]) => l), relTypes: [...relTypes] }
}

async function applyCertificateHostChain(session: Session, tenantId: string, ids: readonly string[] | null): Promise<string[]> {
  const { certificateLabels, relTypes } = await certificateContext(tenantId)
  if (!certificateLabels.length) return []
  const res = await session.executeWrite((tx) => tx.run(CERTIFICATE_HOST_CHAIN, {
    tenantId, ids: ids ? [...ids] : null, certificateLabels, relTypes, application: CHAIN_FAMILIES[0],
  }))
  return res.records.map((r) => r.get('id') as string)
}

/** The certificates installed on these CIs: when a host's chain changes, theirs can too. */
async function certificatesOn(session: Session, tenantId: string, hostIds: readonly string[]): Promise<string[]> {
  const { certificateLabels, relTypes } = await certificateContext(tenantId)
  if (!certificateLabels.length || !hostIds.length) return []
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (c:ConfigurationItem {tenant_id: $tenantId})-[r]->(h:ConfigurationItem {tenant_id: $tenantId})
    WHERE h.id IN $hostIds AND type(r) IN $relTypes AND any(l IN labels(c) WHERE l IN $certificateLabels)
    RETURN collect(DISTINCT c.id) AS ids`, { tenantId, hostIds: [...hostIds], relTypes, certificateLabels }))
  return (res.records[0]?.get('ids') as string[] | undefined) ?? []
}

/**
 * The chain of each of these CIs, in ONE query (review of 23 Sep 2026: a
 * relationship change recomputes every CI downstream, not only its two ends).
 * Returns the chain per id; a CI that is not there is absent.
 */
export async function calculateChains(ciIds: readonly string[], tenantId: string): Promise<Map<string, string>> {
  if (ciIds.length === 0) return new Map()
  const relPattern = await chainRelPattern(tenantId)
  const session = getSession(undefined, 'WRITE')
  try {
    const result = await session.executeWrite(tx => tx.run(`
      UNWIND $ciIds AS ciId
      MATCH (ci:ConfigurationItem {id: ciId, tenant_id: $tenantId})
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      // La definizione del tipo si risolve come in tutto il resto del prodotto
      // (revisione totale · C-20): solo tipi ATTIVI, solo quelli base o di
      // QUESTO tenant, e il tipo del cliente vince su quello base con la
      // stessa etichetta. Prima era un LIMIT 1 su una ricerca senza tenant:
      // due organizzazioni con la stessa neo4j_label e famiglie diverse
      // davano una catena a caso.
      // tenant-ok(condivisi): i tipi base sono condivisi, quelli del cliente filtrati sul suo id
      OPTIONAL MATCH (td:CITypeDefinition {neo4j_label: lbl})
        WHERE td.active = true
          AND (td.scope = 'base' OR (td.scope = 'tenant' AND td.tenant_id = $tenantId))
      WITH ci, td ORDER BY CASE WHEN td.scope = 'tenant' THEN 0 ELSE 1 END
      WITH ci, head(collect(td)) AS td
      WITH ci, CASE
        WHEN td IS NULL OR td.chain_families IS NULL THEN '["Application","Infrastructure"]'
        ELSE td.chain_families
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
        OPTIONAL MATCH (upstream)-[:${relPattern}*1..10]->(ci)
        WHERE upstream.tenant_id = ci.tenant_id
        // Each upstream CI once: the planner prunes instead of walking every path.
        WITH DISTINCT upstream
        WITH upstream, labels(upstream) AS uLabels
        UNWIND uLabels AS uLbl
        // tenant-ok(condivisi): tipo CI condiviso per label
        OPTIONAL MATCH (utd:CITypeDefinition {neo4j_label: uLbl})
        WHERE utd.chain_families = '["Application"]'
          AND utd.active = true
          AND (utd.scope = 'base' OR (utd.scope = 'tenant' AND utd.tenant_id = $tenantId))
        RETURN count(utd) > 0 AS hasAppUpstream
      }
      SET ci.chain = CASE
        WHEN directChain IS NOT NULL THEN directChain
        WHEN hasAppUpstream THEN 'Application'
        ELSE 'Infrastructure'
      END
      RETURN ci.id AS id, ci.chain AS chain
    `, { ciIds: [...ciIds], tenantId }))
    const chains = new Map(result.records.map((r) => [r.get('id') as string, r.get('chain') as string]))
    // Then the certificates among them take their host's chain (see CERTIFICATE_HOST_CHAIN).
    for (const id of await applyCertificateHostChain(session, tenantId, [...ciIds])) chains.set(id, CHAIN_FAMILIES[0])
    return chains
  } finally {
    await session.close()
  }
}

export async function calculateChain(ciId: string, tenantId: string): Promise<string> {
  // Niente ripiego muto: se il CI non c'è (più) lo si dice, invece di
  // restituire «Infrastructure» come se la catena fosse stata calcolata.
  const chain = (await calculateChains([ciId], tenantId)).get(ciId)
  if (!chain) throw new Error(`calculateChain: CI ${ciId} not found in tenant ${tenantId}`)
  return chain
}

/** Above this many CIs downstream, the whole tenant is recomputed in its batch instead. */
export const CHAIN_DOWNSTREAM_MAX = 2_000

/**
 * A relationship into this CI changed: its chain and the chain of every CI
 * downstream of it within the chain's 10 hops can change (review of 23 Sep
 * 2026 — only the two ends were recomputed, and the CIs further down kept
 * their old chain). Returns how many CIs were recomputed.
 */
export async function recalculateChainsFrom(ciId: string, tenantId: string): Promise<number> {
  const relPattern = await chainRelPattern(tenantId)
  const session = getSession(undefined, 'READ')
  let ids: string[]
  try {
    const res = await session.executeRead(tx => tx.run(`
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      OPTIONAL MATCH (ci)-[:${relPattern}*1..10]->(d)
      WHERE d.tenant_id = $tenantId
      WITH ci, collect(DISTINCT d.id) AS downstream
      RETURN [ci.id] + downstream AS ids
    `, { ciId, tenantId }))
    ids = (res.records[0]?.get('ids') as string[] | undefined) ?? []
    // The certificates installed on any of them follow their host (24 Sep 2026).
    ids = [...new Set([...ids, ...await certificatesOn(session, tenantId, ids)])]
  } finally {
    await session.close()
  }
  if (ids.length > CHAIN_DOWNSTREAM_MAX) return (await calculateAllChains(tenantId)).total
  await calculateChains(ids, tenantId)
  return ids.length
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
  const relPattern = await chainRelPattern(tenantId)
  const session = getSession(undefined, 'WRITE')
  try {
    /**
     * Step 1: la famiglia del tipo, risolta ESATTAMENTE come in
     * `calculateChain` (revisione totale · C-20). Prima erano due scritture in
     * fila senza filtro per tenant né `active`, quindi un CI che combaciava
     * con due definizioni prendeva la famiglia dell'ultima query eseguita; e
     * il ricalcolo generale e il salvataggio di un singolo CI potevano dare
     * catene diverse allo stesso CI. I tipi ambigui tornano a catena nulla e
     * li decide lo step 2.
     */
    await session.executeWrite(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WITH ci, labels(ci) AS ciLabels
      UNWIND ciLabels AS lbl
      // tenant-ok(condivisi): i tipi base sono condivisi, quelli del cliente filtrati sul suo id
      OPTIONAL MATCH (td:CITypeDefinition {neo4j_label: lbl})
        WHERE td.active = true
          AND (td.scope = 'base' OR (td.scope = 'tenant' AND td.tenant_id = $tenantId))
      WITH ci, td ORDER BY CASE WHEN td.scope = 'tenant' THEN 0 ELSE 1 END
      WITH ci, head(collect(td)) AS td
      SET ci.chain = CASE td.chain_families
        WHEN '["Application"]'    THEN 'Application'
        WHEN '["Infrastructure"]' THEN 'Infrastructure'
        ELSE null
      END
    `, { tenantId }))

    /**
     * Step 2: i tipi con più famiglie si decidono da monte, con la STESSA
     * regola di `calculateChain`: conta se a monte c'è un CI il cui TIPO è
     * solo-Application, non se ha l'etichetta `:Application` (C-20). Un tipo
     * del cliente dichiarato solo-Application contava per il calcolo
     * puntuale e non per questo.
     */
    await session.executeWrite(tx => tx.run(`
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE ci.chain IS NULL
      OPTIONAL MATCH (up:ConfigurationItem {tenant_id: $tenantId})-[:${relPattern}*0..10]->(ci)
      // tenant-ok(condivisi): i tipi base sono condivisi, quelli del cliente filtrati sul suo id
      OPTIONAL MATCH (utd:CITypeDefinition)
        WHERE utd.neo4j_label IN labels(up)
          AND utd.chain_families = '["Application"]'
          AND utd.active = true
          AND (utd.scope = 'base' OR (utd.scope = 'tenant' AND utd.tenant_id = $tenantId))
      WITH ci, count(utd) > 0 AS hasApp
      SET ci.chain = CASE WHEN hasApp THEN 'Application' ELSE 'Infrastructure' END
    `, { tenantId }))

    // Step 3: a certificate follows where it is installed (see CERTIFICATE_HOST_CHAIN).
    await applyCertificateHostChain(session, tenantId, null)

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
