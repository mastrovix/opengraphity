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
}

export function initTelemetry(): void {
  if (process.env['OTEL_ENABLED'] !== 'true') return

  otelEnabled = true
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
      const { SpanStatusCode }               = await import('@opentelemetry/api')

      const telLogger = logger.child({ module: 'telemetry' })

      // Custom SpanProcessor that captures root spans into the recentTraces buffer
      const RecentTraceProcessor = {
        onStart(): void { /* noop */ },

        onEnd(span: ReadableSpanMinimal): void {
          // Only capture root spans (no parent)
          if (span.parentSpanId) return

          const traceId      = span.spanContext().traceId
          const durationMs   = (span.duration[0] * 1e3) + (span.duration[1] / 1e6)
          const status: 'OK' | 'ERROR' = span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK'
          const operationName = span.name || 'unknown'

          recentTraces.push({
            traceId,
            operationName,
            durationMs,
            status,
            timestamp: new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString(),
            spanCount: 1,
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
