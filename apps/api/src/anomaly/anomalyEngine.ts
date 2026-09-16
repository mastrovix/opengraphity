import type { Worker, Job } from 'bullmq'
import { randomUUID } from 'crypto'
import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage } from '@opengraphity/notifications'
import { logger } from '../lib/logger.js'
import { ciTypeFromLabels } from '../lib/ciTypeFromLabels.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { buildAnomalyRule, type AnomalyRule, type ResolvedRuleSettings } from './rules.js'
import { anomalyRuleOptions, anomalyRuleProblem, loadAnomalyRuleConfigs, type AnomalyRuleConfig, type AnomalyRuleOptions } from './ruleConfig.js'

export const ANOMALY_SCANNER_QUEUE = 'anomaly-scanner'

/**
 * Job payload. The hourly `scan` job carries no tenantId and scans every
 * tenant; a manual `scan-manual` (runAnomalyScanner mutation) carries the
 * caller's tenantId and scans ONLY that tenant (C-18) — before, one click
 * from any tenant scanned the whole platform.
 */
export interface AnomalyScanJobData {
  tenantId?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface RuleHit {
  entityId:      string
  entityType:    string
  entitySubtype: string
  entityName:    string
  description:   string
  params:        Record<string, string>
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

/** I parametri della frase di un risultato, come stringhe (la pagina li interpola). */
function stringParams(raw: unknown, ruleKey: string): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`anomaly rule ${ruleKey}: the query must return params as a map`)
  }
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [
    k, typeof v === 'object' && v !== null && 'toNumber' in v ? String((v as { toNumber(): number }).toNumber()) : String(v),
  ]))
}

/**
 * Il tipo del CI di un'anomalia: le regole restituiscono le label del nodo
 * (V-3), il nome del tipo lo dà il metamodello. Una stringa resta com'è (una
 * regola che non riguarda un CI).
 */
export function entitySubtypeOf(tenantId: string, raw: unknown): string {
  if (raw == null) return ''
  if (Array.isArray(raw)) return raw.length === 0 ? '' : ciTypeFromLabels(tenantId, raw as string[])
  if (typeof raw === 'string') return raw
  throw new Error(`anomaly rule returned an unreadable entitySubtype: ${JSON.stringify(raw)}`)
}

async function runRule(rule: AnomalyRule, tenantId: string): Promise<RuleHit[]> {
  const session = getSession(undefined, 'READ')
  try {
    const { getTerminalStepNames } = await import('../lib/workflowHelpers.js')
    const incidentTerminal = await getTerminalStepNames(session, tenantId, 'incident')
    // GDS-based rules may fail if the plugin is not installed — skip gracefully
    const result = await session.executeRead(tx =>
      tx.run(rule.cypher, { ...rule.params, tenantId, incidentTerminal }),
    )
    return result.records.map(r => ({
      entityId:      r.get('entityId')      as string,
      entityType:    r.get('entityType')    as string,
      entitySubtype: entitySubtypeOf(tenantId, r.get('entitySubtype')),
      entityName:    r.get('entityName')    as string,
      description:   r.get('description')   as string,
      params:        stringParams(r.get('params'), rule.key),
      severity:      r.get('severity')      as string,
    }))
  } catch (err) {
    // Fail loud: returning [] here would feed autoResolveStale an empty
    // "current" set and mark every open anomaly of this rule resolved.
    logger.error({ err, ruleKey: rule.key, tenantId }, 'anomaly-engine: rule query failed')
    throw err
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
            a.description_params = $params,
            a.detected_at     = $now,
            a.resolved_at     = null,
            a.tenant_id       = $tenantId
          ON MATCH SET
            a.status          = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.status ELSE 'open' END,
            a.resolved_at     = CASE WHEN a.status IN ['false_positive', 'accepted_risk'] THEN a.resolved_at ELSE null END,
            a.title           = $title,
            a.description     = $description,
            a.description_params = $params,
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
          params:        JSON.stringify(hit.params),
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
  ruleKey: string,
  tenantId: string,
  currentEntityIds: string[],
  reason: 'not_detected' | 'rule_disabled' = 'not_detected',
): Promise<void> {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(tx =>
      tx.run(`
        MATCH (a:Anomaly {tenant_id: $tenantId, rule_key: $ruleKey, status: 'open'})
        WHERE NOT a.entity_id IN $currentEntityIds
        SET a.status = 'resolved', a.resolved_at = $now, a.resolved_reason = $reason
      `, { tenantId, ruleKey, currentEntityIds, now, reason }),
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
        // Revisione totale · D-11: i canali sono nodi del tenant, non appesi al
        // nodo Tenant con una relazione HAS_CHANNEL che non esiste in nessun
        // punto del prodotto — la notifica non partiva mai, e in silenzio.
        MATCH (c:NotificationChannel {tenant_id: $tenantId})
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
  titles: Map<string, string>,
): Promise<void> {
  const totalNew = [...newByRule.values()].reduce((a, b) => a + b, 0)
  if (totalNew === 0) return

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 Anomalies found in the graph (${totalNew} new)`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Tenant: \`${tenantId}\`\n*Anomaly scanner* found new anomalies in the CMDB graph.`,
      },
    },
  ]

  const fields: unknown[] = []
  for (const [ruleKey, count] of newByRule.entries()) {
    if (count > 0) {
      fields.push({ type: 'mrkdwn', text: `*${titles.get(ruleKey) ?? ruleKey}*\n${count} new anomalies` })
    }
  }

  if (fields.length > 0) {
    blocks.push({ type: 'section', fields })
  }

  blocks.push({ type: 'divider' })

  await sendSlackMessage(
    tenantId,
    webhookUrl,
    null,
    blocks as import('@opengraphity/notifications').SlackBlock[],
  )
}

