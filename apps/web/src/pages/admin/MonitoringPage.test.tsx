/**
 * PLATFORM MONITORING: the page an administrator opens when OpenGrafo itself
 * is slow or failing — the health of Neo4j, Redis and Keycloak, the request
 * rate and latency, the job queues, the database, the traces and the process.
 *
 * What must hold, because this page is read during an incident:
 * - every figure comes from the answer, formatted in the unit it is read in
 *   (ms, %, MB, «1d 2h 3m»), and a figure not received yet is a dash;
 * - what needs attention stands out: a failing service with its error, an
 *   error rate above 5%, a queue with failed jobs, a failed trace;
 * - the requests-per-minute chart is a rolling window of the polled samples
 *   (drawn from the second one, at most the last 30);
 * - the tracing section says whether tracing is on and, when it is off,
 *   what the deployment would need, without a recipe for our own stack.
 *
 * ECharts is a stand-in that keeps the option it receives: the test reads the
 * series the user would see, not the canvas.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithProviders, setCssVars } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'
import { resetCssVarCache } from '@/lib/charts/cssVar'
import { MonitoringPage } from './MonitoringPage'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

interface ChartOption { series: { data: number[] }[]; tooltip: { formatter: (p: { value: number }[]) => string } }
const drawn = vi.hoisted(() => [] as unknown[])
vi.mock('echarts-for-react', () => ({
  default: ({ option }: { option: unknown }) => {
    drawn.push(option)
    return <div data-testid="rpm-chart" />
  },
}))
const lastChart = () => drawn.at(-1) as ChartOption

// ECharts draws on a canvas, so the page resolves its colours from CSS variables jsdom does not have.
let clearCssVars: () => void = () => {}
beforeAll(() => {
  resetCssVarCache()
  clearCssVars = setCssVars({ '--color-brand': '#0284c7', '--color-icon-accent-a12': 'rgba(56, 189, 248, 0.12)' })
})
afterAll(() => { clearCssVars(); resetCssVarCache() })

// ── Fixtures ─────────────────────────────────────────────────────────────────

const check = (over: Record<string, unknown> = {}) => ({ status: 'ok', latencyMs: 3, error: null, ...over })
const health = (over: Record<string, unknown> = {}) => ({
  systemHealth: { status: 'ok', uptime: 93_784, checks: { neo4j: check(), redis: check(), keycloak: check() }, ...over },
})
const metrics = (requests: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ({
  systemMetrics: {
    requests: { totalRequests: 5000, requestsPerMinute: 12.4, averageResponseMs: 85.6, p95ResponseMs: 250, errorRate: 0.0123, statusCodes: [], ...requests },
    graphql: { totalOperations: 4000, slowestResolvers: [], errorsByResolver: [] },
    queues: [],
    neo4j: { totalQueries: 1234, averageQueryMs: 4.56, slowQueries: [], connectionPoolActive: 2, connectionPoolIdle: 8 },
    system: { memoryUsageMb: 312.4, memoryRssMb: 540.6, cpuUsagePercent: 17.25, nodeVersion: 'v24.21.0', uptimeSeconds: 3_660, pid: 4242 },
    ...rest,
  },
})
const trace = (i: number, over: Record<string, unknown> = {}) => ({
  traceId: `t-${i}`, operationName: `Op${i}`, durationMs: 10 + i, status: 'OK', timestamp: '2026-09-01T08:30:00Z', spanCount: 1, ...over,
})

beforeEach(() => {
  apolloFinto.reset()
  drawn.length = 0
})

const mount = () => renderWithProviders(<MonitoringPage />)
/** The value shown under a label, in the card of that label. */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement
const section = (title: string) => screen.getByRole('heading', { name: title }).parentElement!

// ── Before any answer ────────────────────────────────────────────────────────

