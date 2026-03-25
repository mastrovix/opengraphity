/**
 * Anomaly Detection Rules
 *
 * CI nodes use Neo4j labels (Application, Server, Database, DatabaseInstance, Certificate).
 * The `type` property is null — always use `toLower(labels(ci)[0])` for entitySubtype.
 *
 * Each query MUST RETURN: entityId, entityType, entitySubtype, entityName, description, severity
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
  WHERE (ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate)
    AND ci.tenant_id = $tenantId
`

export const ANOMALY_RULES: AnomalyRule[] = [
  // ── 1. Orphan CI ─────────────────────────────────────────────────────────────
  {
    key:         'orphan_ci',
    title:       'CI Orfano',
    severity:    'medium',
    description: 'Configuration Item senza alcuna relazione nel grafo CMDB',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        AND NOT (ci)-[]-()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'Il CI non ha relazioni con altri nodi nel grafo CMDB' AS description,
        'medium'                   AS severity
    `,
  },

  // ── 2. Single Point of Failure ───────────────────────────────────────────────
  // CI with ≥5 direct dependents (other CIs that DEPENDS_ON it)
  {
    key:         'spof',
    title:       'Single Point of Failure',
    severity:    'critical',
    description: 'CI con ≥5 dipendenti diretti nel grafo',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH (dep)-[:DEPENDS_ON]->(ci)
      WHERE (dep:Application OR dep:Server OR dep:Database OR dep:DatabaseInstance OR dep:Certificate)
        AND dep.tenant_id = $tenantId
      WITH ci, count(dep) AS depCount
      WHERE depCount >= 5
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI con ' + toString(depCount) + ' dipendenti diretti — potenziale SPOF' AS description,
        'critical'                 AS severity
    `,
  },

  // ── 3. Dependency Cycle ───────────────────────────────────────────────────────
  {
    key:         'dependency_cycle',
    title:       'Ciclo di Dipendenza',
    severity:    'high',
    description: 'Dipendenza circolare rilevata tra Configuration Items',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH path = (ci)-[:DEPENDS_ON*2..6]->(ci)
      WITH ci, length(path) AS cycleLen
      RETURN DISTINCT
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'Ciclo di dipendenza di lunghezza ' + toString(cycleLen) + ' rilevato' AS description,
        'high'                     AS severity
    `,
  },

  // ── 4. Missing Owner ──────────────────────────────────────────────────────────
  {
    key:         'missing_owner',
    title:       'CI Senza Owner',
    severity:    'low',
    description: 'Configuration Item non assegnato ad alcun team',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        AND NOT (ci)-[:OWNED_BY]->()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'Il CI non ha un owner o team assegnato' AS description,
        'low'                      AS severity
    `,
  },

  // ── 5. Unauthorized Relation ──────────────────────────────────────────────────
  // Server that DEPENDS_ON an Application (wrong direction)
  {
    key:         'unauthorized_relation',
    title:       'Relazione Non Autorizzata',
    severity:    'medium',
    description: 'Server dipende da un Application — direzione non consentita',
    cypher: `
      MATCH (a:Server)-[:DEPENDS_ON]->(b:Application)
      WHERE a.tenant_id = $tenantId AND b.tenant_id = $tenantId
      RETURN
        a.id                                                          AS entityId,
        'CI'                                                          AS entityType,
        'server'                                                      AS entitySubtype,
        coalesce(a.name, a.id)                                        AS entityName,
        'DEPENDS_ON inverso: Server → Application (' + coalesce(b.name, b.id) + ')' AS description,
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
    title:       'Cluster Isolato',
    severity:    'medium',
    description: 'Gruppo di CI disconnesso dal grafo principale del tenant',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        AND (ci:Application OR ci:Certificate)
      OPTIONAL MATCH (ci)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..6]-(reached)
      WHERE (reached:Application OR reached:Server OR reached:Database OR reached:DatabaseInstance OR reached:Certificate)
        AND reached.tenant_id = $tenantId
      WITH ci, count(DISTINCT reached) AS reachable, collect(DISTINCT reached) AS peers
      WHERE reachable >= 1 AND reachable <= 5
      UNWIND peers AS p
      OPTIONAL MATCH (p)-[:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE*1..6]-(pr)
      WHERE (pr:Application OR pr:Server OR pr:Database OR pr:DatabaseInstance OR pr:Certificate)
        AND pr.tenant_id = $tenantId
      WITH ci, reachable, p, count(DISTINCT pr) AS peerReachable
      WITH ci, reachable, max(peerReachable) AS maxPeerReachable
      WHERE maxPeerReachable <= 5
      RETURN DISTINCT
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI in cluster isolato: raggiunge solo ' + toString(reachable) + ' altri nodi CI' AS description,
        'medium'                   AS severity
    `,
  },

  // ── 7. Risk Concentration ─────────────────────────────────────────────────────
  // CI linked to ≥5 open critical incidents
  {
    key:         'risk_concentration',
    title:       'Concentrazione di Rischio',
    severity:    'high',
    description: 'CI con ≥5 incidenti critici aperti',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
      MATCH (inc:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE inc.severity = 'critical' AND inc.status = 'open'
      WITH ci, count(inc) AS criticalCount
      WHERE criticalCount >= 5
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        toLower(labels(ci)[0])     AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI con ' + toString(criticalCount) + ' incidenti critici aperti' AS description,
        'high'                     AS severity
    `,
  },
]
