/**
 * Rivalutazioni che stanno SOPRA la pipeline: fine finestra di una change e
 * passate periodiche paginate (coda `events-maintenance`,
 * jobs/eventCorrelateWorker.ts). Questo modulo importa pipeline.ts; la
 * pipeline non importa mai questo modulo.
 *
 * Stati ritentabili (1.2): fine soppressione e stabilizzazione NON scrivono
 * uno stato "libero" prima di aver correlato: scrivono `correlation =
 * 'pending'` con `correlation_due_at = now` e correlano nella stessa unità;
 * se la correlazione fallisce l'evento resta firing/pending e la passata
 * periodica `reevaluatePendingEvents` lo riprende (firing con correlation
 * pending/none e scadenza passata).
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { runPagedPass, type PagedPassResult } from '../../lib/pagedPass.js'
import type { EventPolicy } from '../../lib/eventPolicy.js'
import { MONITORING_ACTOR, mapEventPayload, monitoringContext, toStr, type Props } from './shared.js'
import { getEventPolicy } from './policy.js'
import { loadEventRecord } from './repo.js'
import { transitionsOf } from './transitions.js'
import { historyParams, historyWriteCypher } from './history.js'
import { isStable, type EventStablePayload } from './flapping.js'
import { runEventPipeline } from './pipeline.js'
import type { EventRecord } from './types.js'

const log = logger.child({ module: 'event-correlation' })

/** Correlazioni riprese dalla passata periodica `reevaluatePendingEvents` (con `correlation_due_at` scaduta). */
export const PENDING_CORRELATIONS: readonly string[] = ['pending', 'none']

// ── Fine finestra ────────────────────────────────────────────────────────────

/**
 * Rivaluta gli eventi ancora silenziati da una change (job
 * `reevaluate-change-window`, accodato quando la change esce dai passi di
 * finestra; vedi graphql/resolvers/change/autoTransitions.ts; e
 * `deleteChange`). Ogni evento rientra nella pipeline: se un'altra change lo
 * copre resta soppresso, altrimenti torna firing e viene correlato. Un errore
 * su un evento non ferma gli altri ma fa fallire il job alla fine (ritenta; la
 * passata periodica è la rete di sicurezza). Restituisce il numero di eventi
 * rivalutati.
 *
 * Attori (3.4): `actorId` è chi ha causato la rivalutazione — l'utente che ha
 * eliminato la change, o `monitoring` dal job/dalla passata — e diventa
 * l'`actor_id` degli eventi di dominio (`event.correlated`, `event.suppressed`:
 * la notifica dice chi ha innescato la rivalutazione). Incident, commenti e
 * audit restano SEMPRE del monitoraggio (è la correlazione automatica ad
 * aprire/riaprire); l'utente resta nel log (`triggeredBy`) e nell'audit della
 * mutation che ha mosso la change.
 */
