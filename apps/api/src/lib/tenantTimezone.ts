/**
 * IL FUSO ORARIO DEL CLIENTE — configurazione, non uno script.
 *
 * Revisione del 14 set 2026 · F7. `Tenant.timezone` si scriveva solo con
 * `onboard-tenant.ts`, eppure da lì dipendono le scadenze SLA/OLA in orario
 * lavorativo, l'ora del digest, le finestre di manutenzione e ogni data nei
 * testi generati (notifiche, PDF). È una scelta del cliente e si prende dalla
 * pagina Organizzazione, accanto alla lingua.
 *
 * Cosa NON fa: non ricalcola le scadenze già scritte. Uno SLA aperto conserva
 * le scadenze calcolate quando è partito; i ticket successivi usano il fuso
 * nuovo. Le policy SLA senza fuso proprio lo ereditano al momento della
 * selezione (packages/sla/src/selector.ts).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'

/** Le zone IANA che il runtime conosce: l'elenco offerto dalla pagina. */
export function availableTimeZones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone')
  return zones.includes('UTC') ? [...zones] : ['UTC', ...zones]
}

/** Vero quando la stringa è una zona IANA che il runtime sa convertire. */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
    return true
  } catch {
    return false
  }
}

/** Errore di validazione condiviso da Organizzazione e policy SLA. */
export function assertTimeZone(v: unknown): string {
  if (!isTimeZone(v)) {
    throw new ValidationError(
      `Time zone "${String(v)}" is not a valid IANA time zone (for example Europe/Rome, America/New_York).`,
      { key: 'errors.tenant.unknownTimezone', params: { timezone: String(v) } },
    )
  }
  return v
}

/**
 * The time zone a rule chooses for itself — an SLA policy, an OLA/UC
 * contract: null when it chooses none, and then it counts in the
 * organization's, read when the rule is applied (so changing the
 * organization's zone moves it too). An empty string is «none»; anything else
 * must be a real IANA zone.
 */
export function optionalTimeZone(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return assertTimeZone(typeof value === 'string' ? value.trim() : value)
}

/**
 * An instant as wall-clock time in a zone, «2026-09-23 06:34».
 *
 * The form the AI drafts receive (tour of 23 Sep 2026, D14): given raw UTC
 * instants next to a description written in local time, the model wrote
 * «taken in progress at 04:20» before «opened at 04:34». A missing instant
 * stays missing; one that is not a date is an error, not a guess.
 */
export function localDateTimeIn(iso: string | null | undefined, timeZone: string): string | null {
  if (iso == null || iso === '') return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error(`localDateTimeIn: "${iso}" is not an instant`)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  )
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`
}

export async function tenantTimezone(tenantId: string): Promise<string | null> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ timezone: unknown }>(session,
      'MATCH (t:Tenant {id: $tenantId}) RETURN t.timezone AS timezone', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    return typeof row.timezone === 'string' && row.timezone !== '' ? row.timezone : null
  } finally {
    await session.close()
  }
}

export async function setTenantTimezone(tenantId: string, timezone: string): Promise<string> {
  const tz = assertTimeZone(timezone)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.timezone = $timezone, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, timezone: tz, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  // Le notifiche che escono tengono lingua e fuso in cache: anche il fuso.
  const { invalidateNotificationLocale } = await import('@opengraphity/notifications')
  invalidateNotificationLocale(tenantId)
  return tz
}
