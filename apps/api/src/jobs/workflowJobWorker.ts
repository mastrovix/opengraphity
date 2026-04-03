import { Worker, type Job } from 'bullmq'
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
