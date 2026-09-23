/**
 * Anomaly Detection Rules
 *
 * CI nodes use Neo4j labels; the `type` property is null — always use
 * `[l IN labels(ci) WHERE l <> 'ConfigurationItem']` for entitySubtype (the engine maps the labels to the type name).
 *
 * Each query MUST RETURN: entityId, entityType, entitySubtype, entityName, description, params, severity
 *
 * ## Lingua (giro nel browser del 14 set 2026, #57)
 * Titoli e descrizioni sono inglesi (log, Slack, integrazioni) e ogni risultato
 * porta i suoi `params`: la pagina compone la frase nella lingua di chi guarda
 * con le chiavi `anomaly.hits.<key>`.
 *
 * ## «Un CI» è `:ConfigurationItem`, non un elenco di tipi (ondata 6, A-9)
 * Ogni CI porta quell'etichetta (migrazione `20260908_1010`): una regola senza
 * tipi scelti lavora su tutti i tipi del cliente, anche quelli che creerà.
 *
 * ## La logica è del prodotto, le scelte del cliente (ondata 5 di «Nulla cablato»)
 * Prima le Cypher erano costanti con soglie, relazioni, tipi e gravità scritti
 * dentro. Adesso ogni regola è una funzione della sua configurazione
 * (`ruleConfig.ts`): i numeri e le severità viaggiano come parametri, e i nomi
 * di etichette e relazioni — che Cypher non accetta come parametri nei pattern
 * — sono interpolati solo dopo la validazione contro il metamodello del cliente
 * (`RELATIONSHIP_TYPE_RE`, etichette dei tipi attivi).
 */
import type { AnomalyRuleKey, AnomalyRuleSettings } from './ruleConfig.js'

export interface AnomalyRule {
  key:         AnomalyRuleKey
  title:       string
  description: string
  cypher:      string
  params:      Record<string, unknown>
}

/** La configurazione con i tipi già tradotti in etichette Neo4j (li traduce l'engine, dal metamodello). */
export interface ResolvedRuleSettings extends AnomalyRuleSettings {
  ciLabels:        string[]
  forbiddenLabels: Array<{ fromLabel: string; relation: string; toLabel: string }>
}

const LABEL_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const REL_RE = /^[A-Z][A-Z0-9_]*$/

function label(l: string): string {
  if (!LABEL_RE.test(l)) throw new Error(`anomaly rules: "${l}" is not a valid label`)
  return l
}

function relPattern(relations: readonly string[], ruleKey: string): string {
  if (relations.length === 0) throw new Error(`anomaly rule ${ruleKey}: no relation to follow`)
  for (const r of relations) if (!REL_RE.test(r)) throw new Error(`anomaly rule ${ruleKey}: "${r}" is not a valid relation`)
  return relations.join('|')
}

/** `AND (ci:A OR ci:B)` per i tipi scelti; niente se la regola lavora su tutti i CI. */
function typeFilter(alias: string, labels: readonly string[]): string {
  return labels.length ? `AND (${labels.map((l) => `${alias}:${label(l)}`).join(' OR ')})` : ''
}

// Shared predicate reused in every rule
const CI_MATCH = `
  WHERE ci:ConfigurationItem
    AND ci.tenant_id = $tenantId
`

/**
 * Le label del CI: il nome del tipo lo ricava il motore con `ciTypeFromLabels`
 * (secondo giro UI del 15 set 2026 · V-3). `toLower(head(labels))` dava
 * «businessapplication» per BusinessApplication, che non è il nome di nessun tipo.
 */
const SUBTYPE = `[l IN labels(ci) WHERE l <> 'ConfigurationItem']`

type Builder = (s: ResolvedRuleSettings) => Omit<AnomalyRule, 'key' | 'params'> & { params?: Record<string, unknown> }

