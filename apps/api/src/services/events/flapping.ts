/**
 * Passo 0 della pipeline (ondata 4): sfarfallio.
 *
 * Un evento `flapping` non viene correlato (la salute del CI vale degraded,
 * vedi ciHealth.ts). All'ingest, se negli ultimi `flap_window_minutes` ci
 * sono ≥ `flap_threshold` passaggi firing↔resolved (Event.transitions),
 * l'evento ENTRA in `flapping`: `correlation = 'flapping'`, `event.flapping`
 * (una volta per episodio), UN commento sull'incident già correlato. Lo
 * stabilizza la passata periodica (passes.ts: `reevaluateFlappingEvents`),
 * che dopo `flap_stable_minutes` senza passaggi lo riporta allo stato
 * dell'ultimo payload e lo ripassa dalla pipeline.
 */
import { runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { MonitoringEventPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import type { EventPolicy } from '../../lib/eventPolicy.js'
import { eventsFlappingTotal } from '../../middleware/metrics.js'
import { incidents } from './deps.js'
import { MONITORING_ACTOR, mapEventPayload, monitoringContext, toStr } from './shared.js'
import { countTransitionsSince, transitionsOf } from './transitions.js'
import { historyParams, historyWriteCypher } from './history.js'
import { recomputeCIHealth } from './ciHealth.js'
import { findLinkedOpenIncident, incidentStepInfo } from './incidentWorkflow.js'
import type { EventRecord, PipelineResult } from './types.js'

const log = logger.child({ module: 'event-correlation' })

/** `event.flapping`: passaggi contati nella finestra e finestra in minuti. */
export interface EventFlappingPayload extends MonitoringEventPayload { transitions: number; window_minutes: number; flapping_since: string; incident_id: string | null }
/** `event.stable`: stato a cui l'evento è tornato e minuti di quiete richiesti. */
export interface EventStablePayload extends MonitoringEventPayload { stable_minutes: number; flapping_since: string | null }

/** True se nei `flap_window_minutes` prima di `now` ci sono ≥ `flap_threshold` passaggi (soglia o finestra 0 = rilevamento spento). */
export function isFlapping(transitions: readonly string[], policy: Pick<EventPolicy, 'flap_threshold' | 'flap_window_minutes'>, now: string): boolean {
  if (policy.flap_threshold <= 0 || policy.flap_window_minutes <= 0) return false
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`isFlapping: "${now}" is not an ISO date`)
  return countTransitionsSince(transitions, nowMs - policy.flap_window_minutes * 60_000) >= policy.flap_threshold
}

/** True se l'ultimo passaggio è più vecchio di `flap_stable_minutes` (nessun passaggio registrato → stabile). */
export function isStable(transitions: readonly string[], stableMinutes: number, now: string): boolean {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`isStable: "${now}" is not an ISO date`)
  let last = -Infinity
  for (const t of transitions) { const ms = Date.parse(t); if (ms > last) last = ms }
  return last === -Infinity || nowMs - last >= stableMinutes * 60_000
}

/**
 * L'evento entra in sfarfallio: status `flapping`, `flapping_since`,
 * `correlation = 'flapping'`; la salute del CI viene ricalcolata (vale
 * degraded); un commento sull'incident già correlato, `event.flapping`. Nessun
 * incident viene aperto né chiuso finché sfarfalla.
 */
export async function enterFlapping(session: Session, tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string, logCtx: Record<string, unknown> = {}): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const transitions = countTransitionsSince(transitionsOf(ev.props), Date.parse(now) - policy.flap_window_minutes * 60_000)
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
    SET e.status = 'flapping', e.flapping_since = $now, e.suppressed_by_change_id = null,
        e.correlation = 'flapping', e.correlation_at = $now, e.correlation_due_at = null, e.updated_at = $now
    ${historyWriteCypher()}
    RETURN e.id AS id
  `, { eventId, tenantId, now, ...historyParams({ kind: 'flapping', note: `${transitions} passaggi in ${policy.flap_window_minutes} min` }, now) })
  if (!row) throw new Error(`Event ${eventId} vanished while entering flapping (tenant ${tenantId})`)
  const incidentId = await findLinkedOpenIncident(session, tenantId, eventId, await incidentStepInfo(session, tenantId))

  if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
  if (incidentId) {
    await (await incidents()).addIncidentComment(incidentId, { tenantId, userId: MONITORING_ACTOR },
      `Allarme instabile: ${transitions} passaggi in ${policy.flap_window_minutes} minuti, correlazione sospesa`)
  }
  eventsFlappingTotal.inc({})
  const payload: EventFlappingPayload = { ...mapEventPayload({ ...ev.props, status: 'flapping' }, ev.ciId), transitions, window_minutes: policy.flap_window_minutes, flapping_since: now, incident_id: incidentId }
  await publishEvent('event.flapping', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), 'event.flapping', 'Event', eventId, { transitions, windowMinutes: policy.flap_window_minutes, ciId: ev.ciId, incidentId })
  log.info({ ...logCtx, tenantId, eventId, transitions, windowMinutes: policy.flap_window_minutes, ciId: ev.ciId, incidentId }, 'Event is flapping: correlation suspended')
  return { outcome: 'flapping', status: 'flapping', suppressedByChangeId: null, incidentId }
}
