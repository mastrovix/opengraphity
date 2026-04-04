import { Worker, Queue, type Job } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import * as incidentService from '../services/incidentService.js'
import { logger } from '../lib/logger.js'

// ── Job data shape produced by packages/workflow/src/actions.ts ───────────────

interface WorkflowJobData {
  instanceId: string
  entityId:   string
  tenantId:   string
  job:        string
}

// ── Webhook retry job data (mirrors WebhookRetryJobData from packages/workflow) ─

interface WebhookRetryData {
  type:     'webhook_retry'
  url:      string
  method:   string
  headers:  Record<string, string>
  payload:  string
  attempt:  number
  tenantId: string
  entityId: string
}

// ── SSRF protection (mirrors PRIVATE_IP_RE from packages/workflow/src/actions.ts) ─

const PRIVATE_IP_RE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/,
]

// ── Processor ─────────────────────────────────────────────────────────────────

async function processWorkflowJob(job: Job<WorkflowJobData>): Promise<void> {
  const { entityId, tenantId, instanceId } = job.data
  logger.info({ jobName: job.name, entityId, tenantId }, '[workflow-jobs] processing')

  switch (job.name) {
    case 'auto_close': {
      // 1. Transizione workflow → "closed" in Neo4j (aggiorna step, esegue exit/enter actions)
      const session = getSession(undefined, 'WRITE')
      try {
        const result = await workflowEngine.transition(
          session,
          { instanceId, toStepName: 'closed', triggeredBy: 'system', triggerType: 'automatic' },
          { userId: 'system', entityData: {} },
        )
        if (!result.success) {
          logger.warn({ entityId, error: result.error }, '[workflow-jobs] auto_close transition failed — skipping event')
          return
        }
      } finally {
        await session.close()
      }

      // 2. Pubblica evento domain incident.closed (notifiche, audit)
      await incidentService.closeIncident(entityId, { tenantId, userId: 'system' })
      logger.info({ entityId }, '[workflow-jobs] auto_close completed')
      break
    }

    case 'webhook_retry': {
      const d = job.data as unknown as WebhookRetryData

      // SSRF check
      let parsedUrl: URL
      try { parsedUrl = new URL(d.url) } catch {
        logger.error({ url: d.url }, '[webhook_retry] invalid URL — aborting')
        break
      }
      const hostname = parsedUrl.hostname
      if (hostname === 'localhost' || PRIVATE_IP_RE.some(re => re.test(hostname))) {
        logger.error({ url: d.url }, '[webhook_retry] SSRF URL blocked — aborting')
        break
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        const res = await fetch(d.url, {
          method:  d.method,
          headers: { 'Content-Type': 'application/json', ...d.headers },
          body:    d.method !== 'GET' ? d.payload : undefined,
          signal:  controller.signal,
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        logger.info({ url: d.url, status: res.status, attempt: d.attempt }, '[webhook_retry] succeeded')
      } catch (err) {
        logger.error({ url: d.url, attempt: d.attempt, err }, '[webhook_retry] attempt failed')
        // BullMQ gestisce i retry automaticamente via attempts/backoff config
        throw err  // re-throw so BullMQ knows to retry
      } finally {
        clearTimeout(timer)
      }

      break
    }

    default:
      logger.warn({ jobName: job.name, entityId }, '[workflow-jobs] unknown job — skipped')
  }
}

// ── Notification jobs worker ──────────────────────────────────────────────────

async function processNotificationJob(job: Job): Promise<void> {
  switch (job.name) {
    case 'escalation_check': {
      const { incidentId, tenantId, ruleId } = job.data as { incidentId: string; tenantId: string; ruleId: string }
      const session = getSession(undefined, 'READ')
      try {
        const result = await session.executeRead(tx =>
          tx.run(`MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN i.status AS status`, { id: incidentId, tenantId }),
        )
        const status = result.records[0]?.get('status') as string | undefined
        if (status && !['resolved', 'closed'].includes(status)) {
          logger.info({ incidentId, ruleId }, '[notification-jobs] escalation_check: incident still open, escalation triggered')
          // Escalation notification logic would call notification service here
        } else {
          logger.info({ incidentId }, '[notification-jobs] escalation_check: incident already resolved, skipping')
        }
      } finally {
        await session.close()
      }
      break
    }

    case 'digest': {
      const { ruleId } = job.data as { ruleId: string }
      logger.info({ ruleId }, '[notification-jobs] digest: daily digest job executed')
      // Digest aggregation + notification dispatch would happen here
      break
    }

    case 'timer_wait': {
      const { instanceId, toStep, tenantId } = job.data as { instanceId: string; toStep: string; tenantId: string }
      const session = getSession(undefined, 'WRITE')
      try {
        const result = await workflowEngine.transition(
          session,
          { instanceId, toStepName: toStep, triggeredBy: 'timer', triggerType: 'automatic' },
          { userId: 'system', entityData: {} },
        )
        if (!result.success) {
          logger.warn({ instanceId, toStep, error: result.error }, '[notification-jobs] timer_wait transition failed')
        } else {
          logger.info({ instanceId, toStep }, '[notification-jobs] timer_wait transition completed')
        }
      } finally {
        await session.close()
      }
      break
    }

    default:
      logger.warn({ jobName: job.name }, '[notification-jobs] unknown job — skipped')
  }
}

export function startNotificationJobWorker(): Worker {
  const worker = new Worker('notification-jobs', processNotificationJob, {
    connection:  getRedisOptions(),
    concurrency: 3,
  })
  worker.on('failed', (job, err) => {
    logger.error({ jobName: job?.name, err: err.message }, '[notification-jobs] job failed')
  })
  logger.info('[notification-jobs] worker started')
  return worker
}

// Export queue factory for creating escalation jobs from incident creation
export function scheduleEscalationCheck(incidentId: string, tenantId: string, ruleId: string, delayMinutes: number) {
  const queue = new Queue('notification-jobs', { connection: getRedisOptions() })
  void queue.add('escalation_check', { incidentId, tenantId, ruleId }, { delay: delayMinutes * 60 * 1000 })
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startWorkflowJobWorker(): Worker {
  const worker = new Worker<WorkflowJobData>('workflow-jobs', processWorkflowJob, {
    connection:  getRedisOptions(),
    concurrency: 5,
  })

  worker.on('failed', (job, err) => {
    if (job?.name === 'webhook_retry' && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) {
      logger.error({
        jobName:  job.name,
        url:      (job.data as unknown as Record<string, unknown>)['url'],
        attempts: job.attemptsMade,
        err:      err.message,
      }, '[webhook_retry] all retries exhausted')
    } else {
      logger.error({ jobName: job?.name, entityId: job?.data.entityId, err: err.message }, '[workflow-jobs] job failed')
    }
  })

  logger.info('[workflow-jobs] worker started')
  return worker
}
