/**
 * THE ISOLATED CLUSTER ON THE WHOLE GRAPH (browser tour of 23 Sep 2026, D49).
 *
 * «Cut off from the main graph» was measured on four relation types
 * (DEPENDS_ON, HOSTED_ON, INSTALLED_ON, USES_CERTIFICATE): an application
 * reached by the rest of the CMDB through a REALIZES or a capability looked
 * isolated, and so did every certificate next to it — 486 anomalies on the
 * demo tenant, 3 of them real. The product seed now follows every relation
 * between CIs and starts from the applications (anomaly/ruleConfig.ts).
 *
 * This migration moves to the new seed only the rules still exactly as the
 * product seeded them: a rule an administrator changed says what they chose,
 * and stays as it is (it is counted in the log). Idempotent.
 */
import type { Migration } from '@opengraphity/neo4j'
import { FACTORY_ANOMALY_RULES } from '../../anomaly/ruleConfig.js'

/** The seed written by 20260926_1010, frozen here. */
const SEED_BEFORE = {
  enabled: true, severity: 'medium', ciTypes: ['application', 'certificate'],
  relations: ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'],
  threshold: 5, incidentSeverities: [] as string[], forbidden: [] as unknown[],
}

/** Same settings, whatever the key order or the missing empty lists of the stored JSON; null = not JSON. */
function isUntouchedSeed(raw: unknown): boolean | null {
  let s: Record<string, unknown>
  try { s = JSON.parse(String(raw)) as Record<string, unknown> } catch { return null }
  const list = (v: unknown) => JSON.stringify(Array.isArray(v) ? v : [])
  return s['enabled'] === SEED_BEFORE.enabled && s['severity'] === SEED_BEFORE.severity && s['threshold'] === SEED_BEFORE.threshold
    && list(s['ciTypes']) === JSON.stringify(SEED_BEFORE.ciTypes) && list(s['relations']) === JSON.stringify(SEED_BEFORE.relations)
    && list(s['incidentSeverities']) === '[]' && list(s['forbidden']) === '[]'
}

export const isolatedClusterEveryRelation: Migration = {
  id: '20261007_1050_isolated_cluster_every_relation',
  description: 'Tour of 23 Sep 2026 (D49): the isolated-cluster rules still as seeded follow every relation between CIs, from the applications',
  async up(session) {
    const rows = await session.run(`
      MATCH (c:AnomalyRuleConfig {rule_key: 'isolated_cluster'})
      RETURN c.tenant_id AS tenantId, c.settings AS settings
      ORDER BY tenantId
    `)
    const next = JSON.stringify(FACTORY_ANOMALY_RULES.isolated_cluster)
    const now = new Date().toISOString()
    let moved = 0
    let kept = 0
    const corrupt: string[] = []
    for (const r of rows.records) {
      const untouched = isUntouchedSeed(r.get('settings'))
      if (untouched === null) { corrupt.push(r.get('tenantId') as string); continue }
      if (!untouched) { kept++; continue }
      await session.run(`
        MATCH (c:AnomalyRuleConfig {tenant_id: $tenantId, rule_key: 'isolated_cluster'})
        SET c.settings = $settings, c.updated_at = $now
      `, { tenantId: r.get('tenantId') as string, settings: next, now })
      moved++
    }
    console.log(`[${isolatedClusterEveryRelation.id}] isolated_cluster: ${String(moved)} moved to the new seed, ${String(kept)} chosen by the tenant and kept`
      + (corrupt.length ? `; settings that are not JSON, left as they are (the anomaly scan reports them): ${corrupt.join(', ')}` : ''))
  },
}
