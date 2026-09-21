/**
 * Verifica «Cosa resta cablato», ondata 5: la configurazione delle regole di
 * anomalia diventa dato del cliente (`AnomalyRuleConfig`, anomaly/ruleConfig.ts).
 * Qui si scrive per ogni tenant e ogni regola esattamente quello che le Cypher
 * costanti facevano (tutte attive, soglie 5/6/5/5, `DEPENDS_ON`, Server →
 * Application vietata, severità `critical`), così nessuna anomalia cambia il
 * primo giorno. Una regola già configurata non si tocca. Idempotente.
 *
 * L'unicità su (tenant_id, rule_key) sta in `packages/neo4j/src/init.ts`,
 * con gli altri vincoli.
 */
import type { Migration } from '@opengraphity/neo4j'
import { ANOMALY_RULE_KEYS, FACTORY_ANOMALY_RULES } from '../../anomaly/ruleConfig.js'

export const anomalyRuleConfigsSeed: Migration = {
  id: '20260926_1010_anomaly_rule_configs',
  description: 'AnomalyRuleConfig: le regole di anomalia diventano configurabili, seminate con le soglie e i tipi di prima',
  async up(session) {
    const rules = ANOMALY_RULE_KEYS.map((ruleKey) => ({ ruleKey, settings: JSON.stringify(FACTORY_ANOMALY_RULES[ruleKey]) }))
    const r = await session.run(`
      MATCH (t:Tenant)
      UNWIND $rules AS rule
      OPTIONAL MATCH (existing:AnomalyRuleConfig {tenant_id: t.id, rule_key: rule.ruleKey})
      WITH t, rule, existing WHERE existing IS NULL
      CREATE (:AnomalyRuleConfig {tenant_id: t.id, rule_key: rule.ruleKey, settings: rule.settings, updated_at: $now})
      RETURN t.id AS tenant, count(*) AS created
    `, { rules, now: new Date().toISOString() })
    const done = r.records.map((rec) => `${rec.get('tenant') as string} (${String(rec.get('created'))})`)
    console.log(`[${anomalyRuleConfigsSeed.id}] regole seminate: ${done.length ? done.join(', ') : 'nessuna'}`)
  },
}
