/**
 * AUTOMAZIONI (AutoTrigger e Business Rule): su quali eventi e per quali
 * ticket girano davvero.
 *
 * Revisione del 14 set 2026 · AU-1. Le pagine offrivano cinque eventi e
 * quattro tipi di ticket; il codice valutava trigger e regole in un punto solo,
 * alla creazione di incident e problem. Una regola «SLA violato», «aggiornato»,
 * «cambio di stato» o su una change si salvava, risultava attiva e non girava
 * mai. Qui la tabella di ciò che è sostenuto: la leggono la validazione in
 * scrittura, le pagine (per offrire solo le combinazioni vere) e il
 * consumatore che esegue (`apps/api/src/consumers/automationConsumer.ts`).
 */
import { SLA_ENTITY_TYPES } from './events.js'

export const AUTOMATION_ENTITY_TYPES = ['incident', 'change', 'problem', 'service_request'] as const
export type AutomationEntityType = (typeof AUTOMATION_ENTITY_TYPES)[number]

export const TRIGGER_EVENT_TYPES = ['on_create', 'on_update', 'on_timer', 'on_sla_breach', 'on_field_change'] as const
export const RULE_EVENT_TYPES    = ['on_create', 'on_update', 'on_transition'] as const
export type AutomationEventType  = (typeof TRIGGER_EVENT_TYPES)[number] | (typeof RULE_EVENT_TYPES)[number]

/** I ticket che hanno un aggiornamento dei campi (mutation di modifica): le change no, avanzano per passi. */
const UPDATABLE: readonly AutomationEntityType[] = ['incident', 'problem', 'service_request']

/** Per ogni evento, i ticket su cui gira. */
export const AUTOMATION_EVENT_ENTITIES: Readonly<Record<AutomationEventType, readonly AutomationEntityType[]>> = {
  on_create:       AUTOMATION_ENTITY_TYPES,
  on_timer:        AUTOMATION_ENTITY_TYPES,
  on_transition:   AUTOMATION_ENTITY_TYPES,
  on_update:       UPDATABLE,
  on_field_change: UPDATABLE,
  on_sla_breach:   SLA_ENTITY_TYPES,
}

export function automationEventSupported(eventType: string, entityType: string): boolean {
  const entities = AUTOMATION_EVENT_ENTITIES[eventType as AutomationEventType]
  return !!entities && (entities as readonly string[]).includes(entityType)
}

/**
 * L'aggiornamento dei campi di un ticket, da chiunque arrivi (pagina, API).
 * `changed_fields` sono i nomi delle proprietà cambiate, `previous` i loro
 * valori prima.
 */
export const TICKET_UPDATED_EVENT = 'ticket.updated'

export interface TicketUpdatedPayload {
  entity_type:    AutomationEntityType
  entity_id:      string
  changed_fields: string[]
  previous:       Record<string, unknown>
}

/**
 * L'attore delle scritture fatte da un'automazione. Un evento prodotto da
 * un'automazione non rimette in moto le automazioni: una regola «su
 * aggiornamento» che aggiorna un campo, o «su cambio di stato» che cambia
 * stato, girerebbe all'infinito.
 */
export const AUTOMATION_ACTOR = 'automation'

/**
 * L'azione «crea notifica» delle automazioni: l'evento che pubblica e che il
 * dispatcher delle notifiche consegna (revisione del 14 set 2026 · AU-2: prima
 * nessuno lo consumava).
 */
export const AUTOMATION_NOTIFICATION_EVENT = 'automation.notification'
export const AUTOMATION_NOTIFICATION_CHANNELS: readonly string[] = ['in_app', 'email']

export interface AutomationNotificationPayload {
  entity_id:   string
  entity_type: string
  message:     string
  channel:     string
  /** Un bersaglio di `NOTIFICATION_TARGETS`. */
  target:      string
  /** Il nome del trigger o della regola: è il titolo della notifica. */
  rule:        string
}
