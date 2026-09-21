/**
 * Verifica «Cosa resta cablato», ondata 2: la conservazione delle notifiche
 * della campanella diventa una scelta di ogni organizzazione
 * (`Tenant.inapp_notification_retention_days`).
 *
 * Il primo giorno non cambia niente: ogni organizzazione riceve la durata in
 * vigore finora, cioè `INAPP_NOTIFICATION_RETENTION_DAYS` se l'installazione
 * la impostava, altrimenti 30 (il valore che il worker usava quando la
 * variabile mancava).
 *
 * Idempotente: non tocca chi ha già una durata.
 */
import type { Migration } from '@opengraphity/neo4j'

const tag = '[20260925_1100_inapp_retention_per_tenant]'
/** La durata che il worker usava senza variabile d'ambiente (maintenance.worker.ts fino all'ondata 1). */
const PREVIOUS_DEFAULT_DAYS = 30

function daysInEffect(): number {
  const raw = process.env['INAPP_NOTIFICATION_RETENTION_DAYS']
  if (raw === undefined || raw === '') return PREVIOUS_DEFAULT_DAYS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${tag} INAPP_NOTIFICATION_RETENTION_DAYS is set but not an integer >= 1: fix or remove it before migrating`)
  return n
}

export const inAppRetentionPerTenant: Migration = {
  id: '20260925_1100_inapp_retention_per_tenant',
  description: 'Tenant.inapp_notification_retention_days: la conservazione delle notifiche in-app per organizzazione',
  async up(session) {
    const days = daysInEffect()
    const r = await session.run(`
      MATCH (t:Tenant) WHERE t.id <> 'system' AND t.inapp_notification_retention_days IS NULL
      SET t.inapp_notification_retention_days = $days
      RETURN collect(t.id) AS tenants
    `, { days })
    const tenants = (r.records[0]?.get('tenants') ?? []) as string[]
    console.log(`${tag} ${tenants.length ? `${tenants.join(', ')}: ${String(days)} giorni` : 'niente da fare'}`)
  },
}