// ── Job processor ──────────────────────────────────────────────────────────────

/** La regola eseguibile per la configurazione del cliente: i tipi diventano etichette del suo metamodello. */
export function resolveRule(config: AnomalyRuleConfig, options: AnomalyRuleOptions): AnomalyRule {
  // Una configurazione che cita un tipo o una relazione tolti dal metamodello
  // fa fallire la regola dicendolo: filtrarla via lascerebbe la regola a
  // cercare su un perimetro che l'admin non ha scelto.
  const problem = anomalyRuleProblem(config, options)
  if (problem) throw problem
  const labelOf = new Map(options.ciTypes.map((t) => [t.name, t.neo4jLabel]))
  const settings: ResolvedRuleSettings = {
    ...config,
    ciLabels:        config.ciTypes.map((t) => labelOf.get(t)!),
    forbiddenLabels: config.forbidden.map((f) => ({ fromLabel: labelOf.get(f.fromType)!, relation: f.relation, toLabel: labelOf.get(f.toType)! })),
  }
  return buildAnomalyRule(config.ruleKey, settings)
}

export interface TenantScanSummary {
  ruleFailures: number
  /** Per regola: risultati trovati, nuove anomalie, o `disabled`. */
  rules: Array<{ ruleKey: string; title: string; hits: number; created: number; disabled: boolean; error: string | null }>
}

/** Runs every enabled rule for one tenant, with the tenant's configuration. */
export async function scanTenant(tenantId: string): Promise<TenantScanSummary> {
  const newByRule = new Map<string, number>()
  const titles = new Map<string, string>()
  const summary: TenantScanSummary = { ruleFailures: 0, rules: [] }

  const configs = await loadAnomalyRuleConfigs(tenantId)
  const options = await anomalyRuleOptions(tenantId)

  for (const config of configs) {
    try {
      if (!config.enabled) {
        // Regola spenta: le sue anomalie aperte si chiudono dicendo perché,
        // invece di restare aperte per sempre su una regola che non gira più.
        await autoResolveStale(config.ruleKey, tenantId, [], 'rule_disabled')
        summary.rules.push({ ruleKey: config.ruleKey, title: config.ruleKey, hits: 0, created: 0, disabled: true, error: null })
        continue
      }
      const rule = resolveRule(config, options)
      titles.set(rule.key, rule.title)
      const hits = await runRule(rule, tenantId)
      const created = await upsertAnomalies(rule, tenantId, hits)
      await autoResolveStale(rule.key, tenantId, hits.map(h => h.entityId))

      newByRule.set(rule.key, created)
      summary.rules.push({ ruleKey: rule.key, title: rule.title, hits: hits.length, created, disabled: false, error: null })
      if (hits.length > 0 || created > 0) {
        logger.info({ ruleKey: rule.key, tenantId, hits: hits.length, created }, 'anomaly-engine: rule done')
      }
    } catch (err) {
      summary.ruleFailures++
      summary.rules.push({ ruleKey: config.ruleKey, title: config.ruleKey, hits: 0, created: 0, disabled: false, error: err instanceof Error ? err.message : String(err) })
      logger.error({ err, ruleKey: config.ruleKey, tenantId }, 'anomaly-engine: rule failed')
    }
  }

  // Persist scan metadata
  await persistScanStatus(tenantId)

  // Slack notification for new anomalies
  try {
    const totalNew = [...newByRule.values()].reduce((a, b) => a + b, 0)
    if (totalNew > 0) {
      const webhookUrl = await loadSlackWebhookForTenant(tenantId)
      if (webhookUrl) {
        await sendSlackAlert(webhookUrl, tenantId, newByRule, titles)
        logger.info({ tenantId, totalNew }, 'anomaly-engine: slack alert sent')
      }
    }
  } catch (err) {
    logger.error({ err, tenantId }, 'anomaly-engine: slack notification failed')
  }

  return summary
}

export async function anomalyScannerProcessor(job: Job<AnomalyScanJobData>): Promise<void> {
  const requested = job.data?.tenantId
  const tenants = requested ? [{ id: requested }] : await loadTenants()
  logger.info({ count: tenants.length, tenantId: requested ?? null, jobName: job.name }, 'anomaly-engine: scanning tenants')

  let failures = 0
  for (const tenant of tenants) {
    failures += (await scanTenant(tenant.id)).ruleFailures
  }
  if (failures > 0) {
    // Visible failure: the scan status was persisted for the rules that ran,
    // but a job with broken rules must not show up as completed.
    throw new Error(`anomaly-engine: ${failures} rule(s) failed across ${tenants.length} tenant(s) — see log`)
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

export function getAnomalyScannerQueue() {
  return getQueue<AnomalyScanJobData>(ANOMALY_SCANNER_QUEUE)
}

/** Enqueues a scan of ONE tenant (manual trigger). Deduped per tenant per minute. */
export async function enqueueTenantScan(tenantId: string): Promise<void> {
  await getAnomalyScannerQueue().add('scan-manual', { tenantId }, {
    jobId:            `manual-${tenantId}-${Math.floor(Date.now() / 60_000)}`,
    removeOnComplete: true,
  })
}

/** Async: the repeatable job registration is awaited (startup error, not a swallowed rejection). */
export async function startAnomalyScanner(): Promise<Worker<AnomalyScanJobData>> {
  const worker = createWorker<AnomalyScanJobData>(ANOMALY_SCANNER_QUEUE, anomalyScannerProcessor)

  // Repeating job: every hour, all tenants
  await getAnomalyScannerQueue().add(
    'scan',
    {},
    { repeat: { every: 60 * 60_000 }, jobId: 'anomaly-scanner-scan', removeOnComplete: true },
  )

  logger.info('anomaly-scanner started (interval: 1h)')
  return worker
}
