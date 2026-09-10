/**
 * Event Management — la pipeline di correlazione: SOLO l'ordine dei passi.
 *
 * `runEventPipeline` è l'unico punto d'ingresso, chiamato da `ingestEvent`
 * (ingest.ts) DOPO deduplica e aggancio al CI, e da ogni rivalutazione
 * (mutation `reevaluateEvent`, `linkEventToCI`, fine finestra di una change,
 * job periodico, job ritardato — passes.ts e jobs/eventCorrelateWorker.ts).
 * Ordine fisso:
 *
 *   0. sfarfallio     — flapping.ts: un evento `flapping` non viene correlato;
 *                       all'ingest il rilevamento (Event.transitions).
 *   0b. tempesta      — storm.ts: all'ingest si aggiorna il contatore della
 *                       sorgente (e si apre/chiude la tempesta), nelle
 *                       rivalutazioni si legge soltanto.
 *   1. soppressione   — suppression.ts: change in finestra sul CI o a monte →
 *                       `suppressed`, niente salute, niente incident.
 *   2. salute del CI  — ciHealth.ts, solo se non soppresso.
 *   2b. tempesta      — grouping.correlateIntoStorm: aggancio all'incident di
 *                       tempesta, niente correlazione per CI.
 *   3–6. correlazione — grouping.correlateFiringEvent: soglia, orfano,
 *                       ritardo, raggruppamento (apri / aggancia / riapri).
 *   7. chiusura       — autoResolve.ts: evento `resolved` con incident correlato.
 *
 * Questo modulo non importa MAI ingest.ts né passes.ts (nessun ciclo: chi
 * chiama la pipeline sta sopra di lei). La policy del tenant è letta UNA volta
 * qui e passata a ogni passo (M11); la sessione Neo4j è UNA per pipeline
 * (M11: prima una per statement). Ogni esito finisce in
 * `events_correlated_total{outcome}` (`error` se la pipeline lancia) e la
 * durata in `event_pipeline_duration_seconds{mode}`.
 *
 * Niente fallback silenziosi: policy mancante, workflow senza passo
 * "resolved", transizione di riapertura assente o fallita → errore (il job
 * BullMQ ritenta e resta visibile).
 */
import { getSession } from '@opengraphity/neo4j'
import { eventPipelineDurationSeconds, eventsCorrelatedTotal } from '../../middleware/metrics.js'
import { MONITORING_ACTOR, toStr } from './shared.js'
import { getEventPolicy } from './policy.js'
import { loadEventRecord } from './repo.js'
import { recomputeCIHealth } from './ciHealth.js'
import { transitionsOf } from './transitions.js'
import { enterFlapping, isFlapping } from './flapping.js'
import { applySuppression, findSuppressingChange, liftSuppression } from './suppression.js'
import { correlateFiringEvent, correlateIntoStorm } from './grouping.js'
import { handleResolvedEvent } from './autoResolve.js'
import { getStormState, trackSourceStorm } from './storm.js'
import type { PipelineInput, PipelineResult } from './types.js'

export async function runEventPipeline(input: PipelineInput): Promise<PipelineResult> {
  const mode = input.mode ?? 'ingest'
  const startedAt = performance.now()
  let outcome = 'error'
  try {
    const result = await run(input)
    outcome = result.outcome
    return result
  } finally {
    eventsCorrelatedTotal.inc({ outcome })
    eventPipelineDurationSeconds.observe({ mode }, (performance.now() - startedAt) / 1000)
  }
}

async function run(input: PipelineInput): Promise<PipelineResult> {
  const { tenantId, eventId } = input
  const mode = input.mode ?? 'ingest'
  const now = input.now ?? new Date().toISOString()
  const actorId = input.actorId ?? MONITORING_ACTOR

  // `return await` obbligatorio nei passi: con un semplice `return promessa`
  // il `finally` chiuderebbe la sessione PRIMA che il passo abbia finito di
  // usarla ("You cannot run more transactions on a closed session").
  const session = getSession(undefined, 'WRITE')
  try {
    // Copia del record dell'ingest: i passi mutano `ev.props` (fine soppressione).
    const ev = input.record
      ? { props: { ...input.record.props }, ciId: input.record.ciId }
      : await loadEventRecord(session, tenantId, eventId)
    const status = toStr(ev.props['status'])
    const policy = await getEventPolicy(tenantId)
    // Contesto comune dei log della pipeline: l'impronta ritrova l'allarme sullo strumento, il job id in coda.
    const logCtx: Record<string, unknown> = { fingerprint: toStr(ev.props['fingerprint']), mode }
    if (input.jobId !== undefined) logCtx['jobId'] = input.jobId

    // 0. sfarfallio in corso: nessuna correlazione, la salute (degraded) resta aggiornata
    if (status === 'flapping') {
      if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
      return { outcome: 'flapping', status, suppressedByChangeId: null, incidentId: null }
    }
    // 0. rilevamento: solo all'ingest, dove i passaggi vengono registrati
    if (mode === 'ingest' && isFlapping(transitionsOf(ev.props), policy, now)) {
      return await enterFlapping(session, tenantId, ev, policy, actorId, now, logCtx)
    }
    // 0b. tempesta della sorgente: all'ingest si aggiorna il contatore (e si
    // apre/chiude la tempesta), nelle rivalutazioni si legge soltanto.
    const sourceId = toStr(ev.props['source_id'])
    const storm = mode === 'ingest'
      ? await trackSourceStorm({ tenantId, sourceId, created: input.created === true, policy, now, actorId, ciId: ev.ciId })
      : await getStormState(tenantId, sourceId)

    if (status === 'resolved') return await handleResolvedEvent(session, tenantId, ev, policy, actorId, now, mode, storm, logCtx)

    if (mode === 'resume') {
      if (status === 'suppressed') return { outcome: 'suppressed', status, suppressedByChangeId: toStr(ev.props['suppressed_by_change_id']) || null, incidentId: null }
      if (storm.active) return await correlateIntoStorm(session, tenantId, ev, policy, storm, actorId, now, mode, logCtx)
      return await correlateFiringEvent(session, tenantId, ev, policy, actorId, now, mode, logCtx)
    }

    // 1. soppressione: blocca salute e correlazione
    if (ev.ciId) {
      const change = await findSuppressingChange(tenantId, ev.ciId, policy.suppress_upstream_hops, now)
      if (change) {
        await applySuppression(session, tenantId, ev, change, actorId, now, mode, logCtx)
        return { outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: change.changeId, incidentId: null }
      }
    }
    if (status === 'suppressed') {
      await liftSuppression(session, tenantId, eventId, now)
      ev.props['status'] = 'firing'
      ev.props['suppressed_by_change_id'] = null
      ev.props['correlation'] = 'pending'
    }
    // 2. salute del CI
    if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
    // 2b. tempesta: aggancio all'incident di tempesta, niente correlazione per CI
    if (storm.active) return await correlateIntoStorm(session, tenantId, ev, policy, storm, actorId, now, mode, logCtx)
    // 3–6
    return await correlateFiringEvent(session, tenantId, ev, policy, actorId, now, mode, logCtx)
  } finally { await session.close() }
}
