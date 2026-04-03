import { otelEnabled } from '../telemetry.js'

export async function withTracedSession<T>(
  query: string,
  _operation: 'READ' | 'WRITE',
  fn: () => Promise<T>,
): Promise<T> {
  if (!otelEnabled) return fn()

  // Lazily import otel api only when enabled
  const { trace, SpanStatusCode } = await import('@opentelemetry/api')
  const tracer = trace.getTracer('opengrafo-neo4j')

  return tracer.startActiveSpan(`neo4j.query`, async (span) => {
    span.setAttribute('db.system', 'neo4j')
    span.setAttribute('db.statement', query.slice(0, 500))
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
      span.recordException(err as Error)
      throw err
    } finally {
      span.end()
    }
  })
}
