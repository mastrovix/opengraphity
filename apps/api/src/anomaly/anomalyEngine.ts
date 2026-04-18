import { Queue, Worker, type Job } from 'bullmq'
import { randomUUID } from 'crypto'
import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage } from '@opengraphity/notifications'
import { logger } from '../lib/logger.js'
import { ANOMALY_RULES, type AnomalyRule } from './rules.js'

// ── Redis connection ──────────────────────────────────────────────────────────

const connection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

interface RuleHit {
  entityId:      string
  entityType:    string
  entitySubtype: string
  entityName:    string
  description:   string
  severity:      string
}

interface TenantRow {
  id: string
}

async function loadTenants(): Promise<TenantRow[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`MATCH (t:Tenant) RETURN t.id AS id`),
    )
    return result.records.map(r => ({ id: r.get('id') as string }))
  } finally {
    await session.close()
  }
}

async function runRule(rule: AnomalyRule, tenantId: string): Promise<RuleHit[]> {
  const session = getSession(undefined, 'READ')
  try {
    const { getTerminalStepNames } = await import('../lib/workflowHelpers.js')
    const incidentTerminal = await getTerminalStepNames(session, tenantId, 'incident')
    // GDS-based rules may fail if the plugin is not installed — skip gracefully
    const result = await session.executeRead(tx =>
      tx.run(rule.cypher, { tenantId, incidentTerminal }),
    )
    return result.records.map(r => ({
      entityId:      r.get('entityId')      as string,
      entityType:    r.get('entityType')    as string,
      entitySubtype: (r.get('entitySubtype') as string | null) ?? '',
      entityName:    r.get('entityName')    as string,
      description:   r.get('description')   as string,
      severity:      r.get('severity')      as string,
    }))
  } catch (err) {
    logger.warn({ err, ruleKey: rule.key, tenantId }, 'anomaly-engine: rule skipped (query error)')
    return []
  } finally {
    await session.close()
  }
}

/**
 * For each rule hit, MERGE an Anomaly node so we don't duplicate open anomalies.
 * Existing open anomalies for the same (tenant, rule, entity) are kept as-is.
 * Returns count of newly created anomalies.
 */
async function upsertAnomalies(
  rule: AnomalyRule,
  tenantId: string,
  hits: RuleHit[],
): Promise<number> {
  if (hits.length === 0) return 0

  const session = getSession(undefined, 'WRITE')
  try {
    let created = 0
    const now = new Date().toISOString()
    for (const hit of hits) {
      const newId = randomUUID()
      const result = await session.executeWrite(tx =>
        tx.run(`
          MERGE (a:Anomaly {
            tenant_id: $tenantId,
            rule_key:  $ruleKey,
            entity_id: $entityId
          })
          ON CREATE SET
            a.id              = $newId,
            a.status          = 'open',
            a.title           = $title,
            a.severity        = $severity,
            a.entity_type     = $entityType,
            a.entity_subtype  = $entitySubtype,
            a.entity_name     = $entityName,
            a.description     = $description,
            a.detected_at     = $now,
            a.resolved_at     = null,
            a.tenant_id       = $tenantId
          ON MATCH SET
            a.status          = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.status ELSE 'open' END,
            a.resolved_at     = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.resolved_at ELSE null END,
            a.description     = $description,
            a.severity        = $severity
          RETURN a.id AS id
        `, {
          tenantId,
          ruleKey:       rule.key,
          entityId:      hit.entityId,
          newId,
          title:         rule.title,
          severity:      hit.severity,
          entityType:    hit.entityType,
          entitySubtype: hit.entitySubtype,
          entityName:    hit.entityName,
          description:   hit.description,
          now,
        }),
      )
      // If the returned id equals the newly generated one, this was a CREATE
      if (result.records[0]?.get('id') === newId) created++
    }
    return created
  } finally {
    await session.close()
  }
}

/**
 * Auto-resolve anomalies that are no longer detected for a given rule+tenant.
 */
async function autoResolveStale(
  rule: AnomalyRule,
  tenantId: string,
  currentEntityIds: string[],
): Promise<void> {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(tx =>
      tx.run(`
        MATCH (a:Anomaly {tenant_id: $tenantId, rule_key: $ruleKey, status: 'open'})
        WHERE NOT a.entity_id IN $currentEntityIds
        SET a.status = 'resolved', a.resolved_at = $now
      `, { tenantId, ruleKey: rule.key, currentEntityIds, now }),
    )
  } finally {
    await session.close()
  }
}

