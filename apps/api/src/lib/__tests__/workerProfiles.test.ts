/**
 * lib/workerProfiles.ts (revisione 2 · D1.1): la tabella «profilo → cosa
 * parte» è una sola, letta da index.ts e worker.ts, e qui viene pinnata:
 * cambiarla è una decisione di deploy, non un effetto collaterale.
 */
import { describe, it, expect } from 'vitest'
import { PROFILE_TABLE, WORKER_PROFILES, PROCESS_KINDS, EVENT_WORK_UNITS, allowedProfiles, workGroupsFor, runsWorkGroup } from '../workerProfiles.js'
import { CONSUMER_QUEUES } from '@opengraphity/events'

describe('PROFILE_TABLE', () => {
  it('pinna la tabella: all = API fa tutto (come prima) e il worker fa l\'embedding; api = API senza events; events = worker con events', () => {
    expect(WORKER_PROFILES).toEqual(['all', 'api', 'events'])
    expect(PROCESS_KINDS).toEqual(['api', 'worker'])
    expect(PROFILE_TABLE).toEqual({
      all:    { api: ['events'], worker: ['embedding'] },
      api:    { api: [],         worker: null },
      events: { api: null,       worker: ['events'] },
    })
  })

  it('il default `all` non cambia il comportamento dell\'API: avvia il gruppo events nel processo API', () => {
    expect(runsWorkGroup('api', 'all', 'events')).toBe(true)
    expect(runsWorkGroup('worker', 'all', 'events')).toBe(false)
    expect(runsWorkGroup('worker', 'all', 'embedding')).toBe(true)
  })

  it('con `api` l\'API non avvia il gruppo events; con `events` lo avvia il worker (e non l\'embedding: quello resta al servizio worker)', () => {
    expect(workGroupsFor('api', 'api')).toEqual([])
    expect(workGroupsFor('worker', 'events')).toEqual(['events'])
    expect(runsWorkGroup('worker', 'events', 'embedding')).toBe(false)
  })

  it('profilo non ammesso per il processo → errore con l\'elenco dei validi (fail-fast, nessun default)', () => {
    expect(() => workGroupsFor('worker', 'api')).toThrow('WORKER_PROFILE=api is not valid for the worker process (allowed: all, events)')
    expect(() => workGroupsFor('api', 'events')).toThrow('WORKER_PROFILE=events is not valid for the api process (allowed: all, api)')
    expect(allowedProfiles('api')).toEqual(['all', 'api'])
    expect(allowedProfiles('worker')).toEqual(['all', 'events'])
  })

  it('il gruppo events copre le quattro code di lavoro e il consumer dei servizi, che è una coda di fan-out di packages/events', () => {
    expect(EVENT_WORK_UNITS).toEqual(['events-ingest', 'events-correlate', 'events-maintenance', 'services-impact', 'service-impact-consumer'])
    expect(CONSUMER_QUEUES).toContain('service-impact-consumer')
  })
})
