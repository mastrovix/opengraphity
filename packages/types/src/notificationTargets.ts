/**
 * Bersaglio di una regola di notifica: CHI riceve la notifica.
 *
 * Sorgente unica per i tre lati che prima non si parlavano (D-23): la tendina
 * dell'interfaccia (`apps/web/.../NotificationRuleList.tsx`), la validazione in
 * scrittura (`resolvers/notificationRules.ts`) e l'instradamento del dispatcher
 * (`packages/notifications/src/recipients.ts`). Prima di questa tabella il
 * bersaglio veniva salvato, mostrato e **mai applicato**: ogni notifica andava
 * a tutte le connessioni del tenant, `viewer` compresi.
 *
 * I bersagli per ruolo sono derivati da `USER_ROLES` — gli unici ruoli che
 * l'autenticazione accetta (D-13): un `role:manager` non è più esprimibile
 * perché quel ruolo non esiste al login e selezionerebbe zero utenti.
 */
import { USER_ROLES, type UserRole } from './user.js'

/** Trasmissione a tutto il tenant (in-app) e agli admin/operator (email): il comportamento storico. */
export const NOTIFICATION_TARGET_ALL = 'all'
/** L'utente assegnato all'entità dell'evento (`-[:ASSIGNED_TO]->`). */
export const NOTIFICATION_TARGET_ASSIGNEE = 'assignee'
/** Il team a cui l'entità è assegnata o che la possiede: membri e responsabile. */
export const NOTIFICATION_TARGET_TEAM = 'team_owner'
/** Prefisso dei bersagli per ruolo: `role:admin`, `role:operator`, … */
export const NOTIFICATION_ROLE_TARGET_PREFIX = 'role:'

/** Un bersaglio per ogni ruolo vero. */
export const NOTIFICATION_ROLE_TARGETS: readonly string[] =
  USER_ROLES.map((role) => `${NOTIFICATION_ROLE_TARGET_PREFIX}${role}`)

/** Tutti i bersagli ammessi, nell'ordine in cui l'interfaccia li offre. */
export const NOTIFICATION_TARGETS: readonly string[] = [
  NOTIFICATION_TARGET_ALL,
  NOTIFICATION_TARGET_ASSIGNEE,
  NOTIFICATION_TARGET_TEAM,
  ...NOTIFICATION_ROLE_TARGETS,
]

export function isNotificationTarget(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_TARGETS.includes(value)
}

/** Il ruolo di un bersaglio `role:<ruolo>`, oppure `null` se il bersaglio non è per ruolo. */
export function notificationTargetRole(target: string): UserRole | null {
  if (!target.startsWith(NOTIFICATION_ROLE_TARGET_PREFIX)) return null
  const role = target.slice(NOTIFICATION_ROLE_TARGET_PREFIX.length)
  return (USER_ROLES as readonly string[]).includes(role) ? (role as UserRole) : null
}

// ── Quali bersagli hanno senso per quale evento ──────────────────────────────
// Un bersaglio salvato ma impossibile da risolvere è una regola che non potrà
// mai consegnare niente. Il caso vero: su un tenant esisteva
// `incident.created → team_owner`, ma `CreateIncidentInput` non accetta né
// assegnatario né team, quindi alla nascita di un incident quel bersaglio non
// esiste ancora. Prima veniva ignorato (tutti ricevevano tutto); da quando il
// bersaglio si applica, quel job fallisce a ogni incident creato. Meglio
// rifiutare la regola quando la si scrive.
//
// Stesso schema dei canali instradabili: una tabella sola, usata dalla
// validazione in scrittura e dalla tendina dell'interfaccia. Il default è
// PERMISSIVO — un tipo di evento che non conosciamo ammette ogni bersaglio —
// perché bloccare l'ignoto sarebbe peggio del difetto; è un test statico a
// garantire che ogni evento seminato dal prodotto sia in tabella.

/** Eventi la cui entità non ha né assegnatario né team: sorgenti, allarmi, sincronizzazioni. */
const NO_ASSIGNMENT_EVENTS: ReadonlySet<string> = new Set([
  'sync.completed', 'sync.failed', 'conflict.created',
  'event.received', 'event.resolved', 'event.orphan', 'event.suppressed', 'event.correlated',
  'event.flapping', 'event.stable', 'event.storm_started', 'event.storm_ended',
])

/** Eventi la cui entità ha un team proprietario ma nessun assegnatario: CI e servizi. */
const TEAM_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'ci.health_changed', 'service.health_changed', 'service.incident_opened',
])

/**
 * Nascita di un ticket: l'input di creazione non accetta assegnatario né team
 * (`CreateIncidentInput`, `CreateProblemInput`), quindi al momento dell'evento
 * non esistono. L'assegnazione arriva con gli eventi successivi.
 */
const TICKET_CREATED_EVENTS: ReadonlySet<string> = new Set(['incident.created', 'problem.created'])

/** I bersagli che non dipendono dall'entità dell'evento: sempre applicabili. */
const ENTITY_FREE_TARGETS: readonly string[] = [NOTIFICATION_TARGET_ALL, ...NOTIFICATION_ROLE_TARGETS]

/** I bersagli che hanno senso per questo tipo di evento, nell'ordine dell'interfaccia. */
export function applicableNotificationTargets(eventType: string): readonly string[] {
  if (NO_ASSIGNMENT_EVENTS.has(eventType) || TICKET_CREATED_EVENTS.has(eventType)) return ENTITY_FREE_TARGETS
  if (TEAM_ONLY_EVENTS.has(eventType)) return [NOTIFICATION_TARGET_ALL, NOTIFICATION_TARGET_TEAM, ...NOTIFICATION_ROLE_TARGETS]
  return NOTIFICATION_TARGETS
}

/** Vero se il bersaglio può essere risolto per quel tipo di evento. */
export function isTargetApplicable(eventType: string, target: string): boolean {
  return applicableNotificationTargets(eventType).includes(target)
}
