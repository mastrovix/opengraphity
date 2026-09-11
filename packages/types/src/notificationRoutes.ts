/**
 * Dove porta una notifica: `entity_type` → percorso nell'app web.
 *
 * È la SOLA tabella condivisa fra il pannello in-app (apps/web
 * `NotificationPanel`), il link «Vedi dettagli» delle email
 * (packages/notifications `renderNotificationEmail`) e i test di contratto che
 * verificano che ogni `entity_type` prodotto dai produttori di eventi porti da
 * qualche parte (revisione 2, D3.2/D5.1). Vive in `@opengraphity/types` perché
 * il web non può importare `@opengraphity/notifications` (Neo4j, Resend): i
 * pacchetti server la ri-esportano da lì.
 *
 * I percorsi sono relativi alla radice dell'app (`APP_URL` per le email); il
 * segnaposto `:id` è l'`entity_id` della notifica. `/cis/:id` è la rotta di
 * reindirizzo del CI senza tipo (main.tsx → `/ci/:typeName/:id`).
 */
export const NOTIFICATION_ENTITY_PATHS = {
  // ITSM
  incident:        '/incidents/:id',
  change:          '/changes/:id',
  problem:         '/problems/:id',
  request:         '/requests/:id',
  /** Nome usato dal motore SLA (`packages/sla`) per le Service Request. */
  service_request: '/requests/:id',
  // CMDB / Event Management / Servizi monitorati
  ci:              '/cis/:id',
  event:           '/events/:id',
  service:         '/monitoring/services/:id',
  inbound_webhook: '/monitoring/sources/:id',
} as const

export type NotificationEntityType = keyof typeof NOTIFICATION_ENTITY_PATHS

export function isNotificationEntityType(value: string): value is NotificationEntityType {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_ENTITY_PATHS, value)
}

/**
 * Percorso della pagina dell'entità, oppure `null` quando la notifica non ha
 * un'entità raggiungibile (nessun `entity_id`, oppure un `entity_type` senza
 * pagina — es. `sync`, `portal`: eventi che descrivono un'operazione, non un
 * record). Un `entity_type` sconosciuto con un id NON è un errore qui: la
 * completezza della tabella rispetto ai produttori è pinnata dal test di
 * contratto in apps/api (`notificationEntityPaths.test.ts`), non a runtime
 * dentro un pannello che deve comunque mostrare la notifica.
 */
export function notificationEntityPath(entityType: string | null | undefined, entityId: string | null | undefined): string | null {
  if (!entityType || !entityId) return null
  if (!isNotificationEntityType(entityType)) return null
  return NOTIFICATION_ENTITY_PATHS[entityType].replace(':id', encodeURIComponent(entityId))
}
