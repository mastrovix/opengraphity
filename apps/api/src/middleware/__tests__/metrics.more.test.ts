/**
 * The metrics module end to end: the Express middleware that feeds the HTTP
 * series, the /metrics handler and its guard, the Apollo plugin, the
 * slow-query panel, the process gauges and the BullMQ collector.
 *
 * Why these behaviours matter:
 *  - /metrics exposes internal names and volumes: it must answer 401 when a
 *    token is configured and missing, 403 to a public address otherwise;
 *  - the admin dashboard reads the structured getters: a wrong p95, a
 *    resolver error attributed to the wrong field or a query panel that
 *    shows source comments instead of the query mislead whoever is on call;
 *  - the BullMQ collector must survive a queue that cannot be read (Redis
 *    hiccup) and must not keep the process alive at shutdown.
 *
 * Each test imports a FRESH copy of the module: the metric maps are module
 * state, and counts leaking between tests would make the assertions depend on
 * the order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const warn = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn() }) },
}))
const config = { metricsToken: '' as string }
vi.mock('../../lib/config.js', () => ({ config }))

type M = typeof import('../metrics.js')
let m: M

beforeEach(async () => {
  vi.resetModules()
  warn.mockClear()
  config.metricsToken = ''
  m = await import('../metrics.js')
})
afterEach(() => { vi.useRealTimers() })

/** A minimal Express response: an EventEmitter with the fields the code reads. */
function fakeRes(statusCode = 200) {
  const res = Object.assign(new EventEmitter(), {
    statusCode,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res },
    type(_t: string) { return res },
    send(b: unknown) { res.body = b; return res },
    setHeader(k: string, v: string) { res.headers[k] = v },
  })
  return res
}

describe('metricsMiddleware', () => {
  it('records one request with its bounded route label and status once the response finishes', () => {
    const next = vi.fn()
    const res = fakeRes(404)
    m.metricsMiddlewareWithRpm({ method: 'GET', route: { path: '/incidents/:id' }, baseUrl: '/api' } as never, res as never, next)
    expect(next).toHaveBeenCalled()
    // Nothing is counted before `finish`: the status is not known yet.
    expect(m.getRequestMetrics().totalRequests).toBe(0)
    res.emit('finish')
    expect(m.httpRequestsTotal.snapshot()).toEqual([
      { labels: { method: 'GET', route: '/api/incidents/:id', status_code: '404' }, value: 1 },
    ])
    const r = m.getRequestMetrics()
    expect(r.requestsPerMinute).toBe(1)
    // A 404 is not a server error.
    expect(r.errorRate).toBe(0)
  })

  it('requests per minute is a rolling window: a request older than 60 s no longer counts', () => {
    vi.useFakeTimers()
    const req = { method: 'GET', route: undefined, baseUrl: '' } as never
    m.metricsMiddlewareWithRpm(req, fakeRes() as never, vi.fn())
    vi.advanceTimersByTime(61_000)
    m.metricsMiddlewareWithRpm(req, fakeRes() as never, vi.fn())
    expect(m.getRequestMetrics().requestsPerMinute).toBe(1)
  })

  it('an array route path uses its first pattern; an empty route falls back to "/"', () => {
    expect(m.routeLabel({ route: { path: ['/a', '/b'] }, baseUrl: '' } as never)).toBe('/a')
    expect(m.routeLabel({ route: { path: [] as string[] }, baseUrl: '' } as never)).toBe('/')
  })
})

describe('getRequestMetrics edge cases', () => {
  it('with no traffic every figure is zero instead of NaN', () => {
    expect(m.getRequestMetrics()).toEqual({
      totalRequests: 0, requestsPerMinute: 0, averageResponseMs: 0, p95ResponseMs: 0, errorRate: 0, statusCodes: [],
    })
  })

  it('p95 beyond the last finite bucket reports the last bucket, and a missing status counts as "unknown"', () => {
    m.httpRequestDurationSeconds.observe({ method: 'GET', route: '/x' }, 60)
    m.httpRequestsTotal.inc({ method: 'GET', route: '/x' })
    const r = m.getRequestMetrics()
    expect(r.p95ResponseMs).toBe(10_000)
    expect(r.statusCodes).toEqual([{ code: 'unknown', count: 1 }])
  })
})