describe('before the first answer', () => {
  it('every figure is a dash, there is no chart and no queue', () => {
    mount()
    expect(screen.getByRole('heading', { name: 'Platform monitoring' })).toBeInTheDocument()
    // The uptime and the three services: nothing known, nothing claimed.
    expect(within(section('System Health')).getAllByText('—')).toHaveLength(4)
    for (const label of ['Requests/min', 'Avg Response', 'P95 Response', 'Error Rate', 'Total Queries', 'Avg Query Time',
      'Heap Memory', 'RSS', 'CPU', 'Node.js', 'PID']) {
      expect(valueOf(label)).toHaveTextContent('—')
    }
    expect(within(section('Process')).getByText('Uptime').nextElementSibling).toHaveTextContent('—')
    expect(within(section('BullMQ Queues')).getByText('No results')).toBeInTheDocument()
    expect(screen.queryByTestId('rpm-chart')).toBeNull()
    // Nothing is said about tracing until the API has answered.
    expect(within(section('OpenTelemetry Tracing')).queryByText(/Enabled|Tracing is off/)).toBeNull()
  })

  // Found by this test (tour of 23 Sep 2026), fixed: with no answer yet — or when the health query
  // fails — each service was shown as «Error» with a red dot, while every other unknown figure on the
  // page is a dash: the page reported an outage of Neo4j, Redis and Keycloak it knew nothing about.
  it('a service whose state is not known yet is not declared in error', () => {
    mount()
    expect(screen.queryAllByText('Error')).toHaveLength(0)
  })
})

// ── Health ───────────────────────────────────────────────────────────────────

describe('system health', () => {
  // Review of 23 Sep 2026: a failed poll kept the last «OK» on screen, green, as if current.
  it('a failed poll: the dots go grey, nothing is claimed «Operational», and the card says it could not read', () => {
    apolloFinto.risposte['GetSystemHealth'] = health()
    apolloFinto.erroriDiPolling['GetSystemHealth'] = new Error('Failed to fetch')
    mount()
    const card = section('System Health')
    expect(within(card).queryByText('Operational')).toBeNull()
    expect(within(card).getByRole('alert')).toHaveTextContent('Could not refresh: Failed to fetch')
  })

  it('metrics and tracing that cannot be read at all say so, instead of «No results» and nothing', () => {
    apolloFinto.erroriQuery['GetSystemMetrics'] = new Error('metrics down')
    apolloFinto.erroriQuery['GetTraceInfo'] = new Error('trace down')
    mount()
    expect(within(section('BullMQ Queues')).queryByText('No results')).toBeNull()
    expect(within(section('BullMQ Queues')).getByText('metrics down')).toBeInTheDocument()
    expect(within(section('OpenTelemetry Tracing')).getByText('trace down')).toBeInTheDocument()
  })

  it('shows the uptime and, per service, its state, its latency and its error', () => {
    apolloFinto.risposte['GetSystemHealth'] = health({ checks: {
      neo4j: check({ latencyMs: 12 }),
      redis: check({ status: 'error', latencyMs: null, error: 'connect ECONNREFUSED 10.0.0.5:6379' }),
      // A latency of 0 ms is a latency, not a missing one.
      keycloak: check({ latencyMs: 0 }),
    } })
    mount()
    const cardOf = (service: string) => within(section('System Health')).getByText(service).parentElement!
    expect(within(section('System Health')).getByText('1d 2h 3m')).toBeInTheDocument()
    expect(cardOf('Neo4j')).toHaveTextContent('Operational')
    expect(cardOf('Neo4j')).toHaveTextContent('Latency: 12ms')
    expect(cardOf('Redis')).toHaveTextContent('Error')
    expect(cardOf('Redis')).toHaveTextContent('connect ECONNREFUSED 10.0.0.5:6379')
    expect(cardOf('Redis')).not.toHaveTextContent('Latency')
    expect(cardOf('Keycloak')).toHaveTextContent('Latency: 0ms')
    expect(within(cardOf('Redis')).getByText('Error')).toHaveStyle({ color: 'var(--color-danger)' })
    expect(within(cardOf('Neo4j')).getByText('Operational')).toHaveStyle({ color: 'var(--color-success)' })
  })

  it('an uptime under an hour is in minutes, under a day in hours and minutes', () => {
    apolloFinto.risposte['GetSystemHealth'] = health({ uptime: 59 })
    apolloFinto.risposte['GetSystemMetrics'] = metrics()
    mount()
    expect(within(section('System Health')).getByText('0m')).toBeInTheDocument()
    expect(within(section('Process')).getByText('1h 1m')).toBeInTheDocument()
  })
})

