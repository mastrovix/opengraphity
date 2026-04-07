import { Worker, Queue, type Job } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import * as incidentService from '../services/incidentService.js'
import { logger } from '../lib/logger.js'
import { evaluateConditions, parseConditions } from '../lib/conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext } from '../lib/actionExecutor.js'

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

    case 'trigger_timer': {
      const { triggerId, entityType } = job.data as unknown as { triggerId: string; entityType: string; entityId: string; tenantId: string }

      // 1. Load the trigger definition
      const session = getSession(undefined, 'WRITE')
      try {
        const triggerRows = await runQuery<{ props: Record<string, unknown> }>(session, `
          MATCH (t:AutoTrigger {id: $triggerId, tenant_id: $tenantId, enabled: true})
          RETURN properties(t) AS props
        `, { triggerId, tenantId })

        if (triggerRows.length === 0) {
          logger.info({ triggerId, entityId }, '[trigger_timer] trigger not found or disabled — skipped')
          break
        }

        const trigger = triggerRows[0].props

        // 2. Load the current entity (with relationships for assigned_to check)
        const entityRows = await runQuery<{ props: Record<string, unknown>; assignedTo: string | null; assignedTeam: string | null }>(session, `
          MATCH (e {id: $entityId, tenant_id: $tenantId})
          OPTIONAL MATCH (e)-[:ASSIGNED_TO]->(u)
          OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t)
          RETURN properties(e) AS props, u.id AS assignedTo, t.id AS assignedTeam
        `, { entityId, tenantId })

        if (entityRows.length === 0) {
          logger.info({ entityId }, '[trigger_timer] entity not found — skipped')
          break
        }

        const entity: Record<string, unknown> = { ...entityRows[0].props, assigned_to: entityRows[0].assignedTo, assigned_team: entityRows[0].assignedTeam }

        // 3. Evaluate conditions — they might no longer be true
        const conditions = parseConditions(trigger['conditions'] as string | null)

        // DEBUG: log every condition evaluation
        logger.info({ entityKeys: Object.keys(entity), assigned_to: entity['assigned_to'], assigned_to_type: typeof entity['assigned_to'], status: entity['status'], status_type: typeof entity['status'] }, '[trigger_timer] DEBUG entity fields')
        logger.info({ rawConditions: trigger['conditions'], parsedConditions: conditions }, '[trigger_timer] DEBUG conditions')
        for (const c of conditions) {
          const actual = entity[c.field]
          const isNull = actual == null || actual === ''
          logger.info({ field: c.field, operator: c.operator, expected: c.value ?? '(none)', actual, actualType: typeof actual, actualIsNull: actual === null, actualIsUndefined: actual === undefined, actualIsEmpty: actual === '', isNullResult: isNull }, '[trigger_timer] DEBUG condition eval')
        }

        if (!evaluateConditions(conditions, entity)) {
          logger.info({ triggerId, entityId, triggerName: trigger['name'] }, '[trigger_timer] conditions no longer met — skipped')
          break
        }

        // 4. Execute actions
        const actions = parseActions(trigger['actions'] as string | null)
        const execCtx: ActionExecutionContext = {
          tenantId, userId: 'system', entityId, entityType,
          entity, source: 'trigger', sourceName: trigger['name'] as string,
        }
        const results = await executeActions(actions, execCtx)

        // 5. Update execution count
        await runQuery(session, `
          MATCH (t:AutoTrigger {id: $triggerId, tenant_id: $tenantId})
          SET t.execution_count = coalesce(t.execution_count, 0) + 1,
              t.last_executed_at = $now
        `, { triggerId, tenantId, now: new Date().toISOString() })

        const successCount = results.filter(r => r.success).length
        logger.info({ triggerId, entityId, triggerName: trigger['name'], actionsRun: successCount }, '[trigger_timer] executed')
      } finally {
        await session.close()
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
