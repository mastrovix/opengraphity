/**
 * Le regole di anomalia come funzioni della configurazione del cliente
 * (ondata 5 di «Nulla cablato»), e i vincoli che valevano già:
 *  - «un CI» è `:ConfigurationItem`, non un elenco di tipi (ondata 6: A-9);
 *  - titoli e frasi inglesi, la pagina compone la frase coi params (#57).
 *
 * Prima soglie, relazioni, tipi e gravità erano scritti nelle Cypher: il
 * guardiano qui sotto fallisce se tornano letterali.
 */
import { describe, it, expect } from 'vitest'
import { buildAnomalyRule, type ResolvedRuleSettings } from '../rules.js'
import { ANOMALY_RULE_KEYS, FACTORY_ANOMALY_RULES, type AnomalyRuleKey } from '../ruleConfig.js'

const LABELS: Record<string, string> = { server: 'Server', application: 'Application', certificate: 'Certificate', firewall: 'Firewall' }

/** The relations of the tenant, as the engine resolves «no relation chosen» for the isolated cluster (D49). */
const TENANT_RELATIONS = ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'REALIZES']

function resolved(key: AnomalyRuleKey, over: Partial<ResolvedRuleSettings> = {}): ResolvedRuleSettings {
  const f = { ...FACTORY_ANOMALY_RULES[key], ...over }
  return {
    ...f,
    relations: f.relations.length === 0 && key === 'isolated_cluster' ? TENANT_RELATIONS : f.relations,
    ciLabels: over.ciLabels ?? f.ciTypes.map((t) => LABELS[t]!),
    forbiddenLabels: over.forbiddenLabels ?? f.forbidden.map((x) => ({ fromLabel: LABELS[x.fromType]!, relation: x.relation, toLabel: LABELS[x.toType]! })),
    productionEnvironments: over.productionEnvironments ?? ['production'],
  }
}
const factory = (key: AnomalyRuleKey) => buildAnomalyRule(key, resolved(key))

