/**
 * Event Management — ondata 4: conservazione degli eventi.
 *
 * `purgeResolvedEvents` elimina, per ogni :Tenant, gli `Event` in stato
 * `resolved` con `resolved_at` più vecchio di `retention_days` della policy
 * del tenant, in batch da PURGE_BATCH_SIZE (`CALL { … } IN TRANSACTIONS`, che
 * richiede una sessione auto-commit: runQuery usa `session.run` — pinnato dal
 * test eventRetentionAutocommit.test.ts). Gli eventi `firing`, `suppressed` e
 * `flapping` non vengono mai toccati, qualunque sia la loro età.
 * `retention_days = 0` significa "mai" (nessuna cancellazione).
 *
 * La conservazione rispetta la storia (revisione 2.2): un evento correlato
 * (CORRELATED_INTO) a un incident NON chiuso — cioè in un passo non terminale
 * oppure in `resolved`, che il monitoraggio riapre se l'allarme torna — o
 * silenziato (SUPPRESSED_BY) da una change NON chiusa non viene mai eliminato,
 * qualunque sia la sua età. Quando l'incident/la change sono chiusi e l'evento
 * è oltre la retention, l'evento viene eliminato ma il padre conserva un
 * riepilogo (`Incident.correlated_events_purged`, `Change.suppressed_events_purged`,
 * +1 per evento eliminato, nella STESSA transazione del batch), esposto come
 * `Incident.correlatedEventsPurged` / `Change.suppressedEventsPurged`, così la
 * UI può dire "N allarmi eliminati per conservazione" invece di mostrare una
 * sezione vuota.
 *
 * Il conteggio restituito è quello della STESSA query che cancella (`RETURN
 * count(*)` dopo il CALL; revisione 2.3): prima era una count separata, e un
 * evento risolto o riacceso fra le due dava un numero diverso da quanto
 * cancellato davvero.
 *
 * Eseguita dal job ripetibile `purge_events` del maintenance worker (03:30);
 * esportata per poterla lanciare a mano. Un errore su un tenant (policy
 * mancante/corrotta, query fallita, workflow senza passo resolved) non ferma
 * gli altri ma fa fallire il job.
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { getWorkflowSteps } from '../lib/workflowHelpers.js'
import { eventsPurgedTotal } from '../middleware/metrics.js'
import { getEventPolicy } from './events/policy.js'
import { incidentStepInfo } from './events/incidentWorkflow.js'
import { toNumber } from './events/shared.js'

const log = logger.child({ module: 'event-retention' })

export const PURGE_BATCH_SIZE = 1000

export interface TenantPurge { tenantId: string; retentionDays: number; cutoff: string | null; purged: number }
export interface PurgeResult { tenants: number; purged: number; failed: number; perTenant: TenantPurge[] }

/** Istante ISO oltre il quale (all'indietro) gli eventi risolti sono da eliminare. */
export function retentionCutoff(nowMs: number, retentionDays: number): string {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) throw new Error(`retentionCutoff: retention_days must be an integer >= 1, got ${JSON.stringify(retentionDays)}`)
  return new Date(nowMs - retentionDays * 24 * 3600 * 1000).toISOString()
}

/**
 * Passi "chiusi" di incident e change del tenant: un evento collegato a un
 * padre in un altro passo è storia viva e non si elimina. Per l'incident solo
 * i passi terminali diversi da `resolved` (come findOpenIncidentForGroup: un
 * incident risolto viene riaperto dal monitoraggio, non è definitivo); per la
 * change i passi terminali della sua definizione. Un workflow senza passo
 * terminale → errore: senza il concetto di "chiuso" nessun evento collegato
 * potrebbe mai essere eliminato in modo consapevole.
 */
export async function closedSteps(tenantId: string): Promise<{ incident: string[]; change: string[] }> {
  const session = getSession()
  try {
    const info = await incidentStepInfo(session, tenantId)
    const incident = info.terminalSteps.filter((s) => s !== info.resolvedStep)
    const change = (await getWorkflowSteps(session, tenantId, 'change')).filter((s) => s.isTerminal).map((s) => s.name)
    if (incident.length === 0) throw new Error(`Tenant ${tenantId}: incident workflow has no terminal step other than "${info.resolvedStep}"`)
    if (change.length === 0) throw new Error(`Tenant ${tenantId}: change workflow has no terminal step`)
    return { incident, change }
  } finally { await session.close() }
}

/**
 * Elimina (con le relazioni) gli eventi risolti di UN tenant più vecchi di
 * `cutoff` che non sono collegati a un incident/change ancora aperti, lasciando
 * sul padre chiuso il conteggio degli eventi eliminati; restituisce quanti ne
 * ha cancellati. `closed` = passi chiusi di incident e change (closedSteps).
 */
export async function purgeTenantResolvedEvents(tenantId: string, cutoff: string, closed: { incident: string[]; change: string[] }): Promise<number> {
  const session = getSession(undefined, 'WRITE')
  try {
    // `CALL { … } IN TRANSACTIONS` vuole una sessione auto-commit (session.run,
    // mai dentro executeWrite): ogni batch è una transazione propria, e il
    // riepilogo sul padre viene scritto nello stesso batch della cancellazione.
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'resolved'})
      WHERE e.resolved_at IS NOT NULL AND e.resolved_at < $cutoff
        AND NOT EXISTS {
          MATCH (e)-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
          WHERE NOT wi.current_step IN $closedIncidentSteps
        }
        AND NOT EXISTS {
          MATCH (e)-[:SUPPRESSED_BY]->(c:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(cwi:WorkflowInstance {tenant_id: $tenantId})
          WHERE NOT cwi.current_step IN $closedChangeSteps
        }
      CALL {
        WITH e
        OPTIONAL MATCH (e)-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
        SET i.correlated_events_purged = coalesce(i.correlated_events_purged, 0) + 1
        WITH DISTINCT e
        OPTIONAL MATCH (e)-[:SUPPRESSED_BY]->(c:Change {tenant_id: $tenantId})
        SET c.suppressed_events_purged = coalesce(c.suppressed_events_purged, 0) + 1
        WITH DISTINCT e
        DETACH DELETE e
      } IN TRANSACTIONS OF ${PURGE_BATCH_SIZE} ROWS
      RETURN count(*) AS n
    `, { tenantId, cutoff, closedIncidentSteps: closed.incident, closedChangeSteps: closed.change })
    return toNumber(row?.n)
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
      const n = await purgeTenantResolvedEvents(tenantId, cutoff, await closedSteps(tenantId))
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
