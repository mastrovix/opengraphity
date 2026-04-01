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
    logger.error({ jobName: job?.name, entityId: job?.data.entityId, err: err.message }, '[workflow-jobs] job failed')
  })

  logger.info('[workflow-jobs] worker started')
  return worker
}
