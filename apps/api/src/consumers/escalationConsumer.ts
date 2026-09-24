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
import { v4 as uuidv4 } from 'uuid'
import { logger } from '../lib/logger.js'
import { matchById } from '../lib/cypherLookups.js'
import { transitionTicket } from '../services/ticketTransition.js'

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
          ${matchById('e', { labels: 'entities', id: '$entityId' })}
          MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
          // tenant-ok(traversal): step della definizione dell'istanza dell'entità scopata
          MATCH (cur:WorkflowStep {definition_id: wi.definition_id, name: wi.current_step})
                -[:TRANSITIONS_TO {trigger: 'sla_breach'}]->(to:WorkflowStep)
          RETURN wi.id AS instanceId, wi.entity_type AS entityType, wi.current_step AS fromStep,
                 to.name AS toStep, e.title AS title,
                 // La gravità VERA dell'entità: gli incident la tengono in
                 // severity, problem/change/richieste in priority, e l'alias
                 // pubblicato qui inventava «high» per tutti (revisione totale
                 // · C-16): la notifica diceva una gravità che il dato non ha.
                 coalesce(e.severity, e.priority) AS severity,
                 coalesce(e.number, e.code) AS number
          LIMIT 1
        `, { entityId, tenantId }),
      )
      if (!res.records.length) return

      const r          = res.records[0]!
      const instanceId = r.get('instanceId') as string
      const entityType = r.get('entityType') as string
      const fromStep   = r.get('fromStep')   as string
      const toStep     = r.get('toStep')     as string

      // The guards of every path (wave 7 · B1): the release window of a change
      // (an `sla_breach` arc into the scheduled step put an unapproved change in
      // production), the approval named by the step, the required fields.
      const outcome = await transitionTicket(session, {
        tenantId, instanceId, toStep,
        actor: { kind: 'system', path: 'escalation', userId: 'sla-engine' },
        triggerType: 'sla_breach',
      })
      if (!outcome.moved) {
        /**
         * RIFIUTATA DA UNA GUARDIA ≠ ANDATA STORTA (rimedio, 20 set 2026).
         *
         * Rilanciare faceva ritentare BullMQ, ma una guardia non dipende dal
         * tempo: dipende da qualcuno che chiuda un compito o completi un
         * assessment. I tentativi si esaurivano, l'evento finiva marcato
         * «lost», e **l'incident che doveva escalare non escalava** senza
         * che comparisse niente sul ticket. The pipeline writes the refusal
         * on the ticket, where whoever waited for the escalation sees it, and
         * the event closes without a retry. An error that is not a refusal
         * is thrown: the queue retries it.
         */
        if (outcome.refusal.final) return
        throw new Error(`[escalation] transition to ${toStep} failed for instance ${instanceId}: ${outcome.refusal.message}`)
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
          // Il titolo vero, o il numero del ticket: «incident <uuid>» non è un
          // titolo, è un id travestito (C-16).
          title:       (r.get('title') as string | null)
                       ?? (r.get('number') as string | null)
                       ?? `${entityType} ${entityId}`,
          // `unknown` si vede che è un ripiego; «high» sembrava un dato.
          severity:    (r.get('severity') as string | null) ?? 'unknown',
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
