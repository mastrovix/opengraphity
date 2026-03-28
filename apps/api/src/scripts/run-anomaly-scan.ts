/**
 * Runs the anomaly scanner once, directly (no BullMQ queue).
 * Usage: pnpm --filter @opengraphity/api run scan:anomalies
 */
import { getSession } from '@opengraphity/neo4j'
import { ANOMALY_RULES } from '../anomaly/rules.js'

const TENANT = 'c-one'

function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof (v as { toNumber(): number }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v ?? 0)
}

async function main() {
  const now = new Date().toISOString()
  console.log(`\n=== Anomaly Scanner — ${now} ===\n`)

  const totals: Record<string, number> = {}

  for (const rule of ANOMALY_RULES) {
    const session = getSession(undefined, 'READ')
    let hits: Array<{ entityId: string; entitySubtype: string; entityName: string; description: string }> = []
    try {
      const result = await session.executeRead(tx => tx.run(rule.cypher, { tenantId: TENANT }))
      hits = result.records.map(r => ({
        entityId:      r.get('entityId')      as string,
        entitySubtype: r.get('entitySubtype') as string,
        entityName:    r.get('entityName')    as string,
        description:   r.get('description')   as string,
      }))
    } catch (err) {
      console.warn(`  [WARN] ${rule.key}: query failed —`, (err as Error).message.split('\n')[0])
    } finally {
      await session.close()
    }

    if (hits.length === 0) {
      console.log(`✓ ${rule.title.padEnd(30)} 0 anomalie`)
      totals[rule.key] = 0
      continue
    }

    console.log(`✗ ${rule.title.padEnd(30)} ${hits.length} anomalie`)
    hits.forEach(h => console.log(`    [${h.entitySubtype}] ${h.entityName} — ${h.description}`))
    totals[rule.key] = hits.length

    // Upsert Anomaly nodes
    const writeSession = getSession(undefined, 'WRITE')
    try {
      for (const hit of hits) {
        const newId = crypto.randomUUID()
        await writeSession.executeWrite(tx => tx.run(`
          MERGE (a:Anomaly {
            tenant_id: $tenantId,
            rule_key:  $ruleKey,
            entity_id: $entityId
          })
          ON CREATE SET
            a.id             = $newId,
            a.status         = 'open',
            a.title          = $title,
            a.severity       = $severity,
            a.entity_type    = 'CI',
            a.entity_subtype = $entitySubtype,
            a.entity_name    = $entityName,
            a.description    = $description,
            a.detected_at    = $now,
            a.resolved_at    = null,
            a.tenant_id      = $tenantId
          ON MATCH SET
            a.status         = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.status ELSE 'open' END,
            a.resolved_at    = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.resolved_at ELSE null END,
            a.description    = $description,
            a.severity       = $severity
        `, {
          tenantId:      TENANT,
          ruleKey:       rule.key,
          entityId:      hit.entityId,
          newId,
          title:         rule.title,
          severity:      rule.severity,
          entitySubtype: hit.entitySubtype,
          entityName:    hit.entityName,
          description:   hit.description,
          now,
        }))
      }

      // Auto-resolve stale
      const currentIds = hits.map(h => h.entityId)
      await writeSession.executeWrite(tx => tx.run(`
        MATCH (a:Anomaly {tenant_id: $tenantId, rule_key: $ruleKey, status: 'open'})
        WHERE NOT a.entity_id IN $currentIds
        SET a.status = 'resolved', a.resolved_at = $now
      `, { tenantId: TENANT, ruleKey: rule.key, currentIds, now }))
    } finally {
      await writeSession.close()
    }
  }

  // Persist scan status
  const cfgSession = getSession(undefined, 'WRITE')
  try {
    await cfgSession.executeWrite(tx => tx.run(`
      MERGE (c:AnomalyConfig {tenant_id: $tenantId})
      ON CREATE SET c.total_scans = 1, c.last_scan_at = $now
      ON MATCH  SET c.total_scans = c.total_scans + 1, c.last_scan_at = $now
    `, { tenantId: TENANT, now }))
  } finally {
    await cfgSession.close()
  }

  const grand = Object.values(totals).reduce((a, b) => a + b, 0)
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Totale anomalie rilevate: ${grand}`)
  Object.entries(totals).forEach(([k, v]) => v > 0 && console.log(`  ${k}: ${v}`))
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
