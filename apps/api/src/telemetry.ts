// Must be imported FIRST in index.ts before any other import
import { logger } from './lib/logger.js'

// Circular buffer for recent traces (exported for use in monitoring resolver)
export interface RecentTrace {
  traceId: string
  operationName: string
  durationMs: number
  status: 'OK' | 'ERROR'
  timestamp: string
  spanCount: number
}

const MAX_RECENT_TRACES = 50
export const recentTraces: RecentTrace[] = []

export let otelEnabled = false
export let otelEndpoint: string | undefined

// Minimal interface matching what we need from ReadableSpan
interface SpanTime { 0: number; 1: number }
interface SpanContext { traceId: string }
interface ReadableSpanMinimal {
  name: string
  parentSpanId?: string
  spanContext(): SpanContext
  duration: SpanTime
  startTime: SpanTime
  status: { code: number }
  attributes?: Record<string, unknown>
}

// ── Trace accumulator (one entry per in-flight trace) ─────────────────────────

interface TraceAcc {
  operationName: string
  spanCount:     number
  status:        'OK' | 'ERROR'
  startTime:     SpanTime
}

const traceAccumulators = new Map<string, TraceAcc>()

// Noise filters — these traces add no signal to the dashboard
const NOISE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const NOISE_HTTP_PATHS   = ['/health', '/metrics', '/api/sse', '/favicon']
// Dashboard self-monitoring queries (poll every 15s — would flood the list)
const NOISE_GQL_OPS      = new Set([
  'GetSystemHealth', 'GetSystemMetrics', 'GetTraceInfo', 'GetQueueStats',
])

/** Extract the bare GraphQL operation name from any of our span name formats:
 *  "GraphQL Query.GetSystemHealth" → "GetSystemHealth"
 *  "Query.GetSystemHealth"         → "GetSystemHealth"
 *  "GraphQL GetSystemHealth"       → "GetSystemHealth"
 */
function extractGqlOpName(operationName: string): string {
  let name = operationName
  if (name.startsWith('GraphQL ')) name = name.slice(8)
  if (name.includes('.'))          name = name.split('.')[1] ?? name
  return name
}

function isNoisyTrace(operationName: string, httpTarget: string): boolean {
  const method = operationName.split(' ')[0] ?? ''
  // Filter GET/HEAD/OPTIONS spans (health, metrics, SSE, assets)
  if (NOISE_HTTP_METHODS.has(method)) return true
  // Filter POST /graphql HTTP spans — the Apollo plugin span is authoritative;
  // drop any duplicate from HTTP auto-instrumentation to avoid double entries.
  if (method === 'POST' && httpTarget.startsWith('/graphql')) return true
  // Filter by HTTP path
  if (NOISE_HTTP_PATHS.some(p => httpTarget.startsWith(p))) return true
  // Filter dashboard self-monitoring queries (poll every 15s)
  if (NOISE_GQL_OPS.has(extractGqlOpName(operationName))) return true
  return false
}

// ── OTEL API references (set during initTelemetry) ───────────────────────────

interface OtelSpan {
  updateName(name: string): void
  setAttribute(key: string, value: string): void
  setStatus(status: { code: number; message?: string }): void
  end(): void
}
interface OtelTracer { startSpan(name: string): OtelSpan }
interface TraceApi   { getActiveSpan(): OtelSpan | undefined }

let _tracer:   OtelTracer | null = null
let _traceApi: TraceApi   | null = null

// ── Explicit GraphQL span (created by Apollo plugin) ─────────────────────────

export interface GraphQLSpanHandle {
  updateName(name: string): void
  setAttribute(key: string, value: string): void
  setError(message: string): void
  end(): void
}

const NO_OP_HANDLE: GraphQLSpanHandle = {
  updateName()   {},
  setAttribute() {},
  setError()     {},
  end()          {},
}

/** Create a standalone root span for a GraphQL operation. No-op if OTEL is disabled. */
export function startGraphQLSpan(initialName: string): GraphQLSpanHandle {
  if (!_tracer) return NO_OP_HANDLE
  const span = _tracer.startSpan(initialName)
  return {
    updateName(name: string)                 { span.updateName(name) },
    setAttribute(key: string, val: string)   { span.setAttribute(key, val) },
    setError(message: string)                { span.setStatus({ code: 2 /* ERROR */, message }) },
    end()                                    { span.end() },
  }
}

/**
 * Rename the currently active HTTP span (from auto-instrumentation) to include
 * the GraphQL operation. No-op when OTEL is disabled.
 */
