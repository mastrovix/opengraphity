/**
 * Event Management — facciata storica di normalizzazione, deduplica e salute.
 *
 * Il codice vive in `services/events/` per responsabilità (revisione, 3.1:
 * niente più ciclo statico eventService ⇄ eventCorrelation):
 *   - normalize.ts    — payload dei connettori → NormalizedEvent (puro), impronta
 *   - transitions.ts  — tabella di transizione dello stato, CASE Cypher, MERGE dell'ingest
 *   - policy.ts       — Tenant.event_policy (cache 30 s)
 *   - ciHealth.ts     — salute del CI dagli allarmi (una query)
 *   - ingest.ts       — orchestratore dell'ingest (MERGE + pipeline + eventi di dominio)
 *   - shared.ts       — attore monitoring, helper, mapEventPayload
 * Questo file ri-esporta tutto con gli stessi nomi: i chiamanti (resolver,
 * webhook, worker, script) e i loro test non cambiano.
 */
export * from './events/normalize.js'
export * from './events/transitions.js'
export { getEventPolicy, setEventPolicy } from './events/policy.js'
export { CI_HEALTH_RULES, FLAPPING_HEALTH, deriveCIHealth, ciHealthCaseCypher, recomputeCIHealth } from './events/ciHealth.js'
export { mapEventPayload } from './events/shared.js'
export { matchCI, ingestEvent, QUIET_OUTCOMES, type IngestInput, type IngestResult } from './events/ingest.js'
