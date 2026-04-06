import { randomUUID } from 'crypto'
import path from 'path'
import { Queue, Worker, type Job } from 'bullmq'
import { CronExpressionParser } from 'cron-parser'
import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage, sseManager } from '@opengraphity/notifications'
import { executeReportSection } from '../lib/reportExecutor.js'
import type { ReportSectionDef } from '../lib/reportQueryBuilder.js'
import { logger } from '../lib/logger.js'

// Base path for scheduled report files
// NOTE: email delivery via SMTP is not yet implemented.
//       When email is available, add an email sender here alongside the SSE notification.
const SCHEDULED_REPORTS_DIR = path.join(
  process.env['ATTACHMENT_DIR'] ?? path.resolve('./data/attachments'),
  'scheduled-reports',
)

// ── Redis connection ──────────────────────────────────────────────────────────

const connection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cronMatchesNow(cron: string): boolean {
  try {
    const interval = CronExpressionParser.parse(cron)
    const prev = interval.prev().toDate()
    const now = new Date()
    // Match if the previous tick was within the last 60 seconds
    return Math.abs(now.getTime() - prev.getTime()) < 60_000
  } catch {
    return false
  }
}

type Props = Record<string, unknown>

interface TemplateRow {
  id:                  string
  tenantId:            string
  name:                string
  scheduleChannelId:   string | null
  scheduleRecipients:  string[]
  scheduleFormat:      string
}

