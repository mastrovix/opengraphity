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

function isNoisyTrace(operationName: string, httpTarget: string): boolean {
  // Filter plain HTTP method spans (no route detail)
  const method = operationName.split(' ')[0] ?? ''
  if (NOISE_HTTP_METHODS.has(method)) return true
  // Filter by HTTP path
  if (NOISE_HTTP_PATHS.some(p => httpTarget.startsWith(p))) return true
  // Filter dashboard monitoring queries
  const gqlOp = operationName.includes('.') ? (operationName.split('.')[1] ?? '') : operationName
  if (NOISE_GQL_OPS.has(gqlOp)) return true
  return false
}

// ── Active-span API (set during initTelemetry, used by Apollo plugin) ─────────

interface SpanApi {
  updateName(name: string): void
  setAttribute(key: string, value: string): void
}
interface TraceApi {
  getActiveSpan(): SpanApi | undefined
}
let _traceApi: TraceApi | null = null

/**
 * Called by the Apollo Server plugin to rename the active HTTP span
 * to include the GraphQL operation name (e.g. "GraphQL incidents").
 * No-op when OTEL is disabled.
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

      // Store trace API for use by updateActiveSpanName()
      _traceApi = trace

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
      telLogger.info({ endpoint: otelEndpoint }, 'OpenTelemetry SDK started')

      process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}) })
    } catch (err) {
      logger.warn({ err }, 'Failed to initialise OpenTelemetry — continuing without tracing')
      otelEnabled = false
    }
  })()
}