describe('metricsHandler (A-15 guard)', () => {
  const req = (remoteAddress: string | undefined, authorization?: string) =>
    ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress } }) as never

  it('answers 403 to a public address when no token is configured', () => {
    const res = fakeRes()
    m.metricsHandler(req('203.0.113.7'), res as never)
    expect(res.statusCode).toBe(403)
    expect(res.body).toBe('metrics: forbidden')
  })

  it('answers 401 when a token is configured and not presented', () => {
    config.metricsToken = 'tok'
    const res = fakeRes()
    m.metricsHandler(req('127.0.0.1'), res as never)
    expect(res.statusCode).toBe(401)
  })

  it('serves the Prometheus exposition with its content type to an allowed caller', () => {
    m.backupRunsTotal.inc({ result: 'ok' })
    const res = fakeRes()
    m.metricsHandler(req('10.0.0.2'), res as never)
    expect(res.headers['Content-Type']).toBe(m.METRICS_CONTENT_TYPE)
    expect(res.body).toContain('opengrafo_backup_runs_total{result="ok"} 1')
  })

  it('an unknown socket address is never treated as private', () => {
    expect(m.isPrivateAddress(undefined)).toBe(false)
    expect(m.metricsAccessAllowed(req(undefined), '')).toBe(false)
    expect(m.metricsAccessAllowed({ headers: {} } as never, '')).toBe(false)
  })
})

describe('graphqlMetricsPlugin', () => {
  it('times every resolved field as <ParentType>.<field>', async () => {
    const listeners = await m.graphqlMetricsPlugin.requestDidStart!({} as never)
    const exec = await listeners!.executionDidStart!({} as never)
    const done = (exec as { willResolveField: (a: unknown) => () => void })
      .willResolveField({ info: { parentType: { name: 'Query' }, fieldName: 'incidents' } })
    done()
    const g = m.getGraphQLMetrics('t1')
    expect(g.totalOperations).toBe(1)
    expect(g.slowestResolvers[0]!.name).toBe('Query.incidents')
  })

  it('errors without an operation or a path are still recorded, not lost; parse errors are ignored', async () => {
    const listeners = await m.graphqlMetricsPlugin.requestDidStart!({} as never)
    await listeners!.didEncounterErrors!({
      contextValue: { tenantId: 't1' },
      operation: undefined,
      errors: [
        { message: 'no path' },
        { message: 'parse', extensions: { code: 'GRAPHQL_PARSE_FAILED' } },
      ],
    } as never)
    expect(m.getGraphQLMetrics('t1').errorsByResolver).toEqual([{ name: 'Unknown.<request>', count: 1, lastError: 'no path' }])
  })

  it('a resolver series without a name label reads as "unknown" on the dashboard', () => {
    m.graphqlResolverDurationSeconds.observe({}, 0.002)
    expect(m.getGraphQLMetrics('t1').slowestResolvers[0]).toMatchObject({ name: 'unknown', count: 1 })
  })
})

describe('slow query panel', () => {
  it('shows the query without source comments, on one line', () => {
    expect(m.queryPerIlPannello('// why this is written so\nMATCH (n) /* inline */\n  RETURN n // trailing')).toBe('MATCH (n) RETURN n')
  })

  it('keeps the last 20 queries of a tenant, each cut to 200 characters, with what asked for it', () => {
    for (let i = 0; i < 22; i++) m.recordSlowQuery('t1', `MATCH (n${String(i)}) RETURN n`, i, 'GetIncidents')
    m.recordSlowQuery('t1', 'x'.repeat(300), 99, null)
    const slow = m.getNeo4jMetrics('t1').slowQueries
    expect(slow).toHaveLength(20)
    // The oldest entries were evicted, the newest kept.
    expect(slow[0]!.query).toBe('MATCH (n3) RETURN n')
    expect(slow[0]!.operation).toBe('GetIncidents')
    expect(slow.at(-1)!.query).toHaveLength(200)
  })

  it('a tenant sees only its own slow queries; platform work (no tenant) is shown to nobody (wave 7 · A2)', () => {
    m.recordSlowQuery('t1', 'MATCH (a:CustomTypeOfT1) RETURN a', 900, 'GetA')
    m.recordSlowQuery(null, 'MATCH (b:Tenant) RETURN b', 900, 'job maintenance/backup_database')
    expect(m.getNeo4jMetrics('t2').slowQueries).toEqual([])
    expect(m.getNeo4jMetrics('t1').slowQueries.map((q) => q.query)).toEqual(['MATCH (a:CustomTypeOfT1) RETURN a'])
  })

  it('with no query observed the average is zero, not NaN', () => {
    expect(m.getNeo4jMetrics('t1')).toMatchObject({ totalQueries: 0, averageQueryMs: 0 })
  })
})

