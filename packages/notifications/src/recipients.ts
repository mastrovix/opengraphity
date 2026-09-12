/**
 * Destinatari di una regola di notifica: dal `target` della regola alle
 * persone (D-23).
 *
 * Prima di questo file il bersaglio veniva letto dalla regola e **mai
 * applicato**: ogni notifica in-app finiva su `sendToTenant` (tutte le
 * connessioni del tenant, `viewer` compresi) e ogni email su tutti gli
 * admin/operator. Una regola pensata «solo per gli amministratori» o «solo per
 * l'assegnatario» arrivava a chiunque, e l'amministratore vedeva la
 * configurazione salvata e la credeva applicata.
 *
 * Il vocabolario dei bersagli è in `@opengraphity/types`
 * (`NOTIFICATION_TARGETS`), condiviso con l'interfaccia e con la validazione
 * in scrittura del resolver.
 *
 * Fail-loud: un bersaglio che non si risolve (ruolo senza utenti, entità senza
 * assegnatario o senza team, evento senza id dell'entità) è un **errore del
 * job** — mai una trasmissione a tutto il tenant «per non perdere la
 * notifica». Il job resta nella coda dei falliti, visibile e rigiocabile dalla
 * pagina Code.
 */
import { getSession } from '@opengraphity/neo4j'
import {
  NOTIFICATION_TARGET_ALL, NOTIFICATION_TARGET_ASSIGNEE, NOTIFICATION_TARGET_TEAM,
  NOTIFICATION_TARGETS, notificationTargetRole,
} from '@opengraphity/types'

export interface NotificationRecipient {
  id:    string
  email: string | null
  /** `notifications_enabled` del `:User` (assente = attivo): esclude SOLO l'email, non la notifica in-app. */
  notificationsEnabled: boolean
}

/** L'assegnatario dell'entità dell'evento. */
export const ASSIGNEE_RECIPIENTS_CYPHER = `
  MATCH (e {id: $entityId, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User {tenant_id: $tenantId})
  RETURN DISTINCT u.id AS id, u.email AS email, coalesce(u.notifications_enabled, true) AS notificationsEnabled`

/**
 * Il team dell'entità (`ASSIGNED_TO_TEAM` per i ticket, `OWNED_BY` per i CI):
 * membri (`MEMBER_OF`) e responsabile (`MANAGED_BY`). `OWNED_BY` punta anche a
 * `:User` su alcune entità (le Change), perciò il vincolo `:Team` è esplicito.
 */
export const TEAM_RECIPIENTS_CYPHER = `
  MATCH (e {id: $entityId, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM|OWNED_BY]->(t:Team {tenant_id: $tenantId})
  OPTIONAL MATCH (t)<-[:MEMBER_OF]-(m:User {tenant_id: $tenantId})
  OPTIONAL MATCH (t)-[:MANAGED_BY]->(g:User {tenant_id: $tenantId})
  WITH collect(DISTINCT m) + collect(DISTINCT g) AS people
  UNWIND people AS u
  RETURN DISTINCT u.id AS id, u.email AS email, coalesce(u.notifications_enabled, true) AS notificationsEnabled`

/** Gli utenti del tenant con un ruolo preciso (il vocabolario è USER_ROLES). */
export const ROLE_RECIPIENTS_CYPHER = `
  MATCH (u:User {tenant_id: $tenantId})
  WHERE u.role = $role
  RETURN DISTINCT u.id AS id, u.email AS email, coalesce(u.notifications_enabled, true) AS notificationsEnabled`

export interface TargetEntity {
  /** Tipo dell'entità dell'evento (solo per i messaggi d'errore). */
  type:      string
  /** Id dell'entità: assente = il produttore dell'evento non l'ha messo nel payload. */
  id:        string | undefined
  eventType: string
}

function toBoolean(value: unknown): boolean {
  return value !== false
}

function mapRecipients(records: Array<{ get(key: string): unknown }>): NotificationRecipient[] {
  return records.map((r) => {
    const email = r.get('email')
    return {
      id:    r.get('id') as string,
      email: typeof email === 'string' && email !== '' ? email : null,
      notificationsEnabled: toBoolean(r.get('notificationsEnabled')),
    }
  })
}

async function read(cypher: string, params: Record<string, unknown>): Promise<NotificationRecipient[]> {
  const session = getSession()
  try {
    const result = await session.executeRead((tx) => tx.run(cypher, params))
    return mapRecipients(result.records as Array<{ get(key: string): unknown }>)
  } finally {
    await session.close()
  }
}

/**
 * `true` quando il bersaglio non è la trasmissione a tutto il tenant, cioè
 * quando i destinatari vanno risolti prima di consegnare in-app/email.
 */
export function targetNeedsRecipients(target: string): boolean {
  return target !== NOTIFICATION_TARGET_ALL
}

/**
 * Destinatari di `target` per l'entità dell'evento. Mai una lista vuota:
 * un bersaglio che non seleziona nessuno è un errore che nomina il bersaglio,
 * il tipo di evento e l'entità.
 */
export async function resolveNotificationRecipients(
  tenantId: string,
  target: string,
  entity: TargetEntity,
): Promise<NotificationRecipient[]> {
  if (!NOTIFICATION_TARGETS.includes(target)) {
    throw new Error(
      `${entity.eventType} notification rule has target "${target}", which is not one of [${NOTIFICATION_TARGETS.join(', ')}] — ` +
      `fix the rule (Impostazioni → Regole di notifica): nobody would receive it`,
    )
  }
  if (target === NOTIFICATION_TARGET_ALL) {
    throw new Error(`resolveNotificationRecipients called with target "${NOTIFICATION_TARGET_ALL}": that target is a tenant broadcast, not a recipient list`)
  }

  const role = notificationTargetRole(target)
  let recipients: NotificationRecipient[]

  if (role) {
    recipients = await read(ROLE_RECIPIENTS_CYPHER, { tenantId, role })
    if (recipients.length === 0) {
      throw new Error(`${entity.eventType} notification rule targets "${target}" but tenant ${tenantId} has no user with role "${role}" — the notification has no recipient`)
    }
    return recipients
  }

  if (entity.id === undefined) {
    throw new Error(`${entity.eventType} notification rule targets "${target}" but the event payload has no entity id (no "id" nor "entity_id"): the recipient cannot be resolved`)
  }

  if (target === NOTIFICATION_TARGET_ASSIGNEE) {
    recipients = await read(ASSIGNEE_RECIPIENTS_CYPHER, { tenantId, entityId: entity.id })
    if (recipients.length === 0) {
      throw new Error(`${entity.eventType} notification rule targets "${target}" but ${entity.type} ${entity.id} has no assignee (no ASSIGNED_TO user) — the notification has no recipient`)
    }
    return recipients
  }

  if (target === NOTIFICATION_TARGET_TEAM) {
    recipients = await read(TEAM_RECIPIENTS_CYPHER, { tenantId, entityId: entity.id })
    if (recipients.length === 0) {
      throw new Error(`${entity.eventType} notification rule targets "${target}" but ${entity.type} ${entity.id} has no team with members (no ASSIGNED_TO_TEAM/OWNED_BY team, or the team is empty) — the notification has no recipient`)
    }
    return recipients
  }

  // NOTIFICATION_TARGETS e questo switch devono coprire gli stessi valori: se
  // qualcuno aggiunge un bersaglio al vocabolario senza instradarlo qui,
  // l'errore lo nomina invece di far sparire la notifica.
  throw new Error(`${entity.eventType} notification rule targets "${target}", which is in the vocabulary but has no recipient resolution in recipients.ts`)
}
