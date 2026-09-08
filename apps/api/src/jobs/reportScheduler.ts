/**
 * Scheduled reports (C-09).
 *
 * Every minute the `check` job loads the templates whose cron fired since
 * their last scheduled run, CLAIMS each one atomically
 * (`SET r.last_scheduled_run` guarded by `WHERE … < $dueAt`) and only then
 * executes it. Two replicas or a delayed tick can no longer run the same
 * template twice, and a tick delayed by a few minutes no longer skips it.
 *
 * Delivery: in-app SSE notification + optional Slack summary of the KPI
 * sections. No file is generated (the PDF/Excel generators live inside the
 * exportReport resolvers and are not reusable here yet), so the message says
 * "Report eseguito", not "Report pronto".
 */
import { randomUUID } from 'crypto'
import type { Worker, Job } from 'bullmq'
import { CronExpressionParser } from 'cron-parser'
import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage, sseManager } from '@opengraphity/notifications'
import { executeReportSection } from '../lib/reportExecutor.js'
import { loadTemplateSections } from '../lib/reportTemplates.js'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'

export const REPORT_SCHEDULER_QUEUE = 'report-scheduler'

/**
 * How far back a missed tick is still honoured. A worker that was down for
 * a few minutes catches up; after a long outage the stale run is skipped
 * (logged) rather than fired at a random time.
 */
const CATCH_UP_WINDOW_MS = 10 * 60_000

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Previous fire time of the cron, or null when it is older than the catch-up
 * window. Throws on an invalid cron expression: returning null would disable
 * the scheduled report FOREVER without any visible error.
 */
export function previousDueAt(cron: string, now: Date = new Date(), tz?: string): Date | null {
  // No tz → the process timezone, as before (schedule_cron is entered by the tenant in wall-clock time).
  const interval = CronExpressionParser.parse(cron, { currentDate: now, ...(tz ? { tz } : {}) })  // throws on invalid cron
  const prev = interval.prev().toDate()
  return now.getTime() - prev.getTime() <= CATCH_UP_WINDOW_MS ? prev : null
}

type Props = Record<string, unknown>

interface TemplateRow {
  id:                string
  tenantId:          string
  name:              string
  scheduleChannelId: string | null
  /** The cron tick this run is for (ISO). */
  dueAt:             string
}

async function loadDueTemplates(now: Date): Promise<TemplateRow[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate)
        WHERE r.schedule_enabled = true AND r.schedule_cron IS NOT NULL
        RETURN properties(r) AS props
      `),
    )
    const due: TemplateRow[] = []
    for (const rec of result.records) {
      const p = rec.get('props') as Props
      let dueAt: Date | null
      try {
        dueAt = previousDueAt(p['schedule_cron'] as string, now)
      } catch (err) {
        // One template's corrupt cron must not kill scheduling for every
        // other template — but it must be LOUD, not a silent disable.
        logger.error({ err, templateId: p['id'], name: p['name'], cron: p['schedule_cron'] },
          '[reportScheduler] invalid schedule_cron — scheduled report will NEVER run until fixed')
        continue
      }
      if (!dueAt) continue
      const lastRun = p['last_scheduled_run'] as string | null | undefined
      if (lastRun && lastRun >= dueAt.toISOString()) continue  // this tick already ran (pre-filter; the claim below is authoritative)
      due.push({
        id:                p['id']                  as string,
        tenantId:          p['tenant_id']           as string,
        name:              p['name']                as string,
        scheduleChannelId: (p['schedule_channel_id'] as string | null) ?? null,
        dueAt:             dueAt.toISOString(),
      })
    }
    return due
  } finally {
    await session.close()
  }
}

/**
 * Atomic claim: sets last_scheduled_run only if nobody did it for this tick.
 * Returns false when another replica/tick already owns the run.
 */
async function claimScheduledRun(tpl: TemplateRow, now: string): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $id, tenant_id: $tenantId})
        WHERE r.last_scheduled_run IS NULL OR r.last_scheduled_run < $dueAt
        SET r.last_scheduled_run = $now
        RETURN r.id AS id
      `, { id: tpl.id, tenantId: tpl.tenantId, dueAt: tpl.dueAt, now }),
    )
    return res.records.length > 0
  } finally {
    await session.close()
  }
}

async function loadChannelWebhook(channelId: string, tenantId: string): Promise<string | null> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead(tx =>
      tx.run(`
        MATCH (c:NotificationChannel {id: $channelId, tenant_id: $tenantId})
        WHERE c.platform = 'slack' AND c.active = true
        RETURN c.webhook_url AS webhookUrl LIMIT 1
      `, { channelId, tenantId }),
    )
    return res.records[0]?.get('webhookUrl') as string | null ?? null
  } finally {
    await session.close()
  }
}

// ── Slack summary ─────────────────────────────────────────────────────────────

interface SectionResult { title: string; chartType: string; data: string }

