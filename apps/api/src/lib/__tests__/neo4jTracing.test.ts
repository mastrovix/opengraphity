/**
 * Neo4j query tracing.
 *
 * Why these behaviours matter:
 *  - With telemetry off (the default) the wrapper must be a pure pass-through:
 *    it must not load the OpenTelemetry API nor alter the result or the error.
 *  - With telemetry on, every query becomes a span that is ALWAYS ended, marked
 *    OK or ERROR, and the original error is rethrown untouched — a tracing
 *    wrapper that swallowed or rewrapped errors would change how resolvers fail.
 *  - The statement attribute is capped at 500 chars so a huge Cypher does not
 *    bloat every exported span.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../telemetry.js', () => ({ get otelEnabled() { return state.enabled } }))

const span = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
}
const getTracer = vi.fn(() => ({
  startActiveSpan: (_name: string, fn: (s: typeof span) => unknown) => fn(span),
}))
vi.mock('@opentelemetry/api', () => ({
  trace: { getTracer: (...a: unknown[]) => getTracer(...(a as [])) },
  SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
}))

const { withTracedSession } = await import('../neo4jTracing.js')

beforeEach(() => { vi.clearAllMocks(); state.enabled = false })

describe('withTracedSession', () => {
  it('telemetry off: returns the result without creating any span', async () => {
    await expect(withTracedSession('RETURN 1', 'READ', async () => 42)).resolves.toBe(42)
    expect(getTracer).not.toHaveBeenCalled()
  })

  it('telemetry off: the error reaches the caller unchanged', async () => {
    const err = new Error('constraint violated')
    await expect(withTracedSession('CREATE (n)', 'WRITE', async () => { throw err })).rejects.toBe(err)
  })

  it('telemetry on: a successful query is an OK span with the (truncated) statement, then ended', async () => {
    state.enabled = true
    const query = 'MATCH (n) RETURN n ' + 'x'.repeat(1000)
    await expect(withTracedSession(query, 'READ', async () => 'rows')).resolves.toBe('rows')
    expect(getTracer).toHaveBeenCalledWith('opengrafo-neo4j')
    expect(span.setAttribute).toHaveBeenCalledWith('db.system', 'neo4j')
    const stmt = span.setAttribute.mock.calls.find((c) => c[0] === 'db.statement')![1] as string
    expect(stmt).toHaveLength(500)
    expect(query.startsWith(stmt)).toBe(true)
    expect(span.setStatus).toHaveBeenCalledWith({ code: 1 })
    expect(span.end).toHaveBeenCalledTimes(1)
  })

  it('telemetry on: a failing query is an ERROR span, records the exception, ends, and rethrows the same error', async () => {
    state.enabled = true
    const err = new Error('deadlock')
    await expect(withTracedSession('MERGE (n)', 'WRITE', async () => { throw err })).rejects.toBe(err)
    expect(span.setStatus).toHaveBeenCalledWith({ code: 2, message: 'Error: deadlock' })
    expect(span.recordException).toHaveBeenCalledWith(err)
    expect(span.end).toHaveBeenCalledTimes(1)
  })
})
