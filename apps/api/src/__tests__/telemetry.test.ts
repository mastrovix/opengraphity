/**
 * telemetry.ts — the tracing bootstrap and the "recent traces" buffer that
 * feeds the Monitoring page.
 *
 * Why these behaviours matter:
 *  - with OTEL off (the default) every helper must be inert: the Apollo plugin
 *    calls startGraphQLSpan / updateActiveSpanName on EVERY request, so a helper
 *    that assumed a tracer would break every GraphQL call;
 *  - the recent-traces panel is only useful if the noise (health probes,
 *    metrics scrapes, the dashboard polling itself every 15s, the duplicate
 *    POST /graphql HTTP span) is filtered out and the buffer stays bounded;
 *  - initTelemetry is called twice (preload + index.ts): a second SDK would
 *    double every span;
 *  - an SDK that fails to start must leave the API running, with
 *    otelEnabled back to false so the dashboard does not claim tracing is on.
 *
 * The OpenTelemetry packages are mocked: no exporter, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cfg = vi.hoisted(() => ({ otelEnabled: false, otelEndpoint: 'http://collector:4318/v1/traces' }))
const log = vi.hoisted(() => ({
  warn: vi.fn(), info: vi.fn(),
  childInfo: vi.fn(),
}))
const otel = vi.hoisted(() => ({
  sdkOptions: null as null | { spanProcessors: unknown[]; instrumentations: unknown[]; resource: unknown },
  start: vi.fn(),
  shutdown: vi.fn(),
  failConstructor: false,
  autoInstrOptions: null as unknown,
  exporterOptions: null as unknown,
  tracerSpan: null as null | Record<string, ReturnType<typeof vi.fn>>,
  activeSpan: undefined as undefined | Record<string, ReturnType<typeof vi.fn>>,
  getTracer: vi.fn(),
}))

vi.mock('../lib/config.js', () => ({ config: cfg }))
vi.mock('../lib/logger.js', () => ({
  logger: { warn: log.warn, info: log.info, child: () => ({ info: log.childInfo, warn: log.warn }) },
}))
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(opts: typeof otel.sdkOptions) {
      if (otel.failConstructor) throw new Error('sdk boom')
      otel.sdkOptions = opts
    }
    start() { otel.start() }
    shutdown() { return otel.shutdown() as Promise<void> }
  },
  tracing: { SimpleSpanProcessor: class { constructor(public exporter: unknown) {} } },
}))
vi.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: (o: unknown) => { otel.autoInstrOptions = o; return ['auto'] },
}))
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class { constructor(o: unknown) { otel.exporterOptions = o } },
}))
vi.mock('@opentelemetry/resources', () => ({ resourceFromAttributes: (a: unknown) => ({ attrs: a }) }))
vi.mock('@opentelemetry/semantic-conventions', () => ({ ATTR_SERVICE_NAME: 'service.name', ATTR_SERVICE_VERSION: 'service.version' }))
vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
  trace: {
    getTracer: (...a: unknown[]) => {
      otel.getTracer(...a)
      return { startSpan: (name: string) => { otel.tracerSpan!['started']!(name); return otel.tracerSpan } }
    },
    getActiveSpan: () => otel.activeSpan,
  },
}))

type Telemetry = typeof import('../telemetry.js')

function fakeSpan() {
  return { updateName: vi.fn(), setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn(), started: vi.fn() }
}

interface ProcessorLike { onStart(): void; onEnd(span: unknown): void; shutdown(): Promise<void>; forceFlush(): Promise<void> }

/** A finished span as the SDK hands it to the processor. */
function span(opts: {
  traceId: string; name: string; root?: boolean; error?: boolean
  attributes?: Record<string, unknown>; start?: [number, number]; duration?: [number, number]
}) {
  return {
    name: opts.name,
    parentSpanContext: opts.root ? undefined : { spanId: 'parent' },
    spanContext: () => ({ traceId: opts.traceId }),
    duration: opts.duration ?? [0, 5_000_000],
    startTime: opts.start ?? [1_700_000_000, 0],
    status: { code: opts.error ? 2 : 0 },
    attributes: opts.attributes,
  }
}

let sigtermHandler: (() => void) | null = null
const realOn = process.on.bind(process)

async function loadFresh(): Promise<Telemetry> {
  vi.resetModules()
  return import('../telemetry.js')
}

/** Start telemetry and wait for the async SDK bootstrap to finish. */
async function startEnabled(): Promise<{ t: Telemetry; processor: ProcessorLike }> {
  cfg.otelEnabled = true
  const t = await loadFresh()
  t.initTelemetry()
  await vi.waitFor(() => expect(otel.start).toHaveBeenCalled())
  await vi.waitFor(() => expect(log.childInfo).toHaveBeenCalled())
  const processor = otel.sdkOptions!.spanProcessors[1] as ProcessorLike
  return { t, processor }
}

