/**
 * Lingua e fuso del cliente per le notifiche che escono (e-mail, Slack, Teams).
 *
 * La lingua è `Tenant.default_language`, quella che il cliente sceglie dalla
 * pagina Organizzazione; se non è configurata vale la prima lingua del
 * prodotto, come in `apps/api/src/lib/tenantLanguage.ts` (dove la diagnostica
 * lo dice all'admin). Il fuso è `Tenant.timezone`: senza, le date dei messaggi
 * sarebbero nel fuso del server, quindi è un errore che lo dice.
 *
 * Cache breve: si chiede a ogni notifica, e un cambio di lingua deve vedersi
 * in fretta.
 */
import { getSession } from '@opengraphity/neo4j'
import { NOTIFICATION_LANGUAGES, type NotificationLanguage, type NotificationLocale } from './texts.js'

const TTL_MS = 30_000
const cache = new Map<string, { locale: NotificationLocale; expires: number }>()

export function invalidateNotificationLocale(tenantId?: string): void {
  if (tenantId === undefined) cache.clear()
  else cache.delete(tenantId)
}

function isLanguage(v: unknown): v is NotificationLanguage {
  return typeof v === 'string' && (NOTIFICATION_LANGUAGES as readonly string[]).includes(v)
}

export async function loadNotificationLocale(tenantId: string): Promise<NotificationLocale> {
  const now = Date.now()
  const hit = cache.get(tenantId)
  if (hit && hit.expires > now) return hit.locale
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) =>
      tx.run('MATCH (t:Tenant {id: $tenantId}) RETURN t.default_language AS language, t.timezone AS timeZone', { tenantId }),
    )
    const row = res.records[0]
    if (!row) throw new Error(`[notifications] Tenant ${tenantId} not found: cannot choose the language and time zone of its notifications`)
    const timeZone = row.get('timeZone') as unknown
    if (typeof timeZone !== 'string' || timeZone === '') {
      throw new Error(`[notifications] Tenant ${tenantId} has no time zone configured: the dates in its e-mail, Slack and Teams messages cannot be written`)
    }
    const language = row.get('language') as unknown
    const locale: NotificationLocale = { language: isLanguage(language) ? language : NOTIFICATION_LANGUAGES[0], timeZone }
    cache.set(tenantId, { locale, expires: now + TTL_MS })
    return locale
  } finally {
    await session.close()
  }
}
