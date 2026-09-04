/**
 * Automatic escalation on SLA / OLA-UC breach.
 *
 * When an SLA or OLA/UC breach fires and the entity's current workflow step has
 * an outgoing transition marked `trigger: 'sla_breach'` (e.g. the incident
 * workflow's in_progress → escalated), this consumer executes that transition
 * automatically. Previously the `sla_breach` trigger was declared in the seed
 * but nothing ever fired it — the escalation never happened.
 *
 * The transition is self-guarding: if the entity already moved on (resolved,
 * closed, already escalated), its current step has no `sla_breach` transition,
 * so this is a no-op. That also makes it idempotent across event redeliveries
 * and across the sla.breached + ola.breached pair.
 */
import { BaseConsumer, publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../lib/logger.js'

const BREACH_EVENTS = new Set(['sla.breached', 'ola.breached'])

export class EscalationConsumer extends BaseConsumer<unknown> {
  constructor() {
    super('escalation-consumer')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    if (!BREACH_EVENTS.has(event.type)) return

    const payload  = event.payload as { entity_id?: string; id?: string }
    const entityId = payload.entity_id ?? payload.id
    if (!entityId) return
    const tenantId = event.tenant_id

    const session = getSession(undefined, 'WRITE')
    try {
      // Find a 'sla_breach'-triggered transition out of the entity's current
      // step. No row → no escalation defined for this state → nothing to do.
      const res = await session.executeRead((tx) =>
        tx.run(`
          MATCH (e {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
          MATCH (cur:WorkflowStep {definition_id: wi.definition_id, name: wi.current_step})
                -[:TRANSITIONS_TO {trigger: 'sla_breach'}]->(to:WorkflowStep)
          RETURN wi.id AS instanceId, wi.entity_type AS entityType, wi.current_step AS fromStep,
                 to.name AS toStep, e.title AS title, e.severity AS severity
          LIMIT 1
        `, { entityId, tenantId }),
      )
      if (!res.records.length) return

      const r          = res.records[0]!
      const instanceId = r.get('instanceId') as string
      const entityType = r.get('entityType') as string
      const fromStep   = r.get('fromStep')   as string
      const toStep     = r.get('toStep')     as string

      const result = await workflowEngine.transition(
        session,
        { instanceId, toStepName: toStep, triggeredBy: 'sla-engine', triggerType: 'sla_breach' },
        { userId: 'system', entityData: {} },
      )
      if (!result.success) {
        logger.error({ instanceId, toStep, error: result.error }, '[escalation] auto-escalation transition failed')
        return
      }

      // Publish the step-entered event so the notification rules fire
      // (e.g. incident.escalated → in_app + slack). id + title are required by
      // the incident channel dispatcher.
      await publish({
        id:             uuidv4(),
        type:           `${entityType}.${toStep}`,
        tenant_id:      tenantId,
        timestamp:      new Date().toISOString(),
        correlation_id: event.correlation_id ?? uuidv4(),
        actor_id:       'sla-engine',
        payload: {
          id:          entityId,
          entity_id:   entityId,
          entity_type: entityType,
          title:       (r.get('title') as string | null) ?? `${entityType} ${entityId}`,
          severity:    (r.get('severity') as string | null) ?? 'high',
          status:      toStep,
          reason:      event.type === 'ola.breached' ? 'ola_breach' : 'sla_breach',
        },
      })

      logger.warn(
        { entityType, entityId, fromStep, toStep, trigger: event.type },
        '[escalation] auto-escalated on breach',
      )
    } catch (err) {
      logger.error({ err, entityId, eventType: event.type }, '[escalation] processing failed')
      throw err   // let BaseConsumer retry — a lost escalation must not be silent
    } finally {
      await session.close()
    }
  }
}
