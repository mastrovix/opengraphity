import { v4 as uuidv4 } from 'uuid'
import { Queue } from 'bullmq'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type { WorkflowActionConfig, WorkflowInstance } from './types.js'

const redisConnection = {
  host: process.env['REDIS_HOST'] ?? 'localhost',
  port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
}

export async function runAction(
  action: WorkflowActionConfig,
  instance: WorkflowInstance,
  context: { userId: string; notes?: string },
): Promise<void> {
  const now = new Date().toISOString()

  switch (action.type) {

    case 'sla_start': {
      const slaType = action.params['sla_type'] ?? 'resolve'
      const event: DomainEvent<{ entity_id: string; entity_type: string; sla_type: string }> = {
        id:             uuidv4(),
        type:           `sla.${slaType}.start`,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       context.userId,
        payload: {
          entity_id:   instance.entityId,
          entity_type: instance.entityType,
          sla_type:    slaType,
        },
      }
      await publish(event)
      break
    }

    case 'sla_stop':
    case 'sla_pause':
    case 'sla_resume': {
      const slaType = action.params['sla_type'] ?? 'resolve'
      const verb    = action.type.replace('sla_', '')
      const event: DomainEvent<{ entity_id: string; sla_type: string }> = {
        id:             uuidv4(),
        type:           `sla.${slaType}.${verb}`,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       context.userId,
        payload: {
          entity_id: instance.entityId,
          sla_type:  slaType,
        },
      }
      await publish(event)
      break
    }

    case 'notify':
    case 'publish_event': {
      const eventType = action.params['event'] ?? 'incident.unknown'
      const event: DomainEvent<{
        entity_id:    string
        triggered_by: string
        target?:      string
        notes?:       string
      }> = {
        id:             uuidv4(),
        type:           eventType,
        tenant_id:      instance.tenantId,
        timestamp:      now,
        correlation_id: uuidv4(),
        actor_id:       context.userId,
        payload: {
          entity_id:    instance.entityId,
          triggered_by: context.userId,
          ...(action.params['target'] ? { target: action.params['target'] } : {}),
          ...(context.notes          ? { notes: context.notes }             : {}),
        },
      }
      await publish(event)
      break
    }

    case 'schedule_job': {
      const jobName  = action.params['job'] ?? 'unknown'
      const delayMs  = parseInt(action.params['delay_hours'] ?? '0', 10) * 60 * 60 * 1000
      const queue    = new Queue('workflow-jobs', { connection: redisConnection })
      await queue.add(
        jobName,
        {
          instanceId: instance.id,
          entityId:   instance.entityId,
          tenantId:   instance.tenantId,
          job:        jobName,
        },
        {
          delay:             delayMs,
          jobId:             `${jobName}:${instance.entityId}`,
          removeOnComplete:  true,
        },
      )
      await queue.close()
      break
    }

    case 'cancel_job': {
      const jobName = action.params['job'] ?? 'unknown'
      const queue   = new Queue('workflow-jobs', { connection: redisConnection })
      const job     = await queue.getJob(`${jobName}:${instance.entityId}`)
      if (job) await job.remove()
      await queue.close()
      break
    }
  }
}