// ── Requests and the chart ───────────────────────────────────────────────────

describe('request metrics', () => {
  it('shows rate, average and p95 latency and the error rate, rounded as read', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics()
    mount()
    expect(valueOf('Requests/min')).toHaveTextContent('12')
    expect(valueOf('Avg Response')).toHaveTextContent('86ms')
    expect(valueOf('P95 Response')).toHaveTextContent('250ms')
    expect(valueOf('Error Rate')).toHaveTextContent('1.2%')
    expect(valueOf('Error Rate')).toHaveStyle({ color: 'var(--color-slate-dark)' })
  })

  it('an error rate above 5% is shown in red', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics({ errorRate: 0.08 })
    mount()
    expect(valueOf('Error Rate')).toHaveTextContent('8.0%')
    expect(valueOf('Error Rate')).toHaveStyle({ color: 'var(--color-danger)' })
  })

  it('the chart starts at the second sample, keeps the last 30, and its tooltip reads requests per minute', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics({ requestsPerMinute: 1 })
    const { rerender } = mount()
    expect(screen.queryByTestId('rpm-chart')).toBeNull()
    apolloFinto.risposte['GetSystemMetrics'] = metrics({ requestsPerMinute: 2 })
    rerender(<MonitoringPage />)
    expect(screen.getByTestId('rpm-chart')).toBeInTheDocument()
    expect(lastChart().series[0]!.data).toEqual([1, 2])
    for (let rpm = 3; rpm <= 32; rpm++) {
      apolloFinto.risposte['GetSystemMetrics'] = metrics({ requestsPerMinute: rpm })
      rerender(<MonitoringPage />)
    }
    const data = lastChart().series[0]!.data
    expect(data).toHaveLength(30)
    expect(data[0]).toBe(3)
    expect(data.at(-1)).toBe(32)
    expect(lastChart().tooltip.formatter([{ value: 32 }])).toBe('32 req/min')
    expect(lastChart().tooltip.formatter([])).toBe('0 req/min')
  })

  it('the same rate polled again is not a new sample', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics({ requestsPerMinute: 7 })
    const { rerender } = mount()
    rerender(<MonitoringPage />)
    expect(screen.queryByTestId('rpm-chart')).toBeNull()
  })
})

// ── Queues, database, process ────────────────────────────────────────────────

describe('queues, database and process', () => {
  it('lists each queue with its counters, a queue with failed jobs in red', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics({}, { queues: [
      { name: 'notifications', waiting: 3, active: 1, completed: 900, failed: 0, delayed: 2 },
      { name: 'sla-timers', waiting: 0, active: 0, completed: 40, failed: 5, delayed: 0 },
    ] })
    mount()
    const row = (name: string) => within(section('BullMQ Queues')).getByText(name).closest('tr')!
    expect([...row('notifications').querySelectorAll('td')].map((c) => c.textContent)).toEqual(['notifications', '3', '1', '900', '0', '2'])
    expect(within(row('sla-timers')).getByText('5')).toHaveStyle({ color: 'var(--color-danger)' })
    expect(within(row('notifications')).getByText('0')).not.toHaveStyle({ color: 'var(--color-danger)' })
  })

  it('shows the database figures and its slow queries with duration and time', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics({}, {
      neo4j: { totalQueries: 1234, averageQueryMs: 4.56, connectionPoolActive: 2, connectionPoolIdle: 8,
        slowQueries: [{ query: 'MATCH (n:Incident) RETURN n', durationMs: 812.4, timestamp: '2026-09-01T08:30:00Z' }] },
    })
    mount()
    expect(valueOf('Total Queries')).toHaveTextContent('1234')
    expect(valueOf('Avg Query Time')).toHaveTextContent('4.6ms')
    expect(screen.getByText('Slow Queries (>500ms)')).toBeInTheDocument()
    const slow = screen.getByText('MATCH (n:Incident) RETURN n').closest('tr')!
    expect(within(slow).getByText('812ms')).toBeInTheDocument()
    expect(within(slow).getByText('10:30:00')).toBeInTheDocument()
  })

  it('without slow queries, there is no slow-query table', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics()
    mount()
    expect(screen.queryByText('Slow Queries (>500ms)')).toBeNull()
  })

  it('shows the process figures', () => {
    apolloFinto.risposte['GetSystemMetrics'] = metrics()
    mount()
    expect(valueOf('Heap Memory')).toHaveTextContent('312 MB')
    expect(valueOf('RSS')).toHaveTextContent('541 MB')
    expect(valueOf('CPU')).toHaveTextContent('17.3%')
    expect(valueOf('Node.js')).toHaveTextContent('v24.21.0')
    expect(valueOf('PID')).toHaveTextContent('4242')
  })
})