async function loadDueTemplates(): Promise<TemplateRow[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate)
        WHERE r.schedule_enabled = true AND r.schedule_cron IS NOT NULL
        RETURN properties(r) AS props
      `),
    )
    return result.records
      .map(rec => rec.get('props') as Props)
      .filter(p => cronMatchesNow(p['schedule_cron'] as string))
      .map(p => ({
        id:                 p['id']                    as string,
        tenantId:           p['tenant_id']             as string,
        name:               p['name']                  as string,
        scheduleChannelId:  p['schedule_channel_id']   as string | null ?? null,
        scheduleRecipients: (p['schedule_recipients']  as string[] | null) ?? [],
        scheduleFormat:     (p['schedule_format']      as string | null) ?? 'pdf',
      }))
  } finally {
    await session.close()
  }
}

async function loadTemplateSections(templateId: string): Promise<ReportSectionDef[]> {
  const session = getSession(undefined, 'READ')
  try {
    const secRes = await session.executeRead(tx =>
      tx.run(`
        MATCH (r:ReportTemplate {id: $templateId})-[:HAS_SECTION]->(s:ReportSection)
        RETURN properties(s) AS props ORDER BY s.order ASC
      `, { templateId }),
    )

    const sections: ReportSectionDef[] = []
    for (const secRow of secRes.records) {
      const p = secRow.get('props') as Props
      const sec: ReportSectionDef = {
        id:            p['id']               as string,
        order:         Math.round(Number(p['order'] ?? 0)),
        title:         p['title']            as string,
        chartType:     p['chart_type']       as string,
        groupByNodeId: p['group_by_node_id'] as string | null ?? null,
        groupByField:  p['group_by_field']   as string | null ?? null,
        metric:        p['metric']           as string,
        metricField:   p['metric_field']     as string | null ?? null,
        limit:         p['limit_val']        as number | null ?? null,
        sortDir:       p['sort_dir']         as string | null ?? null,
        nodes:         [],
        edges:         [],
      }

      const nodeEdgeRes = await session.executeRead(tx =>
        tx.run(`
          MATCH (s:ReportSection {id: $sectionId})
          OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
          OPTIONAL MATCH (n)-[e:REPORT_EDGE]->(m:ReportNode)
            WHERE (s)-[:HAS_NODE]->(m)
          RETURN
            collect(DISTINCT properties(n)) AS nodes,
            collect(DISTINCT {
              edgeProps: properties(e),
              sourceId: n.id,
              targetId: m.id
            }) AS edges
        `, { sectionId: sec.id }),
      )

      if (nodeEdgeRes.records.length) {
        const row = nodeEdgeRes.records[0]
        const rawNodes = row.get('nodes') as Props[]
        const rawEdges = row.get('edges') as Array<{ edgeProps: Props; sourceId: string; targetId: string }>

        sec.nodes = rawNodes.filter(n => n && n['id']).map(n => ({
          id:             n['id']             as string,
          entityType:     n['entity_type']    as string,
          neo4jLabel:     n['neo4j_label']    as string,
          label:          n['label']          as string,
          isResult:       (n['is_result']     as boolean) ?? false,
          isRoot:         (n['is_root']       as boolean) ?? false,
          positionX:      Number(n['position_x'] ?? 0),
          positionY:      Number(n['position_y'] ?? 0),
          filters:        n['filters']        as string | null ?? null,
          selectedFields: n['selected_fields']
            ? JSON.parse(n['selected_fields'] as string) as string[]
            : [],
        }))

        sec.edges = rawEdges
          .filter(e => e && e.edgeProps && e.edgeProps['id'] && e.sourceId && e.targetId)
          .map(e => ({
            id:               e.edgeProps['id']                as string,
            sourceNodeId:     e.sourceId,
            targetNodeId:     e.targetId,
            relationshipType: e.edgeProps['relationship_type'] as string,
            direction:        e.edgeProps['direction']         as string,
            label:            e.edgeProps['label']             as string,
          }))
      }

      sections.push(sec)
    }
    return sections
  } finally {
    await session.close()
  }
}

async function loadChannelWebhook(channelId: string): Promise<string | null> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead(tx =>
      tx.run(`
        MATCH (c:NotificationChannel {id: $channelId})
        WHERE c.platform = 'slack' AND c.active = true
        RETURN c.webhook_url AS webhookUrl LIMIT 1
      `, { channelId }),
    )
    return res.records[0]?.get('webhookUrl') as string | null ?? null
  } finally {
    await session.close()
  }
}

// ── Job processor ──────────────────────────────────────────────────────────────

async function reportSchedulerProcessor(_job: Job) {
  const templates = await loadDueTemplates()
  logger.info({ count: templates.length }, 'report-scheduler: templates due')

  for (const tpl of templates) {
    try {
      const sections = await loadTemplateSections(tpl.id)
      const results  = await Promise.all(
        sections.map(sec => executeReportSection(sec, tpl.tenantId)),
      )

      // ── SSE in-app notification (always) ────────────────────────────────────
      // NOTE: email delivery via SMTP is not yet implemented.
      //       Notification is sent in-app via SSE to all connected users in the tenant.
      //       Recipients list (tpl.scheduleRecipients) is stored for future email delivery.
      const notifId   = randomUUID()
      const timestamp = new Date().toISOString()
      sseManager.sendToTenant(tpl.tenantId, {
        id:          notifId,
        type:        'scheduled_report',
        title:       `Report pronto: ${tpl.name}`,
        message:     `Il report schedulato "${tpl.name}" è stato generato (${results.length} sezione/i).`,
        severity:    'info',
        entity_id:   tpl.id,
        entity_type: 'ReportTemplate',
        timestamp,
        read:        false,
      })
      logger.info(
        { templateId: tpl.id, templateName: tpl.name, recipientCount: tpl.scheduleRecipients.length },
        'report-scheduler: scheduled report generated and notified',
      )

      // ── Update last_scheduled_run ────────────────────────────────────────────
      const updateSession = getSession(undefined, 'WRITE')
      try {
        await updateSession.executeWrite(tx =>
          tx.run(
            `MATCH (r:ReportTemplate {id: $id}) SET r.last_scheduled_run = $now`,
            { id: tpl.id, now: timestamp },
          ),
        )
      } finally {
        await updateSession.close()
      }

      // ── Optional Slack delivery ──────────────────────────────────────────────
      if (tpl.scheduleChannelId) {
        const webhookUrl = await loadChannelWebhook(tpl.scheduleChannelId)
        if (webhookUrl) {
          const blocks: unknown[] = [
            { type: 'header', text: { type: 'plain_text', text: `📊 ${tpl.name}`, emoji: true } },
          ]
          for (const result of results) {
            if (result.chartType === 'kpi') {
              try {
                const d = JSON.parse(result.data) as { value: number; label: string }
                blocks.push({
                  type: 'section',
                  fields: [
                    { type: 'mrkdwn', text: `*${result.title}*` },
                    { type: 'mrkdwn', text: `${d.value}` },
                  ],
                })
              } catch { /* skip malformed kpi */ }
            }
          }
          blocks.push({ type: 'divider' })
          await sendSlackMessage(webhookUrl, null, blocks as import('@opengraphity/notifications').SlackBlock[])
        }
      }
    } catch (err) {
      logger.error({ err, templateId: tpl.id }, 'report-scheduler: error sending report')
    }
  }
}

// ── Queue & Worker ──────────────────────────────────────────────────────────────

export const reportSchedulerQueue = new Queue('report-scheduler', { connection })

export function startReportScheduler() {
  const worker = new Worker('report-scheduler', reportSchedulerProcessor, { connection })

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'report-scheduler worker failed')
  })

  // Repeating job: every 60 seconds
  reportSchedulerQueue.add(
    'check',
    {},
    { repeat: { every: 60_000 }, jobId: 'report-scheduler-check' },
  ).catch((err: unknown) => logger.error({ err }, 'report-scheduler: failed to add repeating job'))

  logger.info('report-scheduler started')
  return worker
}
