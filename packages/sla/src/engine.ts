import { BaseConsumer } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type {
  IncidentCreatedPayload,
  IncidentResolvedPayload,
  RequestCreatedPayload,
  RequestCompletedPayload,
  ProblemCreatedPayload,
  ProblemResolvedPayload,
} from '@opengraphity/types'
import { Message } from 'amqplib'
import { DEFAULT_SLA_POLICIES } from './policy.js'
import { createSLAStatus, getSLAStatus, markResolveMet } from './status.js'
import {
  initScheduler,
  scheduleWarning,
  scheduleBreachCheck,
  scheduleResponseCheck,
  cancelSLAJobs,
} from './scheduler.js'

function findPolicy(entityType: 'incident' | 'change' | 'service_request' | 'problem') {
  return DEFAULT_SLA_POLICIES.find((p) => p.entity_type === entityType) ?? null
}

export class SLAEngine extends BaseConsumer<unknown> {
  constructor() {
    super('sla-engine')
  }

  async process(event: DomainEvent<unknown>, _msg: Message): Promise<void> {
    switch (event.type) {
      case 'incident.created':
        await this.handleEntityCreated(
          event as DomainEvent<IncidentCreatedPayload>,
          'incident',
          (p) => (p as IncidentCreatedPayload).severity,
        )
        break

      case 'incident.resolved':
        await this.handleEntityResolved(
          event as DomainEvent<IncidentResolvedPayload>,
          'incident',
        )
        break

      case 'request.created':
        await this.handleEntityCreated(
          event as DomainEvent<RequestCreatedPayload>,
          'service_request',
          (p) => (p as RequestCreatedPayload).priority,
        )
        break

      case 'request.completed':
        await this.handleEntityResolved(
          event as DomainEvent<RequestCompletedPayload>,
          'service_request',
        )
        break

      case 'problem.created':
        await this.handleEntityCreated(
          event as DomainEvent<ProblemCreatedPayload>,
          'problem',
          (p) => (p as ProblemCreatedPayload).impact,
        )
        break

      case 'problem.resolved':
        await this.handleEntityResolved(
          event as DomainEvent<ProblemResolvedPayload>,
          'problem',
        )
        break

      default:
        console.log(`[sla:engine] Event "${event.type}" — no SLA rule, skipping`)
    }
  }

  private async handleEntityCreated(
    event: DomainEvent<{ id: string }>,
    entityType: 'incident' | 'change' | 'service_request' | 'problem',
    getSeverity: (payload: unknown) => string,
  ): Promise<void> {
    const payload  = event.payload
    const severity = getSeverity(payload)
    const policy   = findPolicy(entityType)

    if (!policy) {
      console.warn(`[sla:engine] No SLA policy for entity type "${entityType}"`)
      return
    }

    const tier = policy.tiers.find((t) => t.severity === severity)
    if (!tier) {
      console.log(
        `[sla:engine] No SLA tier for ${entityType} severity="${severity}" — skipping`,
      )
      return
    }

    const status = await createSLAStatus({
      tenantId:   event.tenant_id,
      entityId:   payload.id,
      entityType,
      severity,
      policy,
    })

    await Promise.all([
      scheduleWarning(status),
      scheduleBreachCheck(status),
      scheduleResponseCheck(status),
    ])

    console.log(
      `[sla:engine] SLA started for ${entityType} ${payload.id}: ` +
        `response by ${status.response_deadline}, resolve by ${status.resolve_deadline}`,
    )
  }

  private async handleEntityResolved(
    event: DomainEvent<{ id: string }>,
    entityType: string,
  ): Promise<void> {
    const { id } = event.payload
    const existing = await getSLAStatus(event.tenant_id, id)

    if (existing) {
      await markResolveMet(event.tenant_id, id)
      await cancelSLAJobs(id)
      console.log(`[sla:engine] SLA closed for ${entityType} ${id}`)
    } else {
      console.log(`[sla:engine] No SLAStatus found for ${entityType} ${id} — skipping`)
    }
  }
}

export async function createSLAEngine(): Promise<SLAEngine> {
  initScheduler()
  const engine = new SLAEngine()
  await engine.start()
  return engine
}