export function updateActiveSpanName(operationName: string): void {
  if (!_traceApi) return
  const span = _traceApi.getActiveSpan()
  if (!span) return
  span.updateName(`GraphQL ${operationName}`)
  span.setAttribute('graphql.operation.name', operationName)
}

export function initTelemetry(): void {
  if (process.env['OTEL_ENABLED'] !== 'true') return

  otelEnabled  = true
  otelEndpoint = process.env['OTEL_ENDPOINT'] ?? 'http://localhost:4318/v1/traces'

  void (async () => {
    try {
      const { NodeSDK }                      = await import('@opentelemetry/sdk-node')
      const { getNodeAutoInstrumentations }  = await import('@opentelemetry/auto-instrumentations-node')
      const { OTLPTraceExporter }            = await import('@opentelemetry/exporter-trace-otlp-http')
      const { Resource }                     = await import('@opentelemetry/resources')
      const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = await import('@opentelemetry/semantic-conventions')
      const sdkNode = await import('@opentelemetry/sdk-node')
      const { SimpleSpanProcessor }          = sdkNode.tracing
      const { SpanStatusCode, trace }        = await import('@opentelemetry/api')

      const telLogger = logger.child({ module: 'telemetry' })

      // Store API references for exported helpers (set after sdk.start below)
      // _tracer and _traceApi are set after sdk.start()

      // Custom SpanProcessor: accumulates spans by traceId, extracts GraphQL
      // operation names from auto-instrumentation attributes, filters noise,
      // and finalises a RecentTrace entry when the root span ends.
      const RecentTraceProcessor = {
        onStart(): void { /* noop */ },

        onEnd(span: ReadableSpanMinimal): void {
          const traceId = span.spanContext().traceId
          const isRoot  = !span.parentSpanId

          // Get or create accumulator for this trace
          let acc = traceAccumulators.get(traceId)
          if (!acc) {
            acc = {
              operationName: span.name,
              spanCount:     0,
              status:        'OK',
              startTime:     span.startTime,
            }
            traceAccumulators.set(traceId, acc)
          }
          acc.spanCount += 1

          // Extract GraphQL operation from @opentelemetry/instrumentation-graphql attrs
          const attrs   = span.attributes ?? {}
          const gqlType = attrs['graphql.operation.type'] as string | undefined
          const gqlName = attrs['graphql.operation.name'] as string | undefined
          if (gqlType || gqlName) {
            const type = gqlType
              ? gqlType.charAt(0).toUpperCase() + gqlType.slice(1)
              : 'Query'
            acc.operationName = `${type}.${gqlName || 'anonymous'}`
          }

          if (span.status.code === SpanStatusCode.ERROR) acc.status = 'ERROR'

          // Only finalise when the root span ends (root = no parent = HTTP span)
          if (!isRoot) return

          const finalAcc = acc
          traceAccumulators.delete(traceId)

          const httpTarget = (span.attributes?.['http.target'] ?? '') as string
          if (isNoisyTrace(finalAcc.operationName, httpTarget)) return

          const durationMs = (span.duration[0] * 1e3) + (span.duration[1] / 1e6)
          const timestamp  = new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString()

          recentTraces.push({
            traceId,
            operationName: finalAcc.operationName,
            durationMs,
            status:    finalAcc.status,
            timestamp,
            spanCount: finalAcc.spanCount,
          })
          if (recentTraces.length > MAX_RECENT_TRACES) recentTraces.shift()
        },

        shutdown(): Promise<void> { return Promise.resolve() },
        forceFlush(): Promise<void> { return Promise.resolve() },
      }

      const exporter = new OTLPTraceExporter({ url: otelEndpoint })

      const sdk = new NodeSDK({
        resource: new Resource({
          [SEMRESATTRS_SERVICE_NAME]:    'opengrafo-api',
          [SEMRESATTRS_SERVICE_VERSION]: '0.17.0',
        }),
        spanProcessors: [
          new SimpleSpanProcessor(exporter),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          RecentTraceProcessor as any,
        ],
        instrumentations: [getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        })],
      })

      sdk.start()
      // Tracer must be obtained AFTER sdk.start() — before that it returns a no-op tracer
      _traceApi = trace
      _tracer   = trace.getTracer('opengrafo-api', '0.17.0')
      telLogger.info({ endpoint: otelEndpoint }, 'OpenTelemetry SDK started')

      process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}) })
    } catch (err) {
      logger.warn({ err }, 'Failed to initialise OpenTelemetry — continuing without tracing')
      otelEnabled = false
    }
  })()
}
