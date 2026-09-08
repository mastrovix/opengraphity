import type { Worker, Job } from 'bullmq'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import * as incidentService from '../services/incidentService.js'
import { logger } from '../lib/logger.js'
import { ValidationError } from '../lib/errors.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { evaluateConditions, parseConditions } from '../lib/conditionEvaluator.js'
import { executeActions, parseActions, type ActionExecutionContext } from '../lib/actionExecutor.js'
import { assertSafeOutboundUrl, loggableUrl } from '../lib/safeUrl.js'

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

// SSRF protection: shared assertSafeOutboundUrl (lib/safeUrl.ts → @opengraphity/events).

// ── auto_close dispatch per entity type (A-12) ────────────────────────────────

/**
 * Publishes the domain "closed" event for the entity after its workflow
 * transition. Only incidents have a closing service today: for every other
 * entity type the job fails with an explicit ValidationError instead of
 * publishing `incident.closed` for a problem/change (which is what happened
 * before — wrong event, wrong payload loader).
 */
async function publishAutoClose(entityType: string, entityId: string, tenantId: string): Promise<void> {
  switch (entityType) {
    case 'incident':
      await incidentService.closeIncident(entityId, { tenantId, userId: 'system' })
      return
    case 'problem':
    case 'change':
    case 'service_request':
      throw new ValidationError(
        `[workflow-jobs] auto_close is not implemented for entity type "${entityType}" (entity ${entityId}): ` +
        'no closing service exists for it — only incidentService.closeIncident. Remove the schedule_job(auto_close) ' +
        'action from that workflow or implement the service.',
      )
    default:
      throw new ValidationError(`[workflow-jobs] auto_close: unknown entity type "${entityType}" (entity ${entityId})`)
  }
}

const AUTO_CLOSE_SUPPORTED = new Set(['incident'])

// ── Processor ─────────────────────────────────────────────────────────────────

async function processWorkflowJob(job: Job<WorkflowJobData>): Promise<void> {
  const { entityId, tenantId, instanceId } = job.data
  logger.info({ jobName: job.name, entityId, tenantId }, '[workflow-jobs] processing')

  switch (job.name) {
    case 'auto_close': {
      // 1. Transizione workflow → terminal step 'closed-like' in Neo4j
      let entityType: string
      const session = getSession(undefined, 'WRITE')
      try {
        const { getWorkflowSteps } = await import('../lib/workflowHelpers.js')
        // The job is scheduled from an entity-specific step, so we resolve the
        // workflow's entity_type via the instance, then pick the step marked
        // as closure (category='closed' preferred, else first terminal).
        const wiRes = await session.executeRead((tx) => tx.run(`
          MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
          RETURN wi.entity_type AS entityType
        `, { instanceId, tenantId }))
        const found = wiRes.records[0]?.get('entityType') as string | undefined
        if (!found) {
          logger.warn({ instanceId, entityId }, '[workflow-jobs] auto_close: workflow instance not found')
          return
        }
        entityType = found

        // Dispatch check BEFORE the transition: failing after it would leave
        // the entity closed with no event, and every retry would then fail
        // on the (already done) transition.
        if (!AUTO_CLOSE_SUPPORTED.has(entityType)) {
          await publishAutoClose(entityType, entityId, tenantId)  // throws ValidationError
        }

        const steps = await getWorkflowSteps(session, tenantId, entityType)
        const target =
          steps.find((s) => s.category === 'closed') ??
          steps.find((s) => s.isTerminal)
        if (!target) {
          logger.warn({ entityType, entityId }, '[workflow-jobs] auto_close: no terminal step found')
          return
        }
        const result = await workflowEngine.transition(
          session,
          { instanceId, toStepName: target.name, triggeredBy: 'system', triggerType: 'automatic' },
          { userId: 'system', entityData: {} },
        )
        if (!result.success) {
          // Throw → the job fails and BullMQ retries; a silent return would
          // mark it completed and the incident would never auto-close.
          throw new Error(`[workflow-jobs] auto_close transition failed for ${entityId}: ${result.error ?? 'unknown error'}`)
        }
      } finally {
        await session.close()
      }

      // 2. Pubblica evento domain <entity>.closed (notifiche, audit)
      await publishAutoClose(entityType, entityId, tenantId)
      logger.info({ entityId, entityType }, '[workflow-jobs] auto_close completed')
      break
    }

    case 'webhook_retry': {
      const d = job.data as unknown as WebhookRetryData

      // SSRF check — a blocked/invalid URL throws: the job fails visibly
      // (and stops retrying via BullMQ's attempts) instead of a silent break.
      await assertSafeOutboundUrl(d.url)
      const host = loggableUrl(d.url)

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
        logger.info({ host, status: res.status, attempt: d.attempt }, '[webhook_retry] succeeded')
      } catch (err) {
        logger.error({ host, attempt: d.attempt, err }, '[webhook_retry] attempt failed')
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
        const failed = results.find(r => !r.success)
        if (failed) {
          // Partial failure must be visible: the job fails (BullMQ retry
          // policy decides what happens next) instead of a green job that
          // silently ran zero actions.
          throw new Error(`[trigger_timer] action "${failed.action}" failed for trigger ${triggerId} on ${entityId}: ${failed.error ?? 'unknown error'} (${successCount}/${results.length} actions ran)`)
        }
        logger.info({ triggerId, entityId, triggerName: trigger['name'], actionsRun: successCount }, '[trigger_timer] executed')
      } finally {
        await session.close()
      }
      break
    }

    default:
      throw new Error(`[workflow-jobs] unknown job "${job.name}" (entityId=${entityId})`)
  }
}