/*
 * THE TRACKER OF EVERY PROCESS (wave 7 · A2): what a Neo4j query leaves
 * behind. The metrics per tenant and mode, the panel of its tenant, and a
 * line in the log when it was slow or stopped at a limit — with the tenant
 * and the operation, which the old tracker did not know.
 */
describe('trackNeo4jQuery', () => {
  const info = (over: Partial<Parameters<M['trackNeo4jQuery']>[2]> = {}) =>
    ({ mode: 'READ' as const, tenantId: 't1', operation: 'GetIncidents', errorCode: null, ...over })
  const series = () => m.neo4jQueryDurationSeconds.snapshot().map((s) => ({ labels: s.labels, count: s.count }))
  const hits = () => m.neo4jQueryLimitHitsTotal.snapshot()

  it('a fast query: counted for its tenant and mode, nothing else', () => {
    m.trackNeo4jQuery(12, 'MATCH (n) RETURN n', info())
    m.trackNeo4jQuery(3, 'CREATE (n)', info({ mode: 'WRITE', tenantId: null }))
    expect(series()).toEqual([
      { labels: { mode: 'READ', tenant: 't1' }, count: 1 },
      { labels: { mode: 'WRITE', tenant: '' }, count: 1 },
    ])
    expect(m.getNeo4jMetrics('t1').slowQueries).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expect(hits()).toEqual([])
  })

  it('past 500 ms it goes in its tenant\'s panel; past 5 s also in the log, with whom it ran for', () => {
    m.trackNeo4jQuery(501, 'MATCH (i:Incident) RETURN i', info())
    expect(m.getNeo4jMetrics('t1').slowQueries).toEqual([expect.objectContaining({ query: 'MATCH (i:Incident) RETURN i', durationMs: 501, operation: 'GetIncidents' })])
    expect(warn).not.toHaveBeenCalled()
    m.trackNeo4jQuery(m.SLOW_QUERY_LOG_MS + 1, '// why\nMATCH (s:SLAStatus) RETURN s', info())
    expect(warn).toHaveBeenCalledWith({
      tenantId: 't1', operation: 'GetIncidents', mode: 'READ', durationMs: 5001, query: 'MATCH (s:SLAStatus) RETURN s',
    }, 'Slow Neo4j query')
  })

  it('a query the database stopped at its time limit: counted, and logged even when it was quick to fail', () => {
    m.trackNeo4jQuery(30_004, 'MATCH (n) RETURN n', info({ errorCode: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration' }))
    m.trackNeo4jQuery(40, 'MATCH (n) RETURN collect(n)', info({ errorCode: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' }))
    expect(hits()).toEqual([
      { labels: { limit: 'time', tenant: 't1' }, value: 1 },
      { labels: { limit: 'memory', tenant: 't1' }, value: 1 },
    ])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 'memory', errorCode: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError', durationMs: 40 }),
      'Neo4j query stopped at the database limit')
  })

  it('any other error is not a limit', () => {
    m.trackNeo4jQuery(20, 'MATCH (n) RETURN n', info({ errorCode: 'Neo.ClientError.Statement.SyntaxError' }))
    expect(hits()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('getProcessMetrics', () => {
  it('reports memory, uptime and a finite CPU percentage', () => {
    const p = m.getProcessMetrics()
    expect(p.pid).toBe(process.pid)
    expect(p.nodeVersion).toBe(process.version)
    expect(p.memoryRssMb).toBeGreaterThan(0)
    expect(Number.isFinite(p.cpuUsagePercent)).toBe(true)
  })

  it('CPU is measured over the time elapsed since the previous read', () => {
    vi.useFakeTimers()
    m.getProcessMetrics()
    vi.advanceTimersByTime(500)
    const p = m.getProcessMetrics()
    expect(p.cpuUsagePercent).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(p.cpuUsagePercent)).toBe(true)
  })

  it('two reads in the same millisecond report 0% CPU instead of dividing by zero', () => {
    vi.useFakeTimers()
    m.getProcessMetrics()
    expect(m.getProcessMetrics().cpuUsagePercent).toBe(0)
  })
})

describe('getQueueMetricsSnapshot', () => {
  it('skips samples without a queue or status label and fills every status', () => {
    m.bullmqQueueDepth.set({ queue: 'q', tenant: 't1' }, 9)
    m.bullmqQueueDepth.set({ tenant: 't1', status: 'waiting' }, 9)
    for (const [status, v] of [['active', 1], ['completed', 2], ['delayed', 3], ['waiting', 4], ['failed', 5]] as const) {
      m.bullmqQueueDepth.set({ queue: 'q', tenant: 't1', status }, v)
    }
    expect(m.getQueueMetricsSnapshot('t1')).toEqual([{ name: 'q', active: 1, completed: 2, delayed: 3, waiting: 4, failed: 5 }])
  })

  // Since 23 Sep 2026 every tenant has its own queues (`<base>@<tenant>`): a tenant sees its own, by base name.
  it('a tenant reads its own queues only: not another tenant\'s, not the platform\'s', () => {
    m.bullmqQueueDepth.replace([
      { labels: { queue: 'sla-jobs', tenant: 't1', status: 'waiting' }, value: 2 },
      { labels: { queue: 'sla-jobs', tenant: 't2', status: 'waiting' }, value: 50 },
      { labels: { queue: 'maintenance', status: 'waiting' }, value: 1 },
    ])
    expect(m.getQueueMetricsSnapshot('t1')).toEqual([{ name: 'sla-jobs', waiting: 2, active: 0, completed: 0, failed: 0, delayed: 0 }])
    expect(m.getQueueMetricsSnapshot('t3')).toEqual([])
  })
})

describe('startBullMQMetricsCollector', () => {
  const queue = (name: string, counts: Record<string, number> | Error) => ({
    name,
    getJobCounts: vi.fn(async () => { if (counts instanceof Error) throw counts; return counts }),
  })

  it('samples every queue at start and on each interval, and survives a queue that cannot be read', async () => {
    vi.useFakeTimers()
    const good = queue('good@t1', { active: 2 })
    const bad = queue('bad@t1', new Error('redis gone'))
    const timer = m.startBullMQMetricsCollector([good, bad] as never, 1000)
    await vi.advanceTimersByTimeAsync(0)
    // Missing statuses read as 0, not as absent series.
    expect(m.getQueueMetricsSnapshot('t1')).toEqual([{ name: 'good', active: 2, waiting: 0, delayed: 0, failed: 0, completed: 0 }])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ queue: 'bad@t1' }), 'Failed to collect BullMQ metrics')

    await vi.advanceTimersByTimeAsync(1000)
    expect(good.getJobCounts).toHaveBeenCalledTimes(2)
    // unref'd: the collector never keeps the process alive at shutdown.
    expect(timer.hasRef()).toBe(false)
    clearInterval(timer)
  })

  it('a getter is re-read on each pass, so queues opened later are sampled too', async () => {
    vi.useFakeTimers()
    const list: ReturnType<typeof queue>[] = []
    const timer = m.startBullMQMetricsCollector(() => list as never, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.getQueueMetricsSnapshot('t1')).toEqual([])
    list.push(queue('late@t1', { waiting: 7 }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.getQueueMetricsSnapshot('t1')).toContainEqual(expect.objectContaining({ name: 'late', waiting: 7 }))
    clearInterval(timer)
  })

  it('a tenant queue is labelled by its base and its tenant, a platform queue by its name', async () => {
    vi.useFakeTimers()
    const timer = m.startBullMQMetricsCollector([queue('sla-jobs@acme', { failed: 1 }), queue('maintenance', { waiting: 3 })] as never, 1000)
    await vi.advanceTimersByTimeAsync(0)
    const failed = m.bullmqQueueDepth.snapshot().filter((s) => s.labels['status'] === 'failed')
    expect(failed.map((s) => s.labels)).toEqual([
      { queue: 'sla-jobs', tenant: 'acme', status: 'failed' },
      { queue: 'maintenance', status: 'failed' },
    ])
    clearInterval(timer)
  })

  it('each pass replaces the series: a queue that is gone (a deleted tenant) or unreadable has none, not its last value', async () => {
    vi.useFakeTimers()
    const list = [queue('sla-jobs@gone', { waiting: 5 }), queue('sla-jobs@acme', { waiting: 1 })]
    const timer = m.startBullMQMetricsCollector(() => list as never, 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(m.getQueueMetricsSnapshot('gone')).toHaveLength(1)
    list.shift()
    list[0]!.getJobCounts.mockRejectedValueOnce(new Error('redis gone'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.getQueueMetricsSnapshot('gone')).toEqual([])
    expect(m.getQueueMetricsSnapshot('acme')).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.getQueueMetricsSnapshot('acme')).toEqual([expect.objectContaining({ name: 'sla-jobs', waiting: 1 })])
    clearInterval(timer)
  })
})