/**
 * Builds the Slack blocks for the KPI sections. A KPI whose stored data is
 * not the expected `{ value, label }` JSON is a broken section, not noise:
 * it is logged with its title and counted, and the summary says how many
 * were unreadable.
 */
export function buildSlackSummary(templateName: string, templateId: string, results: SectionResult[]): { blocks: unknown[]; malformedKpi: number } {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${templateName}`, emoji: true } },
  ]
  let malformedKpi = 0
  for (const result of results) {
    if (result.chartType !== 'kpi') continue
    let d: { value: unknown }
    try {
      d = JSON.parse(result.data) as { value: unknown }
    } catch (err) {
      malformedKpi++
      logger.error({ err, templateId, section: result.title }, '[reportScheduler] KPI section data is not valid JSON — section skipped in Slack summary')
      continue
    }
    if (d == null || typeof d !== 'object' || !('value' in d)) {
      malformedKpi++
      logger.error({ templateId, section: result.title, data: result.data.slice(0, 200) }, '[reportScheduler] KPI section data has no `value` — section skipped in Slack summary')
      continue
    }
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*${result.title}*` },
        { type: 'mrkdwn', text: `${String(d.value)}` },
      ],
    })
  }
  if (malformedKpi > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚠ ${malformedKpi} sezione/i KPI non leggibili — vedi log API` }] })
  }
  blocks.push({ type: 'divider' })
  return { blocks, malformedKpi }
}

// ── Job processor ──────────────────────────────────────────────────────────────

async function reportSchedulerProcessor(_job: Job) {
  const now = new Date()
  const templates = await loadDueTemplates(now)
  logger.info({ count: templates.length }, 'report-scheduler: templates due')

  let failures = 0
  for (const tpl of templates) {
    try {
      const timestamp = now.toISOString()
      const claimed = await claimScheduledRun(tpl, timestamp)
      if (!claimed) {
        logger.info({ templateId: tpl.id, dueAt: tpl.dueAt }, 'report-scheduler: run already claimed for this tick — skipped')
        continue
      }

      const readSession = getSession(undefined, 'READ')
      let sections
      try { sections = await loadTemplateSections(readSession, tpl.id, tpl.tenantId) }
      finally { await readSession.close() }
      const results  = await Promise.all(
        sections.map(sec => executeReportSection(sec, tpl.tenantId)),
      )

      // ── SSE in-app notification (always) ────────────────────────────────────
      sseManager.sendToTenant(tpl.tenantId, {
        id:          randomUUID(),
        type:        'scheduled_report',
        title:       `Report eseguito: ${tpl.name}`,
        message:     `Il report schedulato "${tpl.name}" è stato eseguito (${results.length} sezione/i).`,
        severity:    'info',
        entity_id:   tpl.id,
        entity_type: 'ReportTemplate',
        timestamp,
        read:        false,
      })

      // ── Optional Slack delivery ──────────────────────────────────────────────
      let malformedKpi = 0
      if (tpl.scheduleChannelId) {
        const webhookUrl = await loadChannelWebhook(tpl.scheduleChannelId, tpl.tenantId)
        if (webhookUrl) {
          const summary = buildSlackSummary(tpl.name, tpl.id, results)
          malformedKpi = summary.malformedKpi
          await sendSlackMessage(webhookUrl, null, summary.blocks as import('@opengraphity/notifications').SlackBlock[])
        } else {
          logger.warn({ templateId: tpl.id, channelId: tpl.scheduleChannelId }, 'report-scheduler: schedule channel not found/inactive in tenant — Slack delivery skipped')
        }
      }

      logger.info(
        { templateId: tpl.id, templateName: tpl.name, sections: results.length, malformedKpi, dueAt: tpl.dueAt },
        'report-scheduler: scheduled report executed',
      )
    } catch (err) {
      failures++
      logger.error({ err, templateId: tpl.id }, 'report-scheduler: error executing report')
    }
  }
  if (failures > 0) {
    // The claim already happened, so a retry of this tick will not re-run the
    // failed template; the job must still fail visibly (failed count in BullMQ).
    throw new Error(`report-scheduler: ${failures}/${templates.length} scheduled report(s) failed — see log`)
  }
}

// ── Queue & Worker ──────────────────────────────────────────────────────────────

export function getReportSchedulerQueue() {
  return getQueue(REPORT_SCHEDULER_QUEUE)
}

/** Async: the repeatable job registration is awaited (startup error, not a swallowed rejection). */
export async function startReportScheduler(): Promise<Worker> {
  const worker = createWorker(REPORT_SCHEDULER_QUEUE, reportSchedulerProcessor)

  // Repeating job: every 60 seconds
  await getReportSchedulerQueue().add(
    'check',
    {},
    { repeat: { every: 60_000 }, jobId: 'report-scheduler-check', removeOnComplete: true },
  )

  logger.info('report-scheduler started')
  return worker
}
