/**
 * COME SI CHIAMA NEL GRAFO UN TIPO DI ENTITÀ, in un posto solo (20 set 2026).
 *
 * `incident` → `Incident`, `service_request` → `ServiceRequest`. Una mappa
 * banale, e per questo se n'erano già formate due: una nel motore dei
 * workflow (`ENTITY_LABELS`, per scrivere lo status di un ticket) e una
 * nell'esecutore delle automazioni (`TICKET_LABELS`, per l'assegnazione).
 * Sono allowlist che finiscono dentro al Cypher, quindi due copie che
 * divergono vogliono dire che un tipo nuovo funziona di qua e non di là.
 *
 * Sta qui perché `@opengraphity/types` non porta dipendenze dietro: chi ha
 * bisogno soltanto della mappa — la diagnostica, i compiti — non si trascina
 * il motore dei workflow e con lui BullMQ e Redis.
 *
 * Non è il metamodello del cliente: è l'elenco delle entità che il PRODOTTO
 * sa muovere in un workflow. Un tipo che non è qui non si indovina, si dice.
 */
export const ENTITY_NEO4J_LABELS: Readonly<Record<string, string>> = {
  incident:        'Incident',
  problem:         'Problem',
  change:          'Change',
  service_request: 'ServiceRequest',
  kb_article:      'KBArticle',
}

/** I tipi di TICKET: l'articolo della knowledge base non è un ticket. */
export const TICKET_ENTITY_TYPES = ['incident', 'problem', 'change', 'service_request'] as const

export type TicketEntityType = (typeof TICKET_ENTITY_TYPES)[number]

/** L'etichetta Neo4j di un tipo, o `undefined` se il prodotto non lo conosce. */
export function entityNeo4jLabel(entityType: string): string | undefined {
  return ENTITY_NEO4J_LABELS[entityType]
}