describe('buildAnomalyRule', () => {
  it('nessuna soglia, severità o gravità scritta nella Cypher: viaggiano come parametri', () => {
    for (const key of ANOMALY_RULE_KEYS) {
      const rule = factory(key)
      expect(rule.cypher, key).toMatch(key === 'spof' ? /THEN \$severity ELSE \$nonProductionSeverity END AS severity/ : /\$severity\s+AS severity/)
      expect(rule.cypher, key).not.toMatch(/'(low|medium|high|critical)'\s+AS severity/)
      expect(rule.cypher, key).not.toMatch(/>=\s*5\b|<=\s*5\b/)
      expect(rule.cypher, key).not.toMatch(/inc\.severity = 'critical'/)
      expect(rule.params['severity'], key).toBe(FACTORY_ANOMALY_RULES[key].severity)
    }
    expect(factory('spof').params['threshold']).toBe(5)
    // G32: outside the tenant's production environments a SPOF is medium by default.
    expect(factory('spof').params).toMatchObject({ nonProductionSeverity: 'medium', productionEnvironments: ['production'] })
    expect(factory('orphan_ci').params['nonProductionSeverity']).toBe('medium')
    expect(factory('risk_concentration').params['incidentSeverities']).toEqual(['critical'])
  })

  it('le regole senza tipi scelti filtrano su :ConfigurationItem e sul tenant, senza elenchi di etichette', () => {
    for (const key of ['orphan_ci', 'spof', 'dependency_cycle', 'missing_owner', 'risk_concentration'] as const) {
      const rule = factory(key)
      expect(rule.cypher, key).toContain('WHERE ci:ConfigurationItem')
      expect(rule.cypher, key).toContain('ci.tenant_id = $tenantId')
      expect(rule.cypher, key).not.toMatch(/ci:Application OR ci:Server|:DatabaseInstance\b/)
    }
    expect(factory('spof').cypher).toContain('WHERE dep:ConfigurationItem')
  })

  it('tipi e relazioni scelti dal cliente entrano nella regola, compreso un tipo suo', () => {
    const spof = buildAnomalyRule('spof', resolved('spof', { ciLabels: ['Firewall'], relations: ['DEPENDS_ON', 'CONNECTS_TO'] }))
    expect(spof.cypher).toContain('AND (ci:Firewall)')
    expect(spof.cypher).toContain('MATCH (dep)-[:DEPENDS_ON|CONNECTS_TO]->(ci)')
    const cycle = buildAnomalyRule('dependency_cycle', resolved('dependency_cycle', { threshold: 4 }))
    // Cycles of 2 to 4 links: one step, then the shortest way back in 1 to 3 (review of 23 Sep 2026).
    expect(cycle.cypher).toContain('MATCH (ci)-[:DEPENDS_ON]->(next)')
    expect(cycle.cypher).toContain('shortestPath((next)-[:DEPENDS_ON*1..3]->(ci))')
    // D49: from the applications only, on the relations the engine resolved (every relation of the tenant when none is chosen)
    const cluster = buildAnomalyRule('isolated_cluster', resolved('isolated_cluster', { ciLabels: ['Application'], relations: ['DEPENDS_ON', 'REALIZES'] }))
    expect(cluster.cypher).toContain('AND (ci:Application)')
    expect(cluster.cypher).toContain('[:DEPENDS_ON|REALIZES*1..6]')
    // each exploration stops as soon as the answer is «not isolated»
    expect(cluster.cypher).toContain('WITH DISTINCT reached LIMIT toInteger($threshold) + 1')
    expect(cluster.cypher).toContain('WITH DISTINCT pr LIMIT toInteger($threshold) + 1')
  })

  it('le relazioni vietate sono quelle del cliente, una MATCH per ciascuna', () => {
    expect(factory('unauthorized_relation').cypher).toContain('MATCH (ci:Server)-[:DEPENDS_ON]->(b:Application)')
    const two = buildAnomalyRule('unauthorized_relation', resolved('unauthorized_relation', {
      forbiddenLabels: [{ fromLabel: 'Server', relation: 'DEPENDS_ON', toLabel: 'Application' }, { fromLabel: 'Firewall', relation: 'HOSTED_ON', toLabel: 'Certificate' }],
    }))
    expect(two.cypher).toContain('UNION ALL')
    expect(two.cypher).toContain('MATCH (ci:Firewall)-[:HOSTED_ON]->(b:Certificate)')
  })

  it('un nome non valido non arriva mai nella Cypher', () => {
    expect(() => buildAnomalyRule('spof', resolved('spof', { relations: ['DEPENDS_ON]->() DETACH DELETE (x) //'] }))).toThrow(/not a valid relation/)
    expect(() => buildAnomalyRule('orphan_ci', resolved('orphan_ci', { ciLabels: ['Server) OR true //'] }))).toThrow(/not a valid label/)
  })

  it('ogni regola restituisce il contratto atteso dall\'engine', () => {
    for (const key of ANOMALY_RULE_KEYS) {
      for (const field of ['entityId', 'entityType', 'entitySubtype', 'entityName', 'description', 'params', 'severity']) {
        expect(factory(key).cypher, `${key}/${field}`).toContain(`AS ${field}`)
      }
    }
  })

  /** Giro nel browser del 14 set 2026 (#57): «CI Senza Owner» anche con l'interfaccia inglese. */
  it('titoli e descrizioni sono inglesi: la frase per chi guarda la compone la pagina coi params', () => {
    const ITALIAN = /[àèéìòù]|\b(il|la|di|del|con|senza|rilevat|dipend|incidenti|nodi|raggiunge)\b/i
    for (const key of ANOMALY_RULE_KEYS) {
      const rule = factory(key)
      expect(rule.title, key).not.toMatch(ITALIAN)
      expect(rule.description, key).not.toMatch(ITALIAN)
      const literals = [...rule.cypher.matchAll(/'([^']*)'/g)].map((m) => m[1]!)
      expect(literals.filter((l) => ITALIAN.test(l)), key).toEqual([])
    }
  })
})
