/**
 * Event Management — allarmi «bloccati»: il predicato UNICO che dice quali
 * eventi firing nessuno sta più curando (revisione 2 · B2-01, B2-02).
 *
 * Prima della revisione 2 il gauge `events_firing_uncorrelated` (gauges.ts) e
 * la passata periodica `reevaluatePendingEvents` (passes.ts) usavano due
 * predicati DIVERSI: il gauge contava ogni firing con correlazione
 * `none`/`pending` più vecchio della grazia, la passata esigeva
 * `correlation_due_at IS NOT NULL`. Un Event nasce (e riparte a ogni nuovo
 * ciclo) con `correlation = 'none'` e scadenza nulla: se la pipeline falliva
 * tutti i tentativi restava acceso, contato dal gauge e ripreso da nessuno —
 * nel Neo4j locale 17 allarmi critici senza incident per 15 ore. Qui il
 * predicato è uno solo, quindi i due non possono più divergere: la metrica
 * misura esattamente ciò che la passata ripara.
 *
 * Tre casi, in OR (un evento ne soddisfa almeno uno per essere ripreso):
 *  - `due`         — correlazione `pending`/`none` con la scadenza passata (il
 *                    caso storico: fine soppressione o stabilizzazione la cui
 *                    correlazione è fallita);
 *  - `uncorrelated`— correlazione `pending`/`none` SENZA scadenza, ferma da più
 *                    di UNCORRELATED_AFTER_MINUTES (dall'ultima scrittura della
 *                    correlazione, o dalla prima ricezione se mai scritta);
 *  - `delayed`     — ritardo di apertura (`open_delay_seconds`) la cui scadenza
 *                    è passata da più di OVERDUE_DELAYED_GRACE_MINUTES: il job
 *                    `correlate` non è mai arrivato (coda ferma, job id già
 *                    usato). Riprenderlo dalla passata è sicuro: la pipeline in
 *                    `reevaluate` salta il passo del ritardo.
 * Gli esiti `skipped_*` sono decisioni, non residui, e non compaiono qui.
 */

/** Correlazioni «senza esito» riprese dalla passata periodica e contate dal gauge. */
export const PENDING_CORRELATIONS: readonly string[] = ['pending', 'none']

/** Grazia oltre la scadenza di un `delayed` prima di considerarlo perso. */
export const OVERDUE_DELAYED_GRACE_MINUTES = 5
/** Quanto può restare un firing senza esito di correlazione prima di essere considerato bloccato. */
export const UNCORRELATED_AFTER_MINUTES = 15

/** Correlazione `pending`/`none` con la scadenza passata (`e` = Event già filtrato a `status: 'firing'`). */
export const DUE_CORRELATION_WHERE = 'e.correlation IN $correlations AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at <= $now'
/** Correlazione `pending`/`none` ferma da più di UNCORRELATED_AFTER_MINUTES (con o senza scadenza). */
export const UNCORRELATED_WHERE = 'e.correlation IN $correlations AND coalesce(e.correlation_at, e.first_seen_at) < $uncorrelatedCutoff'
/** Ritardo di apertura scaduto da più di OVERDUE_DELAYED_GRACE_MINUTES. */
export const OVERDUE_DELAYED_WHERE = "e.correlation = 'delayed' AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at < $delayedCutoff"

/** Unione dei tre casi: il predicato della passata `reevaluatePendingEvents`. */
export const STUCK_FIRING_WHERE = `(${DUE_CORRELATION_WHERE}) OR (${UNCORRELATED_WHERE}) OR (${OVERDUE_DELAYED_WHERE})`

/** Parametri dei predicati: gli stessi per il gauge e per la passata (nessuna soglia duplicata a mano). */
export interface StuckEventParams {
  correlations: readonly string[]
  now: string
  uncorrelatedCutoff: string
  delayedCutoff: string
}

export function stuckEventParams(now: string): StuckEventParams {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`stuckEventParams: "${now}" is not an ISO date`)
  return {
    correlations: PENDING_CORRELATIONS,
    now,
    uncorrelatedCutoff: new Date(nowMs - UNCORRELATED_AFTER_MINUTES * 60_000).toISOString(),
    delayedCutoff:      new Date(nowMs - OVERDUE_DELAYED_GRACE_MINUTES * 60_000).toISOString(),
  }
}
