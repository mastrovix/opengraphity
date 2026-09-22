/**
 * The anomaly rules refuse a configuration they cannot turn into a safe query.
 *
 * Why it matters: relation names, labels and the cycle length are
 * interpolated into Cypher (the language does not accept them as parameters),
 * so the only protection is validation before interpolation. And a rule with
 * nothing to look for — no relation to follow, no forbidden relation, a cycle
 * bound below 2 — must fail loudly: an empty pattern would either be a Cypher
 * error on every run or a rule that silently never finds anything while the
 * page reports "no anomalies".
 */
import { describe, it, expect } from 'vitest'
import { buildAnomalyRule, type ResolvedRuleSettings } from '../rules.js'
import { FACTORY_ANOMALY_RULES, type AnomalyRuleKey } from '../ruleConfig.js'

function settings(key: AnomalyRuleKey, over: Partial<ResolvedRuleSettings> = {}): ResolvedRuleSettings {
  return { ...FACTORY_ANOMALY_RULES[key], ciLabels: [], forbiddenLabels: [], ...over }
}

describe('buildAnomalyRule — refusals', () => {
  it.each(['spof', 'dependency_cycle', 'isolated_cluster'] as const)('%s refuses an empty relation list', (key) => {
    expect(() => buildAnomalyRule(key, settings(key, { relations: [] }))).toThrow(`anomaly rule ${key}: no relation to follow`)
  })

  it('refuses a relation name that is not an identifier, before it reaches the Cypher', () => {
    expect(() => buildAnomalyRule('spof', settings('spof', { relations: ['DEPENDS_ON]->() DETACH DELETE ci //'] })))
      .toThrow('is not a valid relation')
  })

  it.each([null, 1, 3.5])('dependency_cycle refuses a maximum length of %s', (threshold) => {
    expect(() => buildAnomalyRule('dependency_cycle', settings('dependency_cycle', { threshold })))
      .toThrow('anomaly rule dependency_cycle: invalid maximum length')
  })

  it('unauthorized_relation refuses a configuration with no forbidden relation', () => {
    expect(() => buildAnomalyRule('unauthorized_relation', settings('unauthorized_relation')))
      .toThrow('anomaly rule unauthorized_relation: no forbidden relation declared')
  })

  it('unauthorized_relation refuses an invalid label or relation in a forbidden pair', () => {
    expect(() => buildAnomalyRule('unauthorized_relation', settings('unauthorized_relation', {
      forbiddenLabels: [{ fromLabel: 'Server) DETACH DELETE (x', relation: 'DEPENDS_ON', toLabel: 'Application' }],
    }))).toThrow('is not a valid label')
    expect(() => buildAnomalyRule('unauthorized_relation', settings('unauthorized_relation', {
      forbiddenLabels: [{ fromLabel: 'Server', relation: 'depends_on', toLabel: 'Application' }],
    }))).toThrow('is not a valid relation')
  })
})

describe('buildAnomalyRule — unauthorized_relation with several pairs', () => {
  it('joins one tenant-scoped MATCH per forbidden pair with UNION ALL', () => {
    const rule = buildAnomalyRule('unauthorized_relation', settings('unauthorized_relation', {
      forbiddenLabels: [
        { fromLabel: 'Server', relation: 'DEPENDS_ON', toLabel: 'Application' },
        { fromLabel: 'Firewall', relation: 'HOSTED_ON', toLabel: 'Server' },
      ],
    }))
    expect(rule.cypher.split('UNION ALL')).toHaveLength(2)
    expect(rule.cypher).toContain('MATCH (ci:Server)-[:DEPENDS_ON]->(b:Application)')
    expect(rule.cypher).toContain('MATCH (ci:Firewall)-[:HOSTED_ON]->(b:Server)')
    // Both ends of every pair are scoped: a cross-tenant edge is not this tenant's anomaly.
    expect(rule.cypher.match(/ci\.tenant_id = \$tenantId AND b\.tenant_id = \$tenantId/g)).toHaveLength(2)
  })
})
