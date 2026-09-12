/**
 * I bersagli che la mappa dei campi di un webhook in ingresso può nominare — in
 * **un posto solo** (D-25).
 *
 * ## Il difetto
 * Il ciclo di applicazione costruiva `mapped[targetField]` per **ogni** voce
 * della mappa, e poi lo `switch` di creazione passava al servizio quattro campi
 * e basta: `title`, `description`, `severity`, `category` per l'incident;
 * `title`, `description`, `priority`, `category` per il problem. Tutto il resto
 * — un campo aggiunto dal cliente (`costCenter`), o anche solo
 * `impact`/`urgency`/`assignedTo` — veniva **accettato al salvataggio**,
 * applicato al payload in ingresso e poi **scartato**, con risposta
 * `201 Created` e l'id dell'entità: l'integrazione «funzionava» e perdeva metà
 * dei dati. Il buco si scopriva aprendo un ticket importato.
 *
 * ## La regola
 * L'interfaccia offre ciò che il server applica. Questo elenco è la sorgente
 * unica: lo legge `validateInboundConfig` (che al salvataggio rifiuta un
 * bersaglio fuori elenco nominando gli ammessi, come già fa il ramo `event`),
 * lo legge la consegna (un bersaglio non riconosciuto in una configurazione
 * vecchia è un errore che finisce in `last_error`, non un silenzio), e lo
 * mostra la pagina Integrazioni come suggerimento accanto al campo.
 *
 * Perché non scrivere invece i campi custom: sarebbe un'altra cosa — passare
 * campi dinamici ai servizi di creazione dei ticket, come si fa per i CI. Resta
 * aperto e dichiarato; qui si chiude la bugia.
 *
 * Vive in `@opengraphity/types` perché lo leggono in due, API e web.
 */
export const INBOUND_TICKET_FIELDS = {
  incident: ['title', 'description', 'severity', 'category'],
  problem:  ['title', 'description', 'priority', 'category'],
} as const

/** I tipi di entità che un webhook in ingresso può creare, oltre a `event`. */
export type InboundTicketEntityType = keyof typeof INBOUND_TICKET_FIELDS

export function isInboundTicketEntityType(value: unknown): value is InboundTicketEntityType {
  return typeof value === 'string' && value in INBOUND_TICKET_FIELDS
}

/**
 * I bersagli ammessi per quel tipo di entità, o `null` se il tipo non crea
 * ticket (`event` ha la sua validazione, per connettore).
 */
export function inboundTicketFieldsFor(entityType: unknown): readonly string[] | null {
  return isInboundTicketEntityType(entityType) ? INBOUND_TICKET_FIELDS[entityType] : null
}
