/**
 * WHO IS TOLD OF WHAT HAPPENS ON A TICKET (wave 7 · C1): the mentions, the
 * watchers, the author who starts watching. It lived with the collaboration
 * resolvers, so the REST API reached into a resolver file to tell the
 * watchers of a comment it had written; it is a service now, and the
 * resolvers re-export it. Who hears of a comment is `commentAudience.ts`.
 */
import { v4 as uuidv4 } from 'uuid'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { sseManager } from '@opengraphity/notifications'
import { TICKET_WORKER_PERMISSION } from '@opengraphity/types'
import { withSession } from '../lib/db.js'
import { logger } from '../lib/logger.js'
import { roleHasPermission } from '../lib/roles.js'
import { matchById } from '../lib/cypherLookups.js'

/**
 * L'indirizzo a cui mandare una e-mail di collaborazione, o `null`.
 *
 * Revisione del 14 set 2026 · CO-1: prima si scartavano gli indirizzi `@demo.`,
 * `@opengrafo.com` e `usr-N@`, una scelta da seed che faceva sparire senza
 * traccia le e-mail di un cliente con quei domini. Ora decide la persona, dal
 * Profilo (`notifications_enabled`, assente = attivo), come per il digest e il
 * dispatcher delle notifiche.
 */
async function emailRecipient(tenantId: string, userId: string): Promise<string | null> {
  const row = await withSession(async (s) =>
    runQueryOne<{ email: string | null; enabled: boolean }>(s, `
      MATCH (u:User {id: $id, tenant_id: $t})
      RETURN u.email AS email, coalesce(u.notifications_enabled, true) AS enabled
    `, { id: userId, t: tenantId }),
  )
  return row?.email && row.enabled ? row.email : null
}

/**
 * Menzioni e osservatori parlano la lingua di chi legge (revisione del 14 set
 * 2026 · CO-2). La notifica porta la chiave del messaggio e i suoi dati, e il
 * pannello compone la frase; `message` è la stessa frase nella lingua del
 * cliente, per chi non ha la chiave. Prima erano letterali italiani
 * («Menzione», «ti ha menzionato», «Aggiornamento») per ogni cliente.
 */
async function notifyMentions(
  tenantId: string, authorName: string, entityType: string, entityId: string,
  entityTitle: string, mentions: string[], source: 'comment' | 'internal_chat',
  excerpt?: string,
): Promise<void> {
  const { loadNotificationLocale, notificationText } = await import('@opengraphity/notifications')
  const locale = await loadNotificationLocale(tenantId)
  const params = { author: authorName, entity: entityType, title: entityTitle }
  const textKey = source === 'internal_chat' ? 'mentionChatMessage' : 'mentionMessage'
  for (const userId of mentions) {
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'mention',
      title: 'notification.mention.title',
      message: notificationText(locale, textKey, params),
      message_key: source === 'internal_chat' ? 'inApp.mention.chatMessage' : 'inApp.mention.message',
      message_params: params,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for mention
    try {
      const { sendTenantEmail, loadTenantBrand } = await import('@opengraphity/notifications')
      const { mentionNotification } = await import('../lib/emailTemplates.js')
      const to = await emailRecipient(tenantId, userId)
      if (to) {
        const tpl = mentionNotification({ entityType, entityTitle, entityId, mentionerName: authorName, excerpt: excerpt ?? '' }, { tenantId, brand: await loadTenantBrand(tenantId) }, locale)
        await sendTenantEmail(tenantId, { to, ...tpl })
      }
    } catch (err) {
      // Non-fatal for the mutation, but a systematically broken mailer must be
      // visible in the logs, not swallowed without a trace.
      logger.error({ err, userId, entityId }, '[collaboration] mention email failed — notification NOT sent')
    }
  }
}

/**
 * Cosa è successo, per gli osservatori: una frase del prodotto (chiave e dati)
 * o un testo scritto da una persona (il commento dal portale), che non si
 * traduce.
 */
export type WatcherEvent =
  | { kind: 'comment' | 'internal_chat'; author: string }
  | { kind: 'text'; text: string }