// ── Tracing ──────────────────────────────────────────────────────────────────

describe('tracing', () => {
  it('when on: where traces go, and the last 20 traces, newest first, with their spans and state', () => {
    const traces = Array.from({ length: 22 }, (_, i) => trace(i + 1))
    traces[21] = trace(22, { status: 'ERROR', spanCount: 3, durationMs: 1234.56 })
    apolloFinto.risposte['GetTraceInfo'] = { traceInfo: { enabled: true, endpoint: 'http://otel-collector:4318', recentTraces: traces } }
    mount()
    const tracing = section('OpenTelemetry Tracing')
    expect(within(tracing).getByText('Enabled')).toBeInTheDocument()
    expect(within(tracing).getByText('http://otel-collector:4318')).toBeInTheDocument()
    const rows = within(tracing).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(20)
    // Newest first: the API sends them oldest first.
    expect(rows[0]).toHaveTextContent('Op22')
    expect(rows[0]).toHaveTextContent('— 3 spans')
    expect(within(rows[0]!).getByText('1234.6ms')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('ERROR')).toHaveStyle({ color: 'var(--color-danger)' })
    expect(rows[19]).toHaveTextContent('Op3')
    expect(rows[19]).not.toHaveTextContent('span')
    expect(within(rows[19]!).getByText('OK')).toHaveStyle({ color: 'var(--color-success)' })
    expect(within(tracing).queryByText('Op2')).toBeNull()
  })

  it('when on with no trace yet, says so; no endpoint, no endpoint line', () => {
    apolloFinto.risposte['GetTraceInfo'] = { traceInfo: { enabled: true, endpoint: null, recentTraces: [] } }
    mount()
    const tracing = section('OpenTelemetry Tracing')
    expect(within(tracing).getByText('No recent traces')).toBeInTheDocument()
    expect(within(tracing).queryByText(/http/)).toBeNull()
  })

  it('when off: says who can turn it on and, if configured, where traces would be sent', () => {
    apolloFinto.risposte['GetTraceInfo'] = { traceInfo: { enabled: false, endpoint: 'http://otel-collector:4318', recentTraces: [] } }
    mount()
    const tracing = section('OpenTelemetry Tracing')
    expect(within(tracing).getByText(/Tracing is off: the API process has OTEL_ENABLED set to false/)).toBeInTheDocument()
    expect(within(tracing).getByText('Traces would be sent to: http://otel-collector:4318')).toBeInTheDocument()
    expect(within(tracing).queryByText('Enabled')).toBeNull()
  })

  it('when off without an endpoint, there is no line about where traces would go', () => {
    apolloFinto.risposte['GetTraceInfo'] = { traceInfo: { enabled: false, endpoint: null, recentTraces: [] } }
    mount()
    expect(screen.getByText(/Tracing is off/)).toBeInTheDocument()
    expect(screen.queryByText(/Traces would be sent to/)).toBeNull()
  })
})
