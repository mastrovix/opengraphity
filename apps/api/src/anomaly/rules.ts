/**
 * Anomaly Detection Rules
 *
 * CI nodes use Neo4j labels; the `type` property is null — always use
 * `toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))` for entitySubtype.
 *
 * Each query MUST RETURN: entityId, entityType, entitySubtype, entityName, description, params, severity
 *
 * ## Lingua (giro nel browser del 14 set 2026, #57)
 * Titoli e descrizioni erano frasi italiane composte qui («CI Senza Owner»,
 * «CI con 7 dipendenti diretti»), anche per chi usa l'interfaccia inglese.
 * Adesso `title` e `description` sono inglesi (log, Slack, integrazioni) e
 * ogni risultato porta i suoi `params`: la pagina compone la frase nella lingua
 * di chi guarda con le chiavi `anomaly.rules.<key>.*`.
 *
 * ## «Un CI» è `:ConfigurationItem`, non un elenco di tipi (ondata 6, A-9)
 * Le regole elencavano cinque etichette (`Application`, `Server`, `Database`,
 * `DatabaseInstance`, `Certificate`): fuori restavano non solo i tipi creati
 * dal cliente ma anche tre tipi **spediti col prodotto**
 * (`BusinessApplication`, `BusinessCapability`, `DynamicCIGroup`). Un CI fuori
 * da quell'elenco non era mai orfano, mai SPOF, mai senza owner: le anomalie
 * non venivano trovate, in silenzio.
 *
 * Qui si usa `:ConfigurationItem` e non `ciLabelPredicateForTenant` per due
 * motivi: (1) queste sono Cypher **costanti di modulo**, senza tenant e senza
 * `await` (le esegue `anomalyEngine` per ogni tenant e anche
 * `scripts/run-anomaly-scan.ts`); (2) la domanda che pongono è esattamente «è
 * un Configuration Item?», e ogni CI porta quella etichetta (migrazione
 * `20260908_1010`; dal vivo 2049 su 2049). Le due regole che parlano di tipi
 * precisi (`unauthorized_relation`: `Server -DEPENDS_ON-> Application`, e il
 * candidato di `isolated_cluster`) restano sui loro tipi: è la loro semantica,
 * non una lista di comodo.
 */

export interface AnomalyRule {
  key:         string
  title:       string
  severity:    'low' | 'medium' | 'high' | 'critical'
  description: string
  cypher:      string
}

// Shared predicate reused in every rule
const CI_MATCH = `
  WHERE ci:ConfigurationItem
    AND ci.tenant_id = $tenantId
`

