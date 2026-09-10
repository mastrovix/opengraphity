/**
 * Gauge di salute dell'Event Management, riallineati dalla passata periodica
 * (revisione, §4 Osservabilità): rilevano gli eventi che nessun job riprende.
 *
 * - `events_overdue_delayed`: eventi `delayed` la cui scadenza
 *   (`correlation_due_at`) è passata da più di OVERDUE_DELAYED_GRACE_MINUTES:
 *   il job `correlate` non è arrivato (coda ferma, job id già usato — 1.11).
 * - `events_firing_uncorrelated`: eventi firing con correlazione `none` o
 *   `pending` da più di UNCORRELATED_AFTER_MINUTES (dall'ultima scrittura della
 *   correlazione, o dalla prima ricezione se mai scritta): pipeline fallita a
 *   ogni tentativo e mai ripresa (1.2). Gli esiti `skipped_*` sono decisioni,
 *   non residui, e non contano.
 * Sono conteggi su tutti i tenant (metrica di processo, come event_storms_active).
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { eventsFiringUncorrelated, eventsOverdueDelayed } from '../../middleware/metrics.js'
import { toNumber } from './shared.js'
import { PENDING_CORRELATIONS } from './passes.js'

export const OVERDUE_DELAYED_GRACE_MINUTES = 5
export const UNCORRELATED_AFTER_MINUTES = 15

export interface EventGauges { overdueDelayed: number; firingUncorrelated: number }

export async function refreshEventGauges(now: string = new Date().toISOString()): Promise<EventGauges> {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`refreshEventGauges: "${now}" is not an ISO date`)
  const session = getSession()
  try {
    const overdue = await runQueryOne<{ n: unknown }>(session, `
      // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
      MATCH (e:Event {status: 'firing', correlation: 'delayed'})
      WHERE e.correlation_due_at IS NOT NULL AND e.correlation_due_at < $cutoff
      RETURN count(e) AS n
    `, { cutoff: new Date(nowMs - OVERDUE_DELAYED_GRACE_MINUTES * 60_000).toISOString() })
    const uncorrelated = await runQueryOne<{ n: unknown }>(session, `
      // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
      MATCH (e:Event {status: 'firing'})
      WHERE e.correlation IN $correlations AND coalesce(e.correlation_at, e.first_seen_at) < $cutoff
      RETURN count(e) AS n
    `, { correlations: PENDING_CORRELATIONS, cutoff: new Date(nowMs - UNCORRELATED_AFTER_MINUTES * 60_000).toISOString() })
    const out = { overdueDelayed: toNumber(overdue?.n), firingUncorrelated: toNumber(uncorrelated?.n) }
    eventsOverdueDelayed.set({}, out.overdueDelayed)
    eventsFiringUncorrelated.set({}, out.firingUncorrelated)
    return out
  } finally { await session.close() }
}