beforeEach(() => {
  vi.clearAllMocks()
  cfg.otelEnabled = false
  otel.sdkOptions = null
  otel.failConstructor = false
  otel.tracerSpan = fakeSpan()
  otel.activeSpan = undefined
  otel.shutdown.mockResolvedValue(undefined)
  sigtermHandler = null
  vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
    // Never register a real SIGTERM listener from a test: capture it instead.
    if (event === 'SIGTERM') { sigtermHandler = handler; return process }
    return realOn(event, handler)
  }) as typeof process.on)
  delete (globalThis as { __OG_TELEMETRY_PRELOADED__?: boolean }).__OG_TELEMETRY_PRELOADED__
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('with OTEL disabled (the default)', () => {
  it('initTelemetry does nothing and every helper is a harmless no-op', async () => {
    const t = await loadFresh()
    t.initTelemetry()
    expect(t.otelEnabled).toBe(false)
    expect(t.otelEndpoint).toBeUndefined()
    expect(log.warn).not.toHaveBeenCalled()

    // The Apollo plugin calls these on every request whether tracing is on or not.
    const h = t.startGraphQLSpan('GraphQL Query')
    expect(() => { h.updateName('x'); h.setAttribute('k', 'v'); h.setError('e'); h.end() }).not.toThrow()
    expect(() => t.updateActiveSpanName('query', 'GetCITypes')).not.toThrow()
    expect(t.recentTraces).toEqual([])
    // Nothing was bootstrapped behind the scenes.
    await Promise.resolve()
    expect(otel.start).not.toHaveBeenCalled()
  })
})

describe('initTelemetry with OTEL enabled', () => {
  it('starts the SDK once with the configured endpoint, even when called twice', async () => {
    const { t } = await startEnabled()
    t.initTelemetry()
    await Promise.resolve()

    expect(t.otelEnabled).toBe(true)
    expect(t.otelEndpoint).toBe('http://collector:4318/v1/traces')
    expect(otel.start).toHaveBeenCalledTimes(1)
    expect(otel.exporterOptions).toEqual({ url: 'http://collector:4318/v1/traces' })
    // The resource names this service, so Jaeger groups its spans correctly.
    expect(otel.sdkOptions!.resource).toEqual({ attrs: { 'service.name': 'opengrafo-api', 'service.version': '0.17.0' } })
    // One operation per GraphQL field, not one per list row (see the source comment).
    expect(otel.autoInstrOptions).toMatchObject({
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-graphql': { mergeItems: true, ignoreTrivialResolveSpans: true },
    })
    expect(otel.getTracer).toHaveBeenCalledWith('opengrafo-api', '0.17.0')
  })

  it('warns that HTTP/DB spans will be missing when not preloaded', async () => {
    await startEnabled()
    expect(log.warn).toHaveBeenCalledWith({ module: 'telemetry' }, expect.stringContaining('--import ./dist/telemetry-register.js'))
  })

  it('stays quiet when the preload already ran', async () => {
    (globalThis as { __OG_TELEMETRY_PRELOADED__?: boolean }).__OG_TELEMETRY_PRELOADED__ = true
    await startEnabled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('shuts the SDK down on SIGTERM and swallows a failing shutdown', async () => {
    await startEnabled()
    expect(sigtermHandler).toBeTypeOf('function')
    otel.shutdown.mockRejectedValueOnce(new Error('flush failed'))
    // A failed flush on the way out must not turn into an unhandled rejection.
    expect(() => sigtermHandler!()).not.toThrow()
    await Promise.resolve()
    expect(otel.shutdown).toHaveBeenCalledTimes(1)
  })

  it('an SDK that fails to start leaves the API running with otelEnabled back to false', async () => {
    cfg.otelEnabled = true
    otel.failConstructor = true
    const t = await loadFresh()
    t.initTelemetry()
    expect(t.otelEnabled).toBe(true)
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.stringContaining('continuing without tracing')))
    expect(t.otelEnabled).toBe(false)
    // No tracer was installed: the helpers remain no-ops.
    t.startGraphQLSpan('x').end()
    expect(otel.tracerSpan!['end']).not.toHaveBeenCalled()
  })
})

