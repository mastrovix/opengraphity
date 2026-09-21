/**
 * A-14 / A-15: structured getters read the internal maps (no regex on the
 * Prometheus text), `max` is tracked, the HTTP route label is bounded and
 * /metrics is guarded.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}))

const m = await import('../metrics.js')

describe('getGraphQLMetrics', () => {
  it('legge sum/count/max dalle Map interne e ordina per media', () => {
    m.graphqlResolverDurationSeconds.observe({ resolver: 'Query.incidents' }, 0.010)
    m.graphqlResolverDurationSeconds.observe({ resolver: 'Query.incidents' }, 0.030)
    m.graphqlResolverDurationSeconds.observe({ resolver: 'Mutation.createIncident' }, 0.200)
    m.graphqlResolverDurationSeconds.observe({ resolver: 'Mutation.createIncident' }, 0.100)

    const g = m.getGraphQLMetrics()
    expect(g.totalOperations).toBe(4)
    expect(g.slowestResolvers[0]).toMatchObject({ name: 'Mutation.createIncident', count: 2 })
    expect(g.slowestResolvers[0]!.averageMs).toBeCloseTo(150)
    expect(g.slowestResolvers[0]!.maxMs).toBeCloseTo(200)
    expect(g.slowestResolvers[1]).toMatchObject({ name: 'Query.incidents', count: 2 })
    expect(g.slowestResolvers[1]!.averageMs).toBeCloseTo(20)
    expect(g.slowestResolvers[1]!.maxMs).toBeCloseTo(30)
  })

  it('espone errorsByResolver da recordResolverError', () => {
    m.recordResolverError('Mutation.createChange', 'first')
    m.recordResolverError('Mutation.createChange', 'second')
    const g = m.getGraphQLMetrics()
    expect(g.errorsByResolver).toContainEqual({ name: 'Mutation.createChange', count: 2, lastError: 'second' })
  })

  it('il plugin attribuisce gli errori al root field e ignora UNAUTHORIZED/validation', async () => {
    const listeners = await m.graphqlMetricsPlugin.requestDidStart!({} as never)
    await listeners!.didEncounterErrors!({
      operation: { operation: 'mutation' },
      errors: [
        { message: 'boom', path: ['executeChangeTransition', 'x'], extensions: { code: 'BAD_USER_INPUT' } },
        { message: 'nope', path: ['whatever'], extensions: { code: 'UNAUTHORIZED' } },
        { message: 'bad', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
      ],
    } as never)
    const g = m.getGraphQLMetrics()
    expect(g.errorsByResolver).toContainEqual({ name: 'Mutation.executeChangeTransition', count: 1, lastError: 'boom' })
    expect(g.errorsByResolver.map(e => e.name)).not.toContain('Mutation.whatever')
  })
})

describe('getRequestMetrics / getNeo4jMetrics / getQueueMetricsSnapshot', () => {
  it('aggregano dagli snapshot strutturati', () => {
    m.httpRequestsTotal.inc({ method: 'GET', route: '/health', status_code: '200' }, 3)
    m.httpRequestsTotal.inc({ method: 'POST', route: '/graphql', status_code: '500' })
    m.httpRequestDurationSeconds.observe({ method: 'GET', route: '/health' }, 0.02)
    m.httpRequestDurationSeconds.observe({ method: 'GET', route: '/health' }, 0.04)
    const r = m.getRequestMetrics()
    expect(r.totalRequests).toBe(4)
    expect(r.errorRate).toBeCloseTo(0.25)
    expect(r.statusCodes).toEqual(expect.arrayContaining([{ code: '200', count: 3 }, { code: '500', count: 1 }]))
    expect(r.averageResponseMs).toBeCloseTo(30)
    expect(r.p95ResponseMs).toBe(50)  // first bucket (0.05) reaching 95% of 2 observations

    m.neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, 0.5)
    expect(m.getNeo4jMetrics()).toMatchObject({ totalQueries: 1, averageQueryMs: 500 })

    m.bullmqQueueDepth.set({ queue: 'embeddings', status: 'waiting' }, 4)
    m.bullmqQueueDepth.set({ queue: 'embeddings', status: 'failed' }, 1)
    expect(m.getQueueMetricsSnapshot()).toContainEqual({ name: 'embeddings', waiting: 4, active: 0, completed: 0, failed: 1, delayed: 0 })
  })
})

describe('routeLabel (A-15)', () => {
  it('usa il pattern della route matchata (mount + path), non il path grezzo', () => {
    expect(m.routeLabel({ route: { path: '/incidents/:id' }, baseUrl: '/api/v1' } as never)).toBe('/api/v1/incidents/:id')
    expect(m.routeLabel({ route: { path: '/health' }, baseUrl: '' } as never)).toBe('/health')
  })
  it('collassa i path non matchati in "unmatched" (cardinalità limitata)', () => {
    expect(m.routeLabel({ route: undefined, baseUrl: '' } as never)).toBe('unmatched')
    expect(m.routeLabel({ route: undefined, baseUrl: '/graphql' } as never)).toBe('/graphql')
  })
})

describe('metricsAccessAllowed (A-15)', () => {
  const req = (remoteAddress: string, authorization?: string) =>
    ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress } }) as never

  it('senza METRICS_TOKEN: solo loopback / reti private', () => {
    expect(m.metricsAccessAllowed(req('127.0.0.1'), undefined)).toBe(true)
    expect(m.metricsAccessAllowed(req('::1'), undefined)).toBe(true)
    expect(m.metricsAccessAllowed(req('::ffff:172.18.0.5'), undefined)).toBe(true)
    expect(m.metricsAccessAllowed(req('10.1.2.3'), undefined)).toBe(true)
    expect(m.metricsAccessAllowed(req('203.0.113.7'), undefined)).toBe(false)
    expect(m.metricsAccessAllowed(req('172.32.0.1'), undefined)).toBe(false)
  })

  it('con METRICS_TOKEN: bearer obbligatorio, anche da loopback', () => {
    expect(m.metricsAccessAllowed(req('127.0.0.1'), 's3cret')).toBe(false)
    expect(m.metricsAccessAllowed(req('203.0.113.7', 'Bearer s3cret'), 's3cret')).toBe(true)
    expect(m.metricsAccessAllowed(req('203.0.113.7', 'Bearer wrong'), 's3cret')).toBe(false)
  })
})

// ── Operatività, revisione 2 ondata 4 (D2.2 / D7.2) ─────────────────────────

describe('metriche di operatività (revisione 2)', () => {
  it('event_ingest_lag_seconds, events_failed_total{queue,type}, redis_lock_timeouts_total{lock}, redis_lock_hold_seconds{lock} esistono, sono esposte da renderMetrics e hanno il tipo dichiarato', () => {
    m.eventIngestLagSeconds.observe({}, 3)
    m.eventsFailedTotal.inc({ queue: 'sla-engine', type: 'incident.created' })
    m.redisLockTimeoutsTotal.inc({ lock: 'events:group' })
    m.redisLockHoldSeconds.observe({ lock: 'events:group' }, 0.2)
    const exposed = m.renderMetrics()
    for (const [name, type] of [
      ['event_ingest_lag_seconds', 'histogram'],
      ['events_failed_total', 'counter'],
      ['redis_lock_timeouts_total', 'counter'],
      ['redis_lock_hold_seconds', 'histogram'],
    ] as const) {
      expect(exposed).toContain(`# TYPE ${name} ${type}`)
    }
    expect(exposed).toContain('events_failed_total{queue="sla-engine",type="incident.created"} 1')
    expect(exposed).toContain('redis_lock_timeouts_total{lock="events:group"} 1')
    expect(exposed).toContain('event_ingest_lag_seconds_bucket{le="5"} 1')
    // stessi bucket dei ritardi di correlazione e di valutazione (code a confronto)
    expect(m.eventIngestLagSeconds.buckets).toEqual(m.eventCorrelateJobLagSeconds.buckets)
    // renderMetrics è la stessa esposizione dell'API (bullmq_queue_depth compreso): il worker la serve così
    expect(exposed).toContain('# TYPE bullmq_queue_depth gauge')
    expect(m.METRICS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8')
  })
})

// ── Servizi monitorati, ondata 4 ─────────────────────────────────────────────

describe('metriche dei servizi monitorati (ondata 4)', () => {
  it('le quattro metriche nuove esistono, sono esposte dal registro custom e hanno il tipo dichiarato', () => {
    const exposed = m.EVENT_MANAGEMENT_METRICS.map((x) => x.collect()).join('\n')
    for (const [name, type] of [
      ['service_incidents_opened_total', 'counter'],
      ['service_incidents_resolved_total', 'counter'],
      ['service_evaluation_lag_seconds', 'histogram'],
      ['service_maps_stale', 'gauge'],
    ] as const) {
      expect(exposed).toContain(`# TYPE ${name} ${type}`)
    }
    // accanto a quelle delle ondate 1-3
    expect(exposed).toContain('# TYPE service_evaluations_total counter')
    expect(exposed).toContain('# TYPE services_health gauge')
  })

  it('nessuna etichetta dichiarata: contatori e gauge escono senza label, l\'istogramma con i soli bucket', () => {
    m.serviceIncidentsOpenedTotal.inc({})
    m.serviceIncidentsOpenedTotal.inc({})
    m.serviceIncidentsResolvedTotal.inc({})
    m.serviceMapsStale.set({}, 3)
    m.serviceEvaluationLagSeconds.observe({}, 7)

    expect(m.serviceIncidentsOpenedTotal.snapshot()).toEqual([{ labels: {}, value: 2 }])
    expect(m.serviceIncidentsResolvedTotal.snapshot()).toEqual([{ labels: {}, value: 1 }])
    expect(m.serviceMapsStale.snapshot()).toEqual([{ labels: {}, value: 3 }])
    expect(m.serviceIncidentsOpenedTotal.collect()).toContain('\nservice_incidents_opened_total 2 ')
    expect(m.serviceMapsStale.collect()).toContain('\nservice_maps_stale 3 ')

    const lag = m.serviceEvaluationLagSeconds.snapshot()[0]!
    expect(lag).toMatchObject({ labels: {}, count: 1, sum: 7, max: 7 })
    // stessi bucket di event_correlate_job_lag_seconds (code a confronto)
    expect(m.serviceEvaluationLagSeconds.buckets).toEqual(m.eventCorrelateJobLagSeconds.buckets)
    expect(m.serviceEvaluationLagSeconds.collect()).toContain('service_evaluation_lag_seconds_bucket{le="10"} 1')
  })
})
