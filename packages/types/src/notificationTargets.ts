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
 * I bersagli per ruolo sono `role:<chiave>` per ogni ruolo dell'organizzazione
 * (ondata 7 di «Nulla cablato»: prima i soli quattro di `USER_ROLES`). Qui si
 * controlla la FORMA della chiave; che il ruolo esista lo controlla l'API in
 * scrittura, coi ruoli del tenant — un `role:manager` inesistente resta rifiutato.
 */
import { USER_ROLES } from './user.js'

/** Trasmissione a tutto il tenant (in-app) e agli admin/operator (email): il comportamento storico. */
export const NOTIFICATION_TARGET_ALL = 'all'
/** L'utente assegnato all'entità dell'evento (`-[:ASSIGNED_TO]->`). */
export const NOTIFICATION_TARGET_ASSIGNEE = 'assignee'
/** Il team a cui l'entità è assegnata o che la possiede: membri e responsabile. */
export const NOTIFICATION_TARGET_TEAM = 'team_owner'
/** Prefisso dei bersagli per ruolo: `role:admin`, `role:operator`, … */
export const NOTIFICATION_ROLE_TARGET_PREFIX = 'role:'

/** La forma della chiave di un ruolo (la stessa di `ROLE_KEY_RE` in apps/api/src/lib/roles.ts). */
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/

/** I bersagli che non sono per ruolo. */
export const NOTIFICATION_BASE_TARGETS: readonly string[] = [
  NOTIFICATION_TARGET_ALL,
  NOTIFICATION_TARGET_ASSIGNEE,
  NOTIFICATION_TARGET_TEAM,
]

/** Un bersaglio per ogni ruolo di fabbrica (i ruoli creati dall'organizzazione si aggiungono dai dati). */
export const NOTIFICATION_ROLE_TARGETS: readonly string[] =
  USER_ROLES.map((role) => `${NOTIFICATION_ROLE_TARGET_PREFIX}${role}`)

/** I bersagli di un tenant con i soli ruoli di fabbrica, nell'ordine in cui l'interfaccia li offre. */
export const NOTIFICATION_TARGETS: readonly string[] = [
  ...NOTIFICATION_BASE_TARGETS,
  ...NOTIFICATION_ROLE_TARGETS,
]

/** Il bersaglio `role:<chiave>` di un ruolo. */
export function roleNotificationTarget(roleKey: string): string {
  return `${NOTIFICATION_ROLE_TARGET_PREFIX}${roleKey}`
}

/** La chiave del ruolo di un bersaglio `role:<chiave>`, oppure `null` se il bersaglio non è per ruolo. */
export function notificationTargetRole(target: string): string | null {
  if (!target.startsWith(NOTIFICATION_ROLE_TARGET_PREFIX)) return null
  const role = target.slice(NOTIFICATION_ROLE_TARGET_PREFIX.length)
  return ROLE_KEY_RE.test(role) ? role : null
}

/** Un bersaglio ben formato: uno di quelli fissi, o `role:<chiave>`. Che il ruolo esista lo dice il tenant. */
export function isNotificationTarget(value: unknown): value is string {
  return typeof value === 'string' && (NOTIFICATION_BASE_TARGETS.includes(value) || notificationTargetRole(value) !== null)
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

/** Riepiloghi del tenant: nessuna entità, quindi nessun assegnatario né team (NT-8). */
const TENANT_SUMMARY_EVENTS: ReadonlySet<string> = new Set(['digest.daily'])

/**
 * I bersagli che hanno senso per questo tipo di evento, nell'ordine
 * dell'interfaccia.
 *
 * `roleTargets` sono i bersagli per ruolo DEL TENANT: i ruoli creati
 * dall'organizzazione (ondata 7) esistono e l'API li accetta già
 * (`isTargetApplicable` non guarda l'elenco), ma la tendina non li offriva,
 * perché qui c'erano solo i quattro di fabbrica (revisione totale · E-39).
 * Chi non li ha a disposizione (un test statico sui seed del prodotto) non
 * passa niente e ottiene i ruoli di fabbrica, come prima.
 */
export function applicableNotificationTargets(
  eventType: string, roleTargets: readonly string[] = NOTIFICATION_ROLE_TARGETS,
): readonly string[] {
  if (NO_ASSIGNMENT_EVENTS.has(eventType) || TICKET_CREATED_EVENTS.has(eventType) || TENANT_SUMMARY_EVENTS.has(eventType)) {
    return [NOTIFICATION_TARGET_ALL, ...roleTargets]
  }
  if (TEAM_ONLY_EVENTS.has(eventType)) return [NOTIFICATION_TARGET_ALL, NOTIFICATION_TARGET_TEAM, ...roleTargets]
  return [...NOTIFICATION_BASE_TARGETS, ...roleTargets]
}

/** Vero se il bersaglio può essere risolto per quel tipo di evento. Un ruolo non dipende dall'entità: sempre. */
export function isTargetApplicable(eventType: string, target: string): boolean {
  return notificationTargetRole(target) !== null || applicableNotificationTargets(eventType).includes(target)
}
