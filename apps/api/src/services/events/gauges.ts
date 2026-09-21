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
 *
 * Revisione 2 · B2-01: i due predicati vengono da stuck.ts, lo stesso modulo
 * che alimenta la passata `reevaluatePendingEvents` — il gauge misura
 * esattamente ciò che la passata ripara, e non possono più divergere.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { eventsFiringUncorrelated, eventsOverdueDelayed } from '../../middleware/metrics.js'
import { toNumber } from './shared.js'
import { OVERDUE_DELAYED_WHERE, UNCORRELATED_WHERE, stuckEventParams } from './stuck.js'

export interface EventGauges { overdueDelayed: number; firingUncorrelated: number }

export async function refreshEventGauges(now: string = new Date().toISOString()): Promise<EventGauges> {
  const params = stuckEventParams(now)
  const session = getSession()
  try {
    const overdue = await runQueryOne<{ n: unknown }>(session, `
      // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
      MATCH (e:Event {status: 'firing'})
      WHERE ${OVERDUE_DELAYED_WHERE}
      RETURN count(e) AS n
    `, { delayedCutoff: params.delayedCutoff })
    const uncorrelated = await runQueryOne<{ n: unknown }>(session, `
      // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
      MATCH (e:Event {status: 'firing'})
      WHERE ${UNCORRELATED_WHERE}
      RETURN count(e) AS n
    `, { correlations: params.correlations, uncorrelatedCutoff: params.uncorrelatedCutoff })
    const out = { overdueDelayed: toNumber(overdue?.n), firingUncorrelated: toNumber(uncorrelated?.n) }
    eventsOverdueDelayed.set({}, out.overdueDelayed)
    eventsFiringUncorrelated.set({}, out.firingUncorrelated)
    return out
  } finally { await session.close() }
}