export const ANOMALY_RULES: AnomalyRule[] = [
  // ── 1. Orphan CI ─────────────────────────────────────────────────────────────
  {
    key:         'orphan_ci',
    title:       'Orphan CI',
    severity:    'medium',
    description: 'Configuration Item with no relation in the CMDB graph',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        AND NOT (ci)-[]-()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'The CI has no relation with other nodes of the CMDB graph' AS description,
        {}                         AS params,
        'medium'                   AS severity
    `,
  },

  // ── 2. Single Point of Failure ───────────────────────────────────────────────
  // CI with ≥5 direct dependents (other CIs that DEPENDS_ON it)
  {
    key:         'spof',
    title:       'Single Point of Failure',
    severity:    'critical',
    description: 'CI with 5 or more direct dependents in the graph',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH (dep)-[:DEPENDS_ON]->(ci)
      WHERE dep:ConfigurationItem
        AND dep.tenant_id = $tenantId
      WITH ci, count(dep) AS depCount
      WHERE depCount >= 5
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI with ' + toString(depCount) + ' direct dependents: potential SPOF' AS description,
        { count: depCount }        AS params,
        'critical'                 AS severity
    `,
  },

  // ── 3. Dependency Cycle ───────────────────────────────────────────────────────
  {
    key:         'dependency_cycle',
    title:       'Dependency Cycle',
    severity:    'high',
    description: 'Circular dependency between Configuration Items',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH path = (ci)-[:DEPENDS_ON*2..6]->(ci)
      WITH ci, length(path) AS cycleLen
      RETURN DISTINCT
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'Dependency cycle of length ' + toString(cycleLen) AS description,
        { length: cycleLen }       AS params,
        'high'                     AS severity
    `,
  },

  // ── 4. Missing Owner ──────────────────────────────────────────────────────────
  {
    key:         'missing_owner',
    title:       'CI Without Owner',
    severity:    'low',
    description: 'Configuration Item not assigned to any team',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        AND NOT (ci)-[:OWNED_BY]->()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'The CI has no owner team' AS description,
        {}                         AS params,
        'low'                      AS severity
    `,
  },

  // ── 5. Unauthorized Relation ──────────────────────────────────────────────────
  // Server that DEPENDS_ON an Application (wrong direction)
  {
    key:         'unauthorized_relation',
    title:       'Unauthorized Relation',
    severity:    'medium',
    description: 'A Server depends on an Application: direction not allowed',
    cypher: `
      MATCH (a:Server)-[:DEPENDS_ON]->(b:Application)
      WHERE a.tenant_id = $tenantId AND b.tenant_id = $tenantId
      RETURN
        a.id                                                          AS entityId,
        'CI'                                                          AS entityType,
        'server'                                                      AS entitySubtype,
        coalesce(a.name, a.id)                                        AS entityName,
        'Reversed DEPENDS_ON: Server → Application (' + coalesce(b.name, b.id) + ')' AS description,
        { application: coalesce(b.name, b.id) }                       AS params,
        'medium'                                                      AS severity
    `,
  },

  // ── 6. Isolated Cluster ────────────────────────────────────────────────────────
  // A genuinely isolated cluster: a small group of CIs connected to each other
  // but cut off from the main graph. Detected by requiring that ALL members of
  // the candidate's reachable set also have a small neighbourhood (≤5). This
  // excludes CI nodes that are part of the main graph but happen to have few
  // direct CI-to-CI edges themselves (their neighbors can reach many others).
  // Orphans (reachable=0) are handled separately by the orphan_ci rule.
  {
    key:         'isolated_cluster',
    title:       'Isolated Cluster',
    severity:    'medium',
    description: 'Group of CIs cut off from the main graph of the tenant',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        // Candidati di proposito i due tipi «foglia» del grafo spedito: non è
        // una lista di comodo, è il perimetro della regola (un cluster isolato
        // si cerca partendo da un'applicazione o da un certificato).
        AND (ci:Application OR ci:Certificate)
      OPTIONAL MATCH (ci)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..6]-(reached)
      WHERE reached:ConfigurationItem
        AND reached.tenant_id = $tenantId
      WITH ci, count(DISTINCT reached) AS reachable, collect(DISTINCT reached) AS peers
      WHERE reachable >= 1 AND reachable <= 5
      UNWIND peers AS p
      OPTIONAL MATCH (p)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..6]-(pr)
      WHERE pr:ConfigurationItem
        AND pr.tenant_id = $tenantId
      WITH ci, reachable, p, count(DISTINCT pr) AS peerReachable
      WITH ci, reachable, max(peerReachable) AS maxPeerReachable
      WHERE maxPeerReachable <= 5
      RETURN DISTINCT
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI in an isolated cluster: it reaches only ' + toString(reachable) + ' other CIs' AS description,
        { count: reachable }       AS params,
        'medium'                   AS severity
    `,
  },

  // ── 7. Risk Concentration ─────────────────────────────────────────────────────
  // CI linked to ≥5 open critical incidents
  {
    key:         'risk_concentration',
    title:       'Risk Concentration',
    severity:    'high',
    description: 'CI with 5 or more open critical incidents',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH (inc:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE inc.severity = 'critical' AND NOT inc.status IN $incidentTerminal
      WITH ci, count(inc) AS criticalCount
      WHERE criticalCount >= 5
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(head([l IN labels(ci) WHERE l <> 'ConfigurationItem']))     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI with ' + toString(criticalCount) + ' open critical incidents' AS description,
        { count: criticalCount }   AS params,
        'high'                     AS severity
    `,
  },
]