// ── Notification jobs worker ──────────────────────────────────────────────────

async function processNotificationJob(job: Job): Promise<void> {
  switch (job.name) {
    case 'escalation_check': {
      const { incidentId, tenantId, ruleId } = job.data as { incidentId: string; tenantId: string; ruleId: string }
      const session = getSession(undefined, 'READ')
      try {
        const { isEntityOpen } = await import('../lib/workflowHelpers.js')
        const open = await isEntityOpen(session, incidentId, tenantId)
        if (open) {
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
      const { instanceId, toStep } = job.data as { instanceId: string; toStep: string; tenantId: string }
      const session = getSession(undefined, 'WRITE')
      try {
        const result = await workflowEngine.transition(
          session,
          { instanceId, toStepName: toStep, triggeredBy: 'timer', triggerType: 'automatic' },
          { userId: 'system', entityData: {} },
        )
        if (!result.success) {
          logger.error({ instanceId, toStep, error: result.error }, '[notification-jobs] timer_wait transition failed')
          throw new Error(`timer_wait transition failed for instance ${instanceId} → ${toStep}: ${result.error ?? 'unknown'}`)
        }
        logger.info({ instanceId, toStep }, '[notification-jobs] timer_wait transition completed')
      } finally {
        await session.close()
      }
      break
    }

    default:
      throw new Error(`[notification-jobs] unknown job "${job.name}"`)
  }
}

export const NOTIFICATION_JOBS_QUEUE = 'notification-jobs'
export const WORKFLOW_JOBS_QUEUE     = 'workflow-jobs'

export function startNotificationJobWorker(): Worker {
  getQueue(NOTIFICATION_JOBS_QUEUE)  // register the producer singleton (metrics + scheduleEscalationCheck)
  return createWorker(NOTIFICATION_JOBS_QUEUE, processNotificationJob, { concurrency: 3 })
}

/**
 * Enqueues a delayed escalation check. Awaited by the caller: a failed
 * enqueue (Redis down) must surface where the incident is created, not
 * vanish as an unhandled rejection (A-13).
 */
export async function scheduleEscalationCheck(incidentId: string, tenantId: string, ruleId: string, delayMinutes: number): Promise<void> {
  await getQueue(NOTIFICATION_JOBS_QUEUE).add(
    'escalation_check',
    { incidentId, tenantId, ruleId },
    { delay: delayMinutes * 60 * 1000, jobId: `escalation:${incidentId}:${ruleId}`, removeOnComplete: true },
  )
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startWorkflowJobWorker(): Worker<WorkflowJobData> {
  getQueue(WORKFLOW_JOBS_QUEUE)  // producer singleton (packages/workflow actions + triggerEngine timers)
  return createWorker<WorkflowJobData>(WORKFLOW_JOBS_QUEUE, processWorkflowJob, {
    concurrency: 5,
    onFailed: (job, err) => {
      if (job?.name === 'webhook_retry' && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) {
        logger.error({
          jobName:  job.name,
          host:     loggableUrl(String((job.data as Record<string, unknown>)['url'] ?? '')),
          attempts: job.attemptsMade,
          err:      err.message,
        }, '[webhook_retry] all retries exhausted')
      }
    },
  })
}
