/**
 * La severità con cui una notifica si presenta: colore e icona nel pannello e
 * nei canali. È la severità del **messaggio**, non la priorità del ticket.
 *
 * Sorgente unica per la tendina delle regole di notifica (web), la validazione
 * in scrittura (`resolvers/notificationRules.ts`) e il pannello
 * (`packages/notifications/src/sse.ts`).
 *
 * Revisione del 14 set 2026 · NT-1: la pagina proponeva questi quattro valori
 * e `updateNotificationRule` accettava invece `low/medium/high/critical` —
 * cambiare la severità di una regola dall'interfaccia falliva sempre, e un
 * valore accettato dall'API non era riconosciuto dal pannello.
 */
export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'error'] as const

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return typeof value === 'string' && (NOTIFICATION_SEVERITIES as readonly string[]).includes(value)
}
