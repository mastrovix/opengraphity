/**
 * Il caso visto nel browser: aperto l'OLA / UC Report, l'SLA Report cadeva con
 * «Cannot read properties of undefined (reading 'reduce')». Le due pagine
 * leggono lo stesso `slaReport(windowDays)` con campi diversi, e la cache
 * sostituiva l'oggetto invece di unirlo.
 */
import { describe, it, expect } from 'vitest'
import { InMemoryCache } from '@apollo/client'
import { GET_SLA_REPORT, GET_OLA_REPORT } from '@/graphql/queries'
import { APOLLO_TYPE_POLICIES } from './apolloTypePolicies'

const sla = {
  __typename: 'SLAComplianceBlock', total: 1, met: 1, breached: 0, paused: 0, openOnTrack: 0,
  breachRate: 0, avgResolutionMinutes: null, byPriority: [], byPolicy: [],
}
const ola = [{
  __typename: 'OLAAttainmentRow', id: 'o1', type: 'ola', name: 'Rete', entityType: 'incident',
  partyType: 'team', partyName: null, resolveMinutes: 240, evaluated: 2, met: 1, breached: 1, attainmentPct: 50,
}]
const base = { __typename: 'SLAReport', generatedAt: 'ora', windowDays: 30 }

function scrivi(cache: InMemoryCache) {
  cache.writeQuery({ query: GET_SLA_REPORT, variables: { windowDays: 30 }, data: { slaReport: { ...base, sla } } })
  cache.writeQuery({ query: GET_OLA_REPORT, variables: { windowDays: 30 }, data: { slaReport: { ...base, ola } } })
}

describe('cache: le due pagine di report non si cancellano i dati a vicenda', () => {
  it('con la regola, dopo entrambe le risposte ci sono sia `sla` sia `ola`', () => {
    const cache = new InMemoryCache({ typePolicies: APOLLO_TYPE_POLICIES })
    scrivi(cache)
    const a = cache.readQuery<{ slaReport: { sla: unknown } }>({ query: GET_SLA_REPORT, variables: { windowDays: 30 } })
    const b = cache.readQuery<{ slaReport: { ola: unknown[] } }>({ query: GET_OLA_REPORT, variables: { windowDays: 30 } })
    expect(a?.slaReport.sla).toMatchObject({ total: 1 })
    expect(b?.slaReport.ola).toHaveLength(1)
  })

  it('SENZA la regola la prima pagina perde i suoi dati (il difetto che la regola toglie)', () => {
    const cache = new InMemoryCache()
    scrivi(cache)
    const a = cache.readQuery({ query: GET_SLA_REPORT, variables: { windowDays: 30 }, returnPartialData: false })
    expect(a).toBeNull()
  })
})
