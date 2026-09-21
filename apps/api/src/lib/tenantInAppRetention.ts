/**
 * QUANTI GIORNI SI CONSERVANO LE NOTIFICHE DELLA CAMPANELLA — scelta di ogni
 * organizzazione (verifica «Cosa resta cablato», ondata 2).
 *
 * Era `INAPP_NOTIFICATION_RETENTION_DAYS`, una variabile d'ambiente uguale per
 * tutti i clienti, mentre la conservazione degli allarmi stava già nella Policy
 * eventi del cliente: due regole diverse per la stessa domanda. Ora è
 * `Tenant.inapp_notification_retention_days`, dalla pagina Organizzazione.
 *
 * Non configurata = la pulizia notturna salta quel cliente e la diagnostica lo
 * dice: cancellare dati con una durata che nessuno ha scelto non è un ripiego
 * accettabile.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'

export const INAPP_RETENTION_MIN_DAYS = 1
export const INAPP_RETENTION_MAX_DAYS = 3650

export function assertInAppRetentionDays(value: unknown): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < INAPP_RETENTION_MIN_DAYS || n > INAPP_RETENTION_MAX_DAYS) {
    throw new ValidationError(
      `Notifications are kept for a whole number of days between ${String(INAPP_RETENTION_MIN_DAYS)} and ${String(INAPP_RETENTION_MAX_DAYS)} (got ${JSON.stringify(value)}).`,
      { key: 'errors.tenant.inAppRetention', params: { min: INAPP_RETENTION_MIN_DAYS, max: INAPP_RETENTION_MAX_DAYS } },
    )
  }
  return n
}

/** I giorni di conservazione del cliente, o `null` se non li ha scelti. */
export async function tenantInAppRetentionDays(tenantId: string): Promise<number | null> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ days: unknown }>(session,
      'MATCH (t:Tenant {id: $tenantId}) RETURN t.inapp_notification_retention_days AS days', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    return row.days == null ? null : assertInAppRetentionDays(Number(row.days))
  } finally {
    await session.close()
  }
}

export async function setTenantInAppRetentionDays(tenantId: string, days: unknown): Promise<number> {
  const value = assertInAppRetentionDays(days)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.inapp_notification_retention_days = $days, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, days: value, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  return value
}

/** Ogni cliente con la sua scelta (`null` = non configurata): la legge la pulizia notturna. */
export async function inAppRetentionByTenant(): Promise<Array<{ tenantId: string; days: number | null }>> {
  const session = getSession()
  try {
    const rows = await runQuery<{ tenantId: string; days: unknown }>(session,
      "MATCH (t:Tenant) WHERE t.id <> 'system' RETURN t.id AS tenantId, t.inapp_notification_retention_days AS days ORDER BY tenantId", {})
    return rows.map((r) => ({ tenantId: r.tenantId, days: r.days == null ? null : Number(r.days) }))
  } finally {
    await session.close()
  }
}