const WATCHER_KEYS = {
  comment:       { text: 'watcherComment',      web: 'inApp.watcher.comment' },
  internal_chat: { text: 'watcherInternalChat', web: 'inApp.watcher.internalChat' },
} as const

/**
 * `internal` = il contenuto è visibile SOLO a chi lavora i ticket (una nota
 * interna, la chat interna). Chi apre un ticket dal portale diventa
 * osservatore alla creazione, e riceveva l'avviso — in-app e per e-mail — di
 * una nota che non può leggere, con il testo nel corpo dell'e-mail (revisione
 * totale · M-16). Gli osservatori senza il permesso di lavorare i ticket non
 * vengono avvisati del contenuto interno.
 */
async function notifyWatchers(
  tenantId: string, entityType: string, entityId: string,
  event: WatcherEvent, excludeUserId?: string, internal = false,
): Promise<void> {
  const watchers = await withSession(async (s) => {
    const rows = await runQuery<{ userId: string; role: string | null }>(s, `
      ${matchById('e', { labels: 'entities', id: '$entityId' })}
      // The ticket first, by its index (review of 23 Sep 2026): a ticket matched by id
      // without a label scanned every WATCHES edge of the database.
      MATCH (u:User)-[:WATCHES]->(e)
      RETURN DISTINCT u.id AS userId, u.role AS role
    `, { entityId, tenantId })
    if (!internal) return rows.map(r => r.userId)
    const allowed: string[] = []
    for (const r of rows) {
      const role = r.role ?? ''
      if (role && await roleHasPermission(tenantId, role, TICKET_WORKER_PERMISSION)) allowed.push(r.userId)
      else logger.debug({ entityId, userId: r.userId, role }, '[collaboration] osservatore senza accesso al contenuto interno: non avvisato')
    }
    return allowed
  })
  const { loadNotificationLocale, notificationText } = await import('@opengraphity/notifications')
  const locale = await loadNotificationLocale(tenantId)
  const described = event.kind === 'text'
    ? { message: event.text }
    : {
        message: notificationText(locale, WATCHER_KEYS[event.kind].text, { author: event.author }),
        message_key: WATCHER_KEYS[event.kind].web,
        message_params: { author: event.author },
      }

  for (const userId of watchers) {
    if (userId === excludeUserId) continue
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'watcher',
      title: 'notification.watcher.title',
      ...described,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for watcher
    try {
      const { sendTenantEmail, loadTenantBrand } = await import('@opengraphity/notifications')
      const { watcherNotification } = await import('../lib/emailTemplates.js')
      const title = await getEntityTitle(tenantId, entityId)
      const to = await emailRecipient(tenantId, userId)
      if (to) {
        const tpl = watcherNotification({ entityType, entityTitle: title, entityId, event: described.message }, { tenantId, brand: await loadTenantBrand(tenantId) }, locale)
        await sendTenantEmail(tenantId, { to, ...tpl })
      }
    } catch (err) {
      // Per-watcher batch: keep notifying the others, but log the failure loud.
      logger.error({ err, userId, entityId }, '[collaboration] watcher email failed — notification NOT sent')
    }
  }
}

async function autoWatch(tenantId: string, userId: string, entityId: string): Promise<void> {
  await withSession(async (s) => {
    await runQuery(s, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      ${matchById('e', { labels: 'entities', id: '$entityId' })}
      // The timestamp is not part of the match: with it, every comment added one more WATCHES edge (review of 23 Sep 2026).
      MERGE (u)-[w:WATCHES]->(e)
        ON CREATE SET w.watched_at = $now
    `, { userId, tenantId, entityId, now: new Date().toISOString() })
  }, true)
}

async function getEntityTitle(tenantId: string, entityId: string): Promise<string> {
  const row = await withSession(async (s) =>
    runQueryOne<{ title: string }>(s, `${matchById('e', { labels: 'entities', id: '$id', tenant: '$t' })} RETURN e.title AS title`, { id: entityId, t: tenantId }),
  )
  return row?.title ?? entityId
}

export { notifyMentions, notifyWatchers, autoWatch, getEntityTitle }
