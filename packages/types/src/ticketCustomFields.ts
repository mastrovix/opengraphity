/**
 * I CAMPI PERSONALIZZATI DEI TICKET (verifica «Cosa resta cablato», ondata 4).
 *
 * Il designer ITIL permetteva di aggiungere campi a incident, problem, change e
 * service request, e il campo nasceva nel metamodello — ma nessuna pagina lo
 * mostrava, nessuna API lo accettava e nessun canale lo portava: un campo
 * configurato che non esisteva. Da questa ondata un campo del cliente arriva in
 * creazione, nel dettaglio, nelle liste, in REST, nell'import, nel PDF e
 * nell'Audit Log, validato come la modifica fatta a mano.
 *
 * Qui le regole che leggono API e web: dove valgono e come si chiama un campo.
 */
import { STEP_FIELDS_DERIVED, STEP_FIELDS_ENGINE_OWNED, STEP_FIELDS_IDENTITY } from './workflowFields.js'

/** I tipi di ticket che hanno campi personalizzati. */
export const TICKET_CUSTOM_FIELD_ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request'] as const
export type TicketCustomFieldEntityType = (typeof TICKET_CUSTOM_FIELD_ENTITY_TYPES)[number]

export function isTicketCustomFieldEntityType(value: unknown): value is TicketCustomFieldEntityType {
  return typeof value === 'string' && (TICKET_CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(value)
}

/**
 * Il nome di un campo del cliente: minuscole, cifre e trattino basso, da 2 a 40
 * caratteri. Diventa il nome della proprietà sul ticket, la colonna dell'import
 * e la chiave in REST: deve restare lo stesso in tutti e tre.
 */
export const CUSTOM_FIELD_NAME_RE = /^[a-z][a-z0-9_]{1,39}$/

/**
 * Nomi che un campo del cliente non può prendere su nessun tipo: sono proprietà
 * che il prodotto scrive (identità, motore, campi derivati). Le altre
 * proprietà di ogni tipo le verifica l'API contro lo schema e contro i dati.
 */
export function customFieldNameReserved(name: string, entityType: string): boolean {
  return (STEP_FIELDS_IDENTITY as readonly string[]).includes(name)
    || (STEP_FIELDS_ENGINE_OWNED as readonly string[]).includes(name)
    || (STEP_FIELDS_DERIVED[entityType] ?? []).includes(name)
}
