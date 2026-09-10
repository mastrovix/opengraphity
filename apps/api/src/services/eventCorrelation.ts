/**
 * Event Management — facciata storica della correlazione (ondata 3 + 4).
 *
 * Il codice vive in `services/events/` per responsabilità (revisione, 3.1):
 *   - pipeline.ts        — `runEventPipeline`: solo l'ordine dei passi
 *   - suppression.ts     — finestra di change (passo 1)
 *   - flapping.ts        — sfarfallio (passo 0)
 *   - grouping.ts        — soglia, orfano, ritardo, raggruppamento, tempesta (3–6)
 *   - autoResolve.ts     — chiusura automatica (7)
 *   - passes.ts          — fine finestra e passate periodiche (sopra la pipeline)
 *   - gauges.ts          — gauge di salute per il job periodico
 *   - incidentWorkflow.ts, repo.ts, deps.ts, shared.ts, types.ts
 * Questo file ri-esporta tutto con gli stessi nomi: i chiamanti (resolver,
 * worker, mutation della change) e i loro test non cambiano.
 */
export { MONITORING_ACTOR, monitoringContext } from './events/shared.js'
export type { EventRecord, PipelineMode, PipelineInput, PipelineResult, PipelineOutcome } from './events/types.js'
export { CORRELATION_OUTCOMES, type CorrelationOutcome } from '../lib/eventVocabularies.js'
export { runEventPipeline } from './events/pipeline.js'
export {
  CHANGE_IMPLEMENTATION_STEP, CHANGE_PLANNED_STEPS, CHANGE_WINDOW_STEPS,
  changeIsInWindow, findSuppressingChange,
  type EventSuppressedPayload, type SuppressingChange,
} from './events/suppression.js'
export { isFlapping, isStable, type EventFlappingPayload, type EventStablePayload } from './events/flapping.js'
export {
  GROUP_LOCK_TTL_SECONDS, GROUP_LOCK_WAIT_MS, GROUP_LOCK_POLL_MS, GROUP_LOCK_OPTS,
  groupLockKey, groupIdOf, INCIDENT_SEVERITY_FROM_EVENT, meetsOpenThreshold, openIncidentFromEvent,
  type EventCorrelatedPayload, type OpenIncidentArgs,
} from './events/grouping.js'
export {
  AUTO_RESOLVE_MAX_HOPS, AUTO_RESOLVE_TRIGGERS, AUTO_RESOLVE_SATISFIABLE_CONDITIONS,
  findAutoResolvePath, type AutoResolveHop,
} from './events/autoResolve.js'
export type { DefinitionTransition } from './events/incidentWorkflow.js'
export {
  PENDING_CORRELATIONS,
  reevaluateSuppressedEvents, reevaluateClosedWindows, reevaluatePendingEvents, reevaluateFlappingEvents,
} from './events/passes.js'
export { refreshEventGauges, OVERDUE_DELAYED_GRACE_MINUTES, UNCORRELATED_AFTER_MINUTES, type EventGauges } from './events/gauges.js'
