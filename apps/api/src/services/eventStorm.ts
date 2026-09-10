/**
 * Event Management — facciata storica delle tempeste (ondata 4).
 *
 * Il codice vive in `services/events/storm.ts` (revisione, 3.1); la cache
 * della sorgente in `services/events/sourceCache.ts`. Ri-esportato con gli
 * stessi nomi per i chiamanti (resolver, worker, mutation delle sorgenti).
 */
export * from './events/storm.js'
export { MONITORING_ACTOR } from './events/shared.js'
export { loadSource, invalidateSourceCache, SOURCE_CACHE_TTL_MS } from './events/sourceCache.js'