async function loadSlackWebhookForTenant(tenantId: string): Promise<string | null> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead(tx =>
      tx.run(`
        MATCH (t:Tenant {id: $tenantId})-[:HAS_CHANNEL]->(c:NotificationChannel)
        WHERE c.platform = 'slack' AND c.active = true
        RETURN c.webhook_url AS webhookUrl LIMIT 1
      `, { tenantId }),
    )
    return (res.records[0]?.get('webhookUrl') as string | null) ?? null
  } finally {
    await session.close()
  }
}

async function sendSlackAlert(
  webhookUrl: string,
  tenantId: string,
  newByRule: Map<string, number>,
): Promise<void> {
  const totalNew = [...newByRule.values()].reduce((a, b) => a + b, 0)
  if (totalNew === 0) return

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 Anomalie rilevate nel grafo (${totalNew} nuove)`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Tenant: \`${tenantId}\`\n*Scanner anomalie* ha rilevato nuove anomalie nel grafo CMDB.`,
      },
    },
  ]

  const fields: unknown[] = []
  for (const [ruleKey, count] of newByRule.entries()) {
    if (count > 0) {
      const rule = ANOMALY_RULES.find(r => r.key === ruleKey)
      fields.push({ type: 'mrkdwn', text: `*${rule?.title ?? ruleKey}*\n${count} nuove anomalie` })
    }
  }

  if (fields.length > 0) {
    blocks.push({ type: 'section', fields })
  }

  blocks.push({ type: 'divider' })

  await sendSlackMessage(
    webhookUrl,
    null,
    blocks as import('@opengraphity/notifications').SlackBlock[],
  )
}

// ── Job processor ──────────────────────────────────────────────────────────────

async function anomalyScannerProcessor(_job: Job) {
  const tenants = await loadTenants()
  logger.info({ count: tenants.length }, 'anomaly-engine: scanning tenants')

  for (const tenant of tenants) {
    const newByRule = new Map<string, number>()

    for (const rule of ANOMALY_RULES) {
      try {
        const hits = await runRule(rule, tenant.id)
        const created = await upsertAnomalies(rule, tenant.id, hits)
        await autoResolveStale(rule, tenant.id, hits.map(h => h.entityId))

        newByRule.set(rule.key, created)
        if (hits.length > 0 || created > 0) {
          logger.info({ ruleKey: rule.key, tenantId: tenant.id, hits: hits.length, created }, 'anomaly-engine: rule done')
        }
      } catch (err) {
        logger.error({ err, ruleKey: rule.key, tenantId: tenant.id }, 'anomaly-engine: rule failed')
      }
    }

    // Persist scan metadata
    await persistScanStatus(tenant.id)

    // Slack notification for new anomalies
    try {
      const totalNew = [...newByRule.values()].reduce((a, b) => a + b, 0)
      if (totalNew > 0) {
        const webhookUrl = await loadSlackWebhookForTenant(tenant.id)
        if (webhookUrl) {
          await sendSlackAlert(webhookUrl, tenant.id, newByRule)
          logger.info({ tenantId: tenant.id, totalNew }, 'anomaly-engine: slack alert sent')
        }
      }
    } catch (err) {
      logger.error({ err, tenantId: tenant.id }, 'anomaly-engine: slack notification failed')
    }
  }
}

async function persistScanStatus(tenantId: string): Promise<void> {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(tx =>
      tx.run(`
        MERGE (c:AnomalyConfig {tenant_id: $tenantId})
        ON CREATE SET c.total_scans = 1,   c.last_scan_at = $now
        ON MATCH  SET c.total_scans = c.total_scans + 1, c.last_scan_at = $now
      `, { tenantId, now }),
    )
  } finally {
    await session.close()
  }
}

// ── Queue & Worker ─────────────────────────────────────────────────────────────

export const anomalyScannerQueue = new Queue('anomaly-scanner', { connection })

export function startAnomalyScanner() {
  const worker = new Worker('anomaly-scanner', anomalyScannerProcessor, { connection })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'anomaly-scanner worker failed')
  })

  // Repeating job: every hour
  anomalyScannerQueue.add(
    'scan',
    {},
    { repeat: { every: 60 * 60_000 }, jobId: 'anomaly-scanner-scan' },
  ).catch((err: unknown) => logger.error({ err }, 'anomaly-engine: failed to add repeating job'))

  logger.info('anomaly-scanner started (interval: 1h)')
  return worker
}
