/**
 * Event Management — ondata 4: conservazione degli eventi.
 *
 * `purgeResolvedEvents` elimina, per ogni :Tenant, gli `Event` in stato
 * `resolved` con `resolved_at` più vecchio di `retention_days` della policy
 * del tenant, in batch da PURGE_BATCH_SIZE (`CALL { … } IN TRANSACTIONS`, che
 * richiede una sessione auto-commit: runQuery usa `session.run`). Gli eventi
 * `firing`, `suppressed` e `flapping` non vengono mai toccati, qualunque sia
 * la loro età. `retention_days = 0` significa "mai" (nessuna cancellazione).
 *
 * Eseguita dal job ripetibile `purge_events` del maintenance worker (03:30);
 * esportata per poterla lanciare a mano. Un errore su un tenant (policy
 * mancante/corrotta, query fallita) non ferma gli altri ma fa fallire il job.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { eventsPurgedTotal } from '../middleware/metrics.js'
import { getEventPolicy } from './eventService.js'

const log = logger.child({ module: 'event-retention' })

export const PURGE_BATCH_SIZE = 1000

export interface TenantPurge { tenantId: string; retentionDays: number; cutoff: string | null; purged: number }
export interface PurgeResult { tenants: number; purged: number; failed: number; perTenant: TenantPurge[] }

function toNumber(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'object' && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
  return Number(v)
}

/** Istante ISO oltre il quale (all'indietro) gli eventi risolti sono da eliminare. */
export function retentionCutoff(nowMs: number, retentionDays: number): string {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new Error(`retentionCutoff: retention_days must be an integer >= 1, got ${JSON.stringify(retentionDays)}`)
  return new Date(nowMs - retentionDays * 24 * 3600 * 1000).toISOString()
}

/** Elimina (con le relazioni) gli eventi risolti di UN tenant più vecchi di `cutoff`; restituisce quanti erano. */
export async function purgeTenantResolvedEvents(tenantId: string, cutoff: string): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  try {
    const counted = await runQueryOne<{ n: unknown }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'resolved'})
      WHERE e.resolved_at IS NOT NULL AND e.resolved_at < $cutoff
      RETURN count(e) AS n
    `, { tenantId, cutoff })
    const n = toNumber(counted?.n)
    if (n === 0) return 0
    await runQuery(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'resolved'})
      WHERE e.resolved_at IS NOT NULL AND e.resolved_at < $cutoff
      CALL { WITH e DETACH DELETE e } IN TRANSACTIONS OF ${PURGE_BATCH_SIZE} ROWS
    `, { tenantId, cutoff })
    return n
  } finally { await session.close() }
}

export async function purgeResolvedEvents(now: Date = new Date()): Promise<PurgeResult> {
  const session = getSession()
  let tenantIds: string[]
  try {
    // tenant-ok: job di manutenzione su tutti i tenant; ogni cancellazione è scopata sul suo tenant
    const rows = await runQuery<{ id: string }>(session, `
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id ORDER BY t.id
    `, {})
    tenantIds = rows.map((r) => r.id)
  } finally { await session.close() }

  const perTenant: TenantPurge[] = []
  let purged = 0
  let failed = 0
  for (const tenantId of tenantIds) {
    try {
      const policy = await getEventPolicy(tenantId)
      if (policy.retention_days === 0) {
        perTenant.push({ tenantId, retentionDays: 0, cutoff: null, purged: 0 })
        log.info({ tenantId }, 'Event retention disabled for tenant (retention_days = 0): nothing purged')
        continue
      }
      const cutoff = retentionCutoff(now.getTime(), policy.retention_days)
      const n = await purgeTenantResolvedEvents(tenantId, cutoff)
      purged += n
      if (n > 0) eventsPurgedTotal.inc({}, n)
      perTenant.push({ tenantId, retentionDays: policy.retention_days, cutoff, purged: n })
      log.info({ tenantId, retentionDays: policy.retention_days, cutoff, purged: n }, 'Resolved events purged')
    } catch (err) {
      failed++
      log.error({ err, tenantId }, 'Event purge failed for tenant')
    }
  }
  if (failed > 0) throw new Error(`purgeResolvedEvents: ${failed}/${tenantIds.length} tenants failed (see logs); purged ${purged} events on the others`)
  return { tenants: tenantIds.length, purged, failed, perTenant }
}