describe('span helpers once the SDK is up', () => {
  it('startGraphQLSpan drives a real span and maps setError to status ERROR', async () => {
    const { t } = await startEnabled()
    const h = t.startGraphQLSpan('GraphQL Query')
    const s = otel.tracerSpan!
    expect(s['started']).toHaveBeenCalledWith('GraphQL Query')
    h.updateName('GraphQL Query.GetIncidents')
    h.setAttribute('graphql.operation.name', 'GetIncidents')
    h.setError('boom')
    h.end()
    expect(s['updateName']).toHaveBeenCalledWith('GraphQL Query.GetIncidents')
    expect(s['setAttribute']).toHaveBeenCalledWith('graphql.operation.name', 'GetIncidents')
    expect(s['setStatus']).toHaveBeenCalledWith({ code: 2, message: 'boom' })
    expect(s['end']).toHaveBeenCalledTimes(1)
  })

  it('updateActiveSpanName puts the composite only in the NAME, the bare name in the attribute', async () => {
    const { t } = await startEnabled()
    // No active span (e.g. a background job): nothing to rename, no crash.
    expect(() => t.updateActiveSpanName('query', 'GetCITypes')).not.toThrow()

    const active = fakeSpan()
    otel.activeSpan = active
    t.updateActiveSpanName('query', 'GetCITypes')
    expect(active.updateName).toHaveBeenCalledWith('GraphQL Query.GetCITypes')
    // Regression guard: the attribute once received "Query.GetCITypes" and the
    // traces panel showed "Query.Query.GetCITypes".
    expect(active.setAttribute).toHaveBeenCalledWith('graphql.operation.name', 'GetCITypes')
    expect(active.setAttribute).toHaveBeenCalledWith('graphql.operation.type', 'query')
  })
})

describe('RecentTraceProcessor', () => {
  it('accumulates child spans and records one entry when the root span ends', async () => {
    const { t, processor } = await startEnabled()
    processor.onStart()
    processor.onEnd(span({ traceId: 'tr-1', name: 'neo4j.run' }))
    processor.onEnd(span({ traceId: 'tr-1', name: 'graphql.execute', error: true,
      attributes: { 'graphql.operation.type': 'mutation', 'graphql.operation.name': 'CreateIncident' } }))
    // The root span's own name (an HTTP span) must not overwrite the GraphQL name.
    processor.onEnd(span({ traceId: 'tr-1', name: 'POST', root: true,
      attributes: { 'http.target': '/api/other' }, start: [1_700_000_000, 500_000_000], duration: [1, 250_000_000] }))

    expect(t.recentTraces).toEqual([{
      traceId: 'tr-1', operationName: 'Mutation.CreateIncident', durationMs: 1250,
      status: 'ERROR', timestamp: new Date(1_700_000_000_500).toISOString(), spanCount: 3,
    }])
    await expect(processor.shutdown()).resolves.toBeUndefined()
    await expect(processor.forceFlush()).resolves.toBeUndefined()
  })

  it('defaults a missing operation type to Query and a missing name to anonymous', async () => {
    const { t, processor } = await startEnabled()
    processor.onEnd(span({ traceId: 'a', name: 'x', root: true, attributes: { 'graphql.operation.name': 'GetTeams' } }))
    processor.onEnd(span({ traceId: 'b', name: 'x', root: true, attributes: { 'graphql.operation.type': 'query' } }))
    expect(t.recentTraces.map((r) => [r.operationName, r.status])).toEqual([['Query.GetTeams', 'OK'], ['Query.anonymous', 'OK']])
  })

  it.each([
    ['GET probes', 'GET /anything', {}],
    ['HEAD', 'HEAD', {}],
    ['OPTIONS preflight', 'OPTIONS', {}],
    ['the duplicate POST /graphql HTTP span', 'POST', { 'http.target': '/graphql?x=1' }],
    ['health/metrics/SSE paths', 'PUT', { 'http.target': '/health/ready' }],
    ['dashboard polling (GraphQL Query.X form)', 'GraphQL Query.GetSystemHealth', {}],
    ['dashboard polling (Query.X form)', 'Query.GetQueueStats', {}],
    ['dashboard polling (GraphQL X form)', 'GraphQL GetTraceInfo', {}],
  ])('filters %s out of the panel', async (_label, name, attributes) => {
    const { t, processor } = await startEnabled()
    processor.onEnd(span({ traceId: 'n', name, root: true, attributes }))
    expect(t.recentTraces).toEqual([])
  })

  it('filters dashboard polling identified via GraphQL attributes', async () => {
    const { t, processor } = await startEnabled()
    processor.onEnd(span({ traceId: 'p', name: 'POST', root: true,
      attributes: { 'graphql.operation.type': 'query', 'graphql.operation.name': 'GetSystemMetrics' } }))
    expect(t.recentTraces).toEqual([])
  })

  it('keeps only the 50 most recent traces', async () => {
    const { t, processor } = await startEnabled()
    for (let i = 0; i < 55; i++) {
      processor.onEnd(span({ traceId: `t${i}`, name: `Mutation.Op${i}`, root: true }))
    }
    expect(t.recentTraces).toHaveLength(50)
    // Oldest evicted first.
    expect(t.recentTraces[0]!.traceId).toBe('t5')
    expect(t.recentTraces[49]!.traceId).toBe('t54')
  })
})
