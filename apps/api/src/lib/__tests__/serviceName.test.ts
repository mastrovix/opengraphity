/**
 * Il nome del processo nei log (ondata 5, chiuso nell'ondata 8).
 *
 * `logger.ts` scriveva `service: "opengrafo-api"` in `base`, e i worker usano
 * la stessa immagine e lo stesso logger: in Loki i tre processi erano
 * indistinguibili, e cercare «cosa ha fatto l'ingest degli allarmi» voleva dire
 * leggere i log di tutti e tre e indovinare dal contenuto.
 */
import { describe, it, expect } from 'vitest'
import { serviceNameFor, API_SERVICE_NAME, WORKER_SERVICE_NAME, EVENTS_WORKER_SERVICE_NAME } from '../serviceName.js'

describe('serviceNameFor — entrypoint + WORKER_PROFILE', () => {
  it.each([
    ['/app/dist/index.js',  'api',    API_SERVICE_NAME],
    ['/app/dist/index.js',  'all',    API_SERVICE_NAME],           // API monoprocesso (sviluppo)
    ['/app/dist/worker.js', 'all',    WORKER_SERVICE_NAME],        // compose: worker
    ['/app/dist/worker.js', 'events', EVENTS_WORKER_SERVICE_NAME], // compose: events-worker
    ['/repo/apps/api/src/index.ts', 'api', API_SERVICE_NAME],      // tsx in sviluppo
    ['/repo/apps/api/src/worker.ts', 'events', EVENTS_WORKER_SERVICE_NAME],
  ])('%s + WORKER_PROFILE=%s → %s', (entrypoint, profile, expected) => {
    expect(serviceNameFor(entrypoint, profile)).toBe(expected)
  })

  // Niente ripiego muto: uno script operativo si nomina per quello che è,
  // invece di spacciarsi per l'API.
  it('un altro entrypoint porta il proprio nome, non quello dell\'API', () => {
    expect(serviceNameFor('/app/dist/scripts/migrate.js', 'api')).toBe('opengrafo-migrate')
    expect(serviceNameFor('/app/dist/scripts/onboard-tenant.js', 'api')).toBe('opengrafo-onboard-tenant')
  })

  it('senza entrypoint (uso incorporato) resta il nome dell\'API', () => {
    expect(serviceNameFor(undefined, 'api')).toBe(API_SERVICE_NAME)
    expect(serviceNameFor('', 'all')).toBe(API_SERVICE_NAME)
  })

  it('i tre nomi sono distinti (è tutto il punto)', () => {
    expect(new Set([API_SERVICE_NAME, WORKER_SERVICE_NAME, EVENTS_WORKER_SERVICE_NAME]).size).toBe(3)
  })
})