export async function reevaluateSuppressedEvents(tenantId: string, changeId: string, actorId: string = MONITORING_ACTOR): Promise<number> {
  const session = getSession()
  let ids: string[]
  try {
    const rows = await runQuery<{ id: string }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'suppressed', suppressed_by_change_id: $changeId})
      RETURN e.id AS id ORDER BY e.last_seen_at DESC
    `, { tenantId, changeId })
    ids = rows.map((r) => r.id)
  } finally { await session.close() }
  let failed = 0
  for (const eventId of ids) {
    try {
      await runEventPipeline({ tenantId, eventId, actorId, mode: 'reevaluate' })
    } catch (err) {
      failed++
      log.error({ err, tenantId, changeId, eventId }, 'Suppressed event re-evaluation after change window failed')
    }
  }
  if (ids.length) log.info({ tenantId, changeId, count: ids.length, failed, triggeredBy: actorId }, 'Suppressed events re-evaluated after change window')
  if (failed > 0) throw new Error(`reevaluateSuppressedEvents: ${failed}/${ids.length} events suppressed by change ${changeId} failed re-evaluation (see logs)`)
  return ids.length
}

// ── Passate periodiche (coda events-maintenance) ─────────────────────────────

interface EventRef { tenantId: string; id: string }

/** Una pagina di (tenant, evento) con id > cursor, ordinata per id. `match` è il MATCH … WHERE … (senza RETURN). */
async function fetchEventPage(match: string, params: Props, cursor: string, limit: number): Promise<EventRef[]> {
  const session = getSession()
  try {
    // tenant-ok: job di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
    return await runQuery<EventRef>(session, `
      ${match}
      RETURN e.tenant_id AS tenantId, e.id AS id
      ORDER BY e.id LIMIT toInteger($limit)
    `, { ...params, cursor, limit })
  } finally { await session.close() }
}

/** Passata paginata che ripassa ogni riga dalla pipeline in `reevaluate`. */
async function reevaluatePass(name: string, match: string, params: Props, now: string, what: string): Promise<PagedPassResult> {
  const result = await runPagedPass<EventRef>({
    fetchPage: (cursor, limit) => fetchEventPage(match, params, cursor, limit),
    keyOf: (r) => r.id,
    handle: async (r) => { await runEventPipeline({ tenantId: r.tenantId, eventId: r.id, now, mode: 'reevaluate' }) },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, eventId: r.id }, `${what} re-evaluation failed`),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, `${name}: page cap reached, remaining events are re-evaluated on the next pass`)
  if (result.failed > 0) throw new Error(`${name}: ${result.failed}/${result.evaluated} ${what} events failed re-evaluation (see logs)`)
  return result
}

/**
 * Job periodico: ogni evento soppresso (di ogni tenant) viene rivalutato; quelli
 * la cui finestra è chiusa tornano firing. Paginato; un errore su un evento
 * non ferma gli altri, ma alla fine fa fallire il job (visibile in coda).
 */
export async function reevaluateClosedWindows(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
  return reevaluatePass('reevaluateClosedWindows', `MATCH (e:Event {status: 'suppressed'})\n      WHERE e.id > $cursor`, {}, now, 'suppressed')
}

/**
 * Job periodico: gli eventi firing rimasti senza correlazione — `pending`
 * (fine soppressione / stabilizzazione la cui correlazione è fallita) o
 * `none` con una scadenza — con `correlation_due_at` passata rientrano nella
 * pipeline. È la rete di sicurezza degli stati ritentabili: nessun allarme
 * attivo resta senza incident per ore in silenzio.
 */
export async function reevaluatePendingEvents(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
  return reevaluatePass('reevaluatePendingEvents', `MATCH (e:Event {status: 'firing'})
      WHERE e.correlation IN $correlations AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at <= $now AND e.id > $cursor`,
    { correlations: PENDING_CORRELATIONS, now }, now, 'pending')
}

/**
 * Job periodico: ogni evento `flapping` (di ogni tenant) senza passaggi da
 * `flap_stable_minutes` torna allo stato dell'ultimo payload, pubblica
 * `event.stable` e ripassa dalla pipeline (`reevaluate`: correlazione se
 * firing, chiusura automatica se resolved). Paginato (lib/pagedPass.ts); un
 * errore su un evento non ferma gli altri ma fa fallire il job.
 */
export async function reevaluateFlappingEvents(now: string = new Date().toISOString()): Promise<PagedPassResult & { stabilized: number }> {
  const policies = new Map<string, EventPolicy>()
  let stabilized = 0
  const result = await runPagedPass<EventRef>({
    // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi trattato nel suo tenant.
    fetchPage: (cursor, limit) => fetchEventPage(`MATCH (e:Event {status: 'flapping'})\n      WHERE e.id > $cursor`, {}, cursor, limit),
    keyOf: (r) => r.id,
    handle: async (r) => {
      let policy = policies.get(r.tenantId)
      if (!policy) { policy = await getEventPolicy(r.tenantId); policies.set(r.tenantId, policy) }
      const session = getSession()
      let ev: EventRecord
      try { ev = await loadEventRecord(session, r.tenantId, r.id) } finally { await session.close() }
      if (!isStable(transitionsOf(ev.props), policy.flap_stable_minutes, now)) return
      await stabilizeEvent(r.tenantId, ev, policy, now)
      stabilized++
    },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, eventId: r.id }, 'Flapping event stabilisation failed'),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, 'reevaluateFlappingEvents: page cap reached, remaining flapping events are checked on the next pass')
  if (result.failed > 0) throw new Error(`reevaluateFlappingEvents: ${result.failed}/${result.evaluated} flapping events failed stabilisation (see logs)`)
  return { ...result, stabilized }
}

/**
 * Torna allo stato dell'ultimo payload. Se è `firing` l'evento resta
 * `pending` (con `correlation_due_at = now`) finché la pipeline che segue non
 * lo correla: se questa fallisce lo riprende `reevaluatePendingEvents`.
 */
async function stabilizeEvent(tenantId: string, ev: EventRecord, policy: EventPolicy, now: string): Promise<void> {
  const eventId = toStr(ev.props['id'])
  const last = ev.props['last_payload_status']
  if (last !== 'firing' && last !== 'resolved') throw new Error(`Event ${eventId} is flapping but has no last_payload_status (${JSON.stringify(last)})`)
  const flappingSince = typeof ev.props['flapping_since'] === 'string' ? ev.props['flapping_since'] : null
  const session = getSession(undefined, 'WRITE')
  try {
    // Voce `stable` nello stesso statement (history.ts): quiete di flap_stable_minutes senza passaggi.
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      SET e.status = $status, e.flapping_since = null, e.correlation = $correlation, e.correlation_at = $now, e.correlation_due_at = $dueAt, e.updated_at = $now
      ${historyWriteCypher()}
      RETURN e.id AS id
    `, {
      eventId, tenantId, status: last, now, correlation: last === 'firing' ? 'pending' : 'none', dueAt: last === 'firing' ? now : null,
      ...historyParams({ kind: 'stable', note: `nessun passaggio in ${policy.flap_stable_minutes} min` }, now),
    })
    if (!row) throw new Error(`Event ${eventId} vanished while stabilising (tenant ${tenantId})`)
  } finally { await session.close() }

  const payload: EventStablePayload = { ...mapEventPayload({ ...ev.props, status: last }, ev.ciId), stable_minutes: policy.flap_stable_minutes, flapping_since: flappingSince }
  await publishEvent('event.stable', tenantId, MONITORING_ACTOR, payload, now)
  void audit(monitoringContext(tenantId), 'event.stable', 'Event', eventId, { status: last, flappingSince, stableMinutes: policy.flap_stable_minutes })
  const result = await runEventPipeline({ tenantId, eventId, now, mode: 'reevaluate' })
  log.info({ tenantId, eventId, fingerprint: toStr(ev.props['fingerprint']), status: last, flappingSince, outcome: result.outcome }, 'Flapping event stabilised and re-evaluated')
}
