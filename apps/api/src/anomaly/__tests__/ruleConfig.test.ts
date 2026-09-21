/**
 * La validazione della configurazione delle regole di anomalia (ondata 5 di
 * «Nulla cablato»): ogni scelta contro il metamodello e i vocabolari del
 * cliente, e una scelta che la regola non usa si rifiuta invece di sembrare
 * valida.
 */
import { describe, it, expect } from 'vitest'
import { ANOMALY_RULE_KEYS, ANOMALY_RULE_SPECS, FACTORY_ANOMALY_RULES, assertAnomalyRuleSettings, anomalyRuleProblem, type AnomalyRuleOptions } from '../ruleConfig.js'

const options: AnomalyRuleOptions = {
  ciTypes: [
    { name: 'server', label: 'Server', neo4jLabel: 'Server' },
    { name: 'application', label: 'Application', neo4jLabel: 'Application' },
    { name: 'certificate', label: 'Certificate', neo4jLabel: 'Certificate' },
    { name: 'firewall', label: 'Firewall', neo4jLabel: 'Firewall' },
  ],
  relations: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE', 'CONNECTS_TO'],
  incidentSeverities: ['critical', 'high', 'p1'],
}

describe('assertAnomalyRuleSettings', () => {
  it('i semi di fabbrica sono validi con il metamodello spedito e rispettano la loro spec', () => {
    for (const key of ANOMALY_RULE_KEYS) {
      expect(assertAnomalyRuleSettings(key, FACTORY_ANOMALY_RULES[key], options), key).toEqual(FACTORY_ANOMALY_RULES[key])
      const spec = ANOMALY_RULE_SPECS[key]
      expect(FACTORY_ANOMALY_RULES[key].threshold === null, key).toBe(spec.threshold === null)
    }
  })

  it('accetta i valori del cliente (tipo suo, relazione sua, severità rinominata)', () => {
    const out = assertAnomalyRuleSettings('risk_concentration', { ...FACTORY_ANOMALY_RULES.risk_concentration, ciTypes: ['firewall'], incidentSeverities: ['critical', 'p1'], threshold: 3 }, options)
    expect(out).toMatchObject({ ciTypes: ['firewall'], incidentSeverities: ['critical', 'p1'], threshold: 3 })
    expect(assertAnomalyRuleSettings('spof', { ...FACTORY_ANOMALY_RULES.spof, relations: ['CONNECTS_TO'] }, options).relations).toEqual(['CONNECTS_TO'])
  })

  it('rifiuta tipi, relazioni e severità che il cliente non ha', () => {
    expect(() => assertAnomalyRuleSettings('orphan_ci', { ...FACTORY_ANOMALY_RULES.orphan_ci, ciTypes: ['router'] }, options)).toThrow(/router/)
    expect(() => assertAnomalyRuleSettings('spof', { ...FACTORY_ANOMALY_RULES.spof, relations: ['RUNS_ON'] }, options)).toThrow(/RUNS_ON/)
    expect(() => assertAnomalyRuleSettings('risk_concentration', { ...FACTORY_ANOMALY_RULES.risk_concentration, incidentSeverities: ['blocker'] }, options)).toThrow(/blocker/)
    expect(() => assertAnomalyRuleSettings('unauthorized_relation', { ...FACTORY_ANOMALY_RULES.unauthorized_relation, forbidden: [{ fromType: 'server', relation: 'DEPENDS_ON', toType: 'router' }] }, options)).toThrow(/router/)
  })

  it('rifiuta le scelte che la regola non usa, e quelle obbligatorie mancanti', () => {
    expect(() => assertAnomalyRuleSettings('orphan_ci', { ...FACTORY_ANOMALY_RULES.orphan_ci, threshold: 3 }, options)).toThrow(/no threshold/)
    expect(() => assertAnomalyRuleSettings('missing_owner', { ...FACTORY_ANOMALY_RULES.missing_owner, relations: ['DEPENDS_ON'] }, options)).toThrow(/does not follow relations/)
    expect(() => assertAnomalyRuleSettings('unauthorized_relation', { ...FACTORY_ANOMALY_RULES.unauthorized_relation, ciTypes: ['server'] }, options)).toThrow(/CI types/)
    expect(() => assertAnomalyRuleSettings('spof', { ...FACTORY_ANOMALY_RULES.spof, relations: [] }, options)).toThrow(/at least one relation/)
    expect(() => assertAnomalyRuleSettings('risk_concentration', { ...FACTORY_ANOMALY_RULES.risk_concentration, incidentSeverities: [] }, options)).toThrow(/at least one incident severity/)
    expect(() => assertAnomalyRuleSettings('unauthorized_relation', { ...FACTORY_ANOMALY_RULES.unauthorized_relation, forbidden: [] }, options)).toThrow(/at least one forbidden/)
  })

  it('soglie nel loro intervallo, gravità nella scala, niente doppioni', () => {
    expect(() => assertAnomalyRuleSettings('dependency_cycle', { ...FACTORY_ANOMALY_RULES.dependency_cycle, threshold: 1 }, options)).toThrow(/between 2 and 10/)
    expect(() => assertAnomalyRuleSettings('spof', { ...FACTORY_ANOMALY_RULES.spof, threshold: 2.5 }, options)).toThrow(/threshold/)
    expect(() => assertAnomalyRuleSettings('spof', { ...FACTORY_ANOMALY_RULES.spof, severity: 'urgent' }, options)).toThrow(/severity/)
    expect(() => assertAnomalyRuleSettings('orphan_ci', { ...FACTORY_ANOMALY_RULES.orphan_ci, ciTypes: ['server', 'server'] }, options)).toThrow(/twice/)
  })

  it('una regola salvata che cita un tipo tolto dal metamodello ha un problema con la sua chiave', () => {
    const cfg = { ruleKey: 'isolated_cluster' as const, ...FACTORY_ANOMALY_RULES.isolated_cluster, isDefault: false, updatedAt: null }
    expect(anomalyRuleProblem(cfg, options)).toBeNull()
    const problem = anomalyRuleProblem(cfg, { ...options, ciTypes: options.ciTypes.filter((t) => t.name !== 'certificate') })
    expect(problem?.extensions['i18n']).toMatchObject({ key: 'errors.anomalyRule.unknownCIType', params: { value: 'certificate' } })
  })
})
