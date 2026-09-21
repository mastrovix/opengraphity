/**
 * Il consumatore degli eventi di dominio che mette in moto le automazioni
 * (AutoTrigger e Business Rule) — revisione del 14 set 2026 · AU-1.
 *
 * Prima trigger e regole si valutavano in un punto solo: dentro la creazione
 * di incident e problem. Gli eventi «aggiornato», «campo cambiato», «cambio di
 * stato» e «SLA violato», e le change e le richieste, si potevano configurare
 * e non giravano mai. Qui ogni evento offerto ha la sua sorgente:
 *
 *   `incident|problem|change|request.created` → on_create (+ trigger a tempo)
 *   `ticket.updated`                          → on_update, on_field_change
 *   `workflow.step_entered`                   → on_transition
 *   `sla.breached`                            → on_sla_breach
 *
 * Quali combinazioni evento × ticket esistono lo dice una tabella sola
 * (`AUTOMATION_EVENT_ENTITIES`, @opengraphity/types), letta anche dalla
 * validazione in scrittura e dalle pagine.
 *
 * Le automazioni lavorano come `AUTOMATION_ACTOR`, e gli eventi prodotti da
 * quell'attore non rimettono in moto le automazioni: una regola «su
 * aggiornamento» che aggiorna un campo girerebbe all'infinito.
 *
 * Il ticket si rilegge dal grafo: le condizioni valutano lo stato attuale, non
 * quello nel payload dell'evento (che per l'aggiornamento non c'è).
 */
import { BaseConsumer } from '@opengraphity/events'
import {
  AUTOMATION_ACTOR, TICKET_UPDATED_EVENT, WORKFLOW_STEP_ENTERED_EVENT, automationEventSupported,
  type AutomationEntityType, type AutomationEventType, type DomainEvent, type TicketUpdatedPayload,
} from '@opengraphity/types'
import { getSession } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { loadAutomationEntity } from '../lib/automationEntity.js'
import { evaluateTriggers, scheduleTimerTriggers } from '../lib/triggerEngine.js'
import { evaluateBusinessRules } from '../lib/rulesEngine.js'

const log = logger.child({ module: 'automation-consumer' })

const CREATED: Readonly<Record<string, AutomationEntityType>> = {
  'incident.created': 'incident',
  'problem.created':  'problem',
  'change.created':   'change',
  'request.created':  'service_request',
}

export interface AutomationWork {
  entityType:  AutomationEntityType
  entityId:    string
  events:      AutomationEventType[]
  /** Solo per on_field_change: i campi cambiati. */
  changedFields?: string[]
  /** Per on_create: si programmano anche i trigger a tempo. */
  scheduleTimers?: boolean
}

/** Cosa fare per un evento di dominio; `null` se l'evento non riguarda le automazioni. Pura, per i test. */
export function automationWorkFor(event: DomainEvent<unknown>): AutomationWork | null {
  if (event.actor_id === AUTOMATION_ACTOR) return null
  const p = (event.payload ?? {}) as Record<string, unknown>
  const created = CREATED[event.type]
  if (created) {
    const id = typeof p['id'] === 'string' ? p['id'] : null
    return id ? { entityType: created, entityId: id, events: ['on_create'], scheduleTimers: true } : null
  }
  const entityType = p['entity_type'] as AutomationEntityType | undefined
  const entityId   = typeof p['entity_id'] === 'string' ? p['entity_id'] : null
  if (!entityType || !entityId) return null
  if (event.type === TICKET_UPDATED_EVENT) {
    const changed = (p as unknown as TicketUpdatedPayload).changed_fields ?? []
    if (changed.length === 0) return null
    return { entityType, entityId, events: ['on_update', 'on_field_change'], changedFields: changed }
  }
  if (event.type === WORKFLOW_STEP_ENTERED_EVENT) return { entityType, entityId, events: ['on_transition'] }
  if (event.type === 'sla.breached') return { entityType, entityId, events: ['on_sla_breach'] }
  return null
}

export class AutomationConsumer extends BaseConsumer<unknown> {
  constructor() {
    super('automation-consumer')
  }

  async process(event: DomainEvent<unknown>): Promise<void> {
    const work = automationWorkFor(event)
    if (!work) return
    const events = work.events.filter((e) => automationEventSupported(e, work.entityType))
    if (events.length === 0) return

    const session = getSession(undefined, 'READ')
    let entity: Record<string, unknown> | null
    try {
      entity = await loadAutomationEntity(session, event.tenant_id, work.entityType, work.entityId)
    } finally {
      await session.close()
    }
    if (!entity) {
      log.info({ tenantId: event.tenant_id, entityType: work.entityType, entityId: work.entityId, eventType: event.type }, 'ticket no longer exists: automations skipped')
      return
    }

    // PRIMA l'accodamento dei timer, POI le azioni (revisione totale · C-36).
    // I job hanno un `jobId` deterministico, quindi accodarli due volte non
    // ne crea due; le azioni delle regole invece NON sono idempotenti
    // (commento, webhook, notifica, assegnazione). Con l'ordine inverso un
    // errore dell'accodamento — Redis in affanno — faceva ritentare l'evento
    // e rieseguire le azioni: due commenti identici e due webhook.
    if (work.scheduleTimers) await scheduleTimerTriggers(event.tenant_id, work.entityType, work.entityId)
    // Le regole di notifica «Escalation» partono dalla nascita dell'incident (NT-8).
    if (work.scheduleTimers && work.entityType === 'incident') {
      const { scheduleNotificationEscalations } = await import('../lib/notificationEscalation.js')
      await scheduleNotificationEscalations(event.tenant_id, work.entityId)
    }

    for (const eventType of events) {
      if (eventType === 'on_transition' || (eventType === 'on_create') || eventType === 'on_update') {
        // V-19: «è cambiato» legge i campi cambiati, che esistono solo per l'aggiornamento.
        const rules = await evaluateBusinessRules(event.tenant_id, work.entityType, eventType, entity, AUTOMATION_ACTOR,
          eventType === 'on_update' ? { changedFields: work.changedFields ?? [] } : undefined)
        for (const r of rules) if (r.error) log.error({ tenantId: event.tenant_id, rule: r.ruleName, entityId: work.entityId, error: r.error }, 'business rule failed')
      }
      if (eventType !== 'on_transition') {
        const triggers = await evaluateTriggers(event.tenant_id, work.entityType, eventType, entity, AUTOMATION_ACTOR,
          eventType === 'on_field_change' || eventType === 'on_update' ? { changedFields: work.changedFields ?? [] } : undefined)
        for (const t of triggers) if (t.error) log.error({ tenantId: event.tenant_id, trigger: t.triggerName, entityId: work.entityId, error: t.error }, 'trigger failed')
      }
    }
  }
}