const BUILDERS: Record<AnomalyRuleKey, Builder> = {
  // ── 1. Orphan CI ─────────────────────────────────────────────────────────────
  orphan_ci: (s) => ({
    title:       'Orphan CI',
    description: 'Configuration Item with no relation in the CMDB graph',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        ${typeFilter('ci', s.ciLabels)}
        AND NOT (ci)-[]-()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        ${SUBTYPE}                 AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'The CI has no relation with other nodes of the CMDB graph' AS description,
        {}                         AS params,
        $severity                  AS severity
    `,
  }),

  // ── 2. Single Point of Failure ───────────────────────────────────────────────
  // CI with at least `threshold` direct dependents (other CIs that point to it)
  spof: (s) => ({
    title:       'Single Point of Failure',
    description: 'CI with many direct dependents in the graph',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        ${typeFilter('ci', s.ciLabels)}
      MATCH (dep)-[:${relPattern(s.relations, 'spof')}]->(ci)
      WHERE dep:ConfigurationItem
        AND dep.tenant_id = $tenantId
      WITH ci, count(DISTINCT dep) AS depCount
      WHERE depCount >= $threshold
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        ${SUBTYPE}                 AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI with ' + toString(depCount) + ' direct dependents: potential SPOF' AS description,
        { count: depCount }        AS params,
        $severity                  AS severity
    `,
  }),

  // ── 3. Dependency Cycle ───────────────────────────────────────────────────────
  // The upper bound of a variable-length pattern cannot be a parameter: it is a
  // validated integer (ruleConfig: 2..10).
  dependency_cycle: (s) => {
    const max = s.threshold
    if (max == null || !Number.isInteger(max) || max < 2) throw new Error('anomaly rule dependency_cycle: invalid maximum length')
    return {
      title:       'Dependency Cycle',
      description: 'Circular dependency between Configuration Items',
      cypher: `
        MATCH (ci)
        ${CI_MATCH}
          ${typeFilter('ci', s.ciLabels)}
        MATCH path = (ci)-[:${relPattern(s.relations, 'dependency_cycle')}*2..${String(max)}]->(ci)
        WITH ci, min(length(path)) AS cycleLen
        RETURN DISTINCT
          ci.id                      AS entityId,
          'CI'                       AS entityType,
          ${SUBTYPE}                 AS entitySubtype,
          coalesce(ci.name, ci.id)   AS entityName,
          'Dependency cycle of length ' + toString(cycleLen) AS description,
          { length: cycleLen }       AS params,
          $severity                  AS severity
      `,
    }
  },

  // ── 4. Missing Owner ──────────────────────────────────────────────────────────
  // OWNED_BY → Team is the product's ownership structure, not a CMDB relation.
  missing_owner: (s) => ({
    title:       'CI Without Owner',
    description: 'Configuration Item not assigned to any team',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        ${typeFilter('ci', s.ciLabels)}
        AND NOT (ci)-[:OWNED_BY]->()
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        ${SUBTYPE}                 AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'The CI has no owner team' AS description,
        {}                         AS params,
        $severity                  AS severity
    `,
  }),

  // ── 5. Unauthorized Relation ──────────────────────────────────────────────────
  // One MATCH per forbidden relation declared by the tenant, joined by UNION ALL.
  unauthorized_relation: (s) => {
    if (s.forbiddenLabels.length === 0) throw new Error('anomaly rule unauthorized_relation: no forbidden relation declared')
    const parts = s.forbiddenLabels.map((f) => `
      MATCH (ci:${label(f.fromLabel)})-[:${relPattern([f.relation], 'unauthorized_relation')}]->(b:${label(f.toLabel)})
      WHERE ci.tenant_id = $tenantId AND b.tenant_id = $tenantId
      RETURN
        ci.id                                                         AS entityId,
        'CI'                                                          AS entityType,
        ${SUBTYPE}                                                    AS entitySubtype,
        coalesce(ci.name, ci.id)                                      AS entityName,
        'Forbidden ${f.relation}: ${f.fromLabel} → ${f.toLabel} (' + coalesce(b.name, b.id) + ')' AS description,
        { target: coalesce(b.name, b.id), relation: '${f.relation}', fromType: '${f.fromLabel}', toType: '${f.toLabel}' } AS params,
        $severity                                                     AS severity
    `)
    return {
      title:       'Unauthorized Relation',
      description: 'A relation the tenant declared as not allowed',
      cypher:      parts.join('\n      UNION ALL\n'),
    }
  },

  // ── 6. Isolated Cluster ────────────────────────────────────────────────────────
  // A genuinely isolated cluster: a small group of CIs connected to each other
  // but cut off from the main graph. Detected by requiring that ALL members of
  // the candidate's reachable set also have a small neighbourhood (≤ threshold).
  // Orphans (reachable=0) are handled separately by the orphan_ci rule. The
  // search depth (6) is the rule's own definition of «reachable».
  //
  // Each exploration stops at threshold + 1 distinct CIs (tour of 23 Sep 2026,
  // D49): past that the answer is already «not isolated», and walking the
  // whole component of every candidate took 3.4 s on the demo tenant with
  // four relation types — with all of them it would not end.
  isolated_cluster: (s) => {
    const rels = relPattern(s.relations, 'isolated_cluster')
    return {
      title:       'Isolated Cluster',
      description: 'Group of CIs cut off from the main graph of the tenant',
      cypher: `
        MATCH (ci)
        ${CI_MATCH}
          ${typeFilter('ci', s.ciLabels)}
        CALL (ci) {
          OPTIONAL MATCH (ci)-[:${rels}*1..6]-(reached:ConfigurationItem)
          WHERE reached.tenant_id = $tenantId AND reached <> ci
          WITH DISTINCT reached LIMIT toInteger($threshold) + 1
          RETURN collect(reached) AS peers
        }
        WITH ci, peers, size(peers) AS reachable
        WHERE reachable >= 1 AND reachable <= $threshold
        UNWIND peers AS p
        CALL (p) {
          OPTIONAL MATCH (p)-[:${rels}*1..6]-(pr:ConfigurationItem)
          WHERE pr.tenant_id = $tenantId AND pr <> p
          WITH DISTINCT pr LIMIT toInteger($threshold) + 1
          RETURN count(pr) AS peerReachable
        }
        WITH ci, reachable, max(peerReachable) AS maxPeerReachable
        WHERE maxPeerReachable <= $threshold
        RETURN DISTINCT
          ci.id                      AS entityId,
          'CI'                       AS entityType,
          ${SUBTYPE}                 AS entitySubtype,
          coalesce(ci.name, ci.id)   AS entityName,
          'CI in an isolated cluster: it reaches only ' + toString(reachable) + ' other CIs' AS description,
          { count: reachable }       AS params,
          $severity                  AS severity
      `,
    }
  },

  // ── 7. Risk Concentration ─────────────────────────────────────────────────────
  // CI linked to at least `threshold` open incidents of the severities the tenant counts as critical
  risk_concentration: (s) => ({
    title:       'Risk Concentration',
    description: 'CI with many open critical incidents',
    cypher: `
      MATCH (ci)
      ${CI_MATCH}
        ${typeFilter('ci', s.ciLabels)}
      MATCH (inc:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE inc.severity IN $incidentSeverities AND NOT inc.status IN $incidentTerminal
      WITH ci, count(inc) AS criticalCount
      WHERE criticalCount >= $threshold
      RETURN
        ci.id                      AS entityId,
        'CI'                       AS entityType,
        ${SUBTYPE}                 AS entitySubtype,
        coalesce(ci.name, ci.id)   AS entityName,
        'CI with ' + toString(criticalCount) + ' open critical incidents' AS description,
        { count: criticalCount }   AS params,
        $severity                  AS severity
    `,
  }),
}

/** La regola pronta da eseguire per questa configurazione. */
export function buildAnomalyRule(key: AnomalyRuleKey, settings: ResolvedRuleSettings): AnomalyRule {
  const built = BUILDERS[key](settings)
  return {
    key,
    title:       built.title,
    description: built.description,
    cypher:      built.cypher,
    params:      { severity: settings.severity, threshold: settings.threshold, incidentSeverities: settings.incidentSeverities },
  }
}
