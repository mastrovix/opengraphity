import type { Request, Response, NextFunction } from 'express'
import type { Queue } from 'bullmq'
import type { ApolloServerPlugin } from '@apollo/server'
import type { GraphQLContext } from '../context.js'
import { logger } from '../lib/logger.js'

// ── Types ─────────────────────────────────────────────────────────────────────

type Labels = Record<string, string>

interface Counter {
  inc(labels: Labels, value?: number): void
  collect(): string
}

interface Histogram {
  observe(labels: Labels, value: number): void
  collect(): string
}

interface Gauge {
  set(labels: Labels, value: number): void
  collect(): string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
}

function labelStr(labels: Labels): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
  return parts.length > 0 ? `{${parts.join(',')}}` : ''
}

function now(): number {
  return Date.now()
}

// ── Counter ───────────────────────────────────────────────────────────────────

export function createCounter(name: string, help: string, _labelNames: string[]): Counter {
  const counts = new Map<string, number>()
  const labelsMap = new Map<string, Labels>()

  return {
    inc(labels: Labels, value = 1): void {
      const key = labelKey(labels)
      counts.set(key, (counts.get(key) ?? 0) + value)
      labelsMap.set(key, labels)
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} counter`,
      ]
      for (const [key, count] of counts) {
        const labels = labelsMap.get(key) ?? {}
        lines.push(`${name}${labelStr(labels)} ${count} ${now()}`)
      }
      return lines.join('\n')
    },
  }
}

// ── Histogram ─────────────────────────────────────────────────────────────────

export function createHistogram(
  name: string,
  help: string,
  _labelNames: string[],
  buckets: number[],
): Histogram {
  const sortedBuckets = [...buckets].sort((a, b) => a - b)

  interface BucketState {
    labels: Labels
    counts: number[]   // parallel to sortedBuckets, then +Inf
    sum:    number
    total:  number
  }

  const states = new Map<string, BucketState>()

  function getOrCreate(labels: Labels): BucketState {
    const key = labelKey(labels)
    if (!states.has(key)) {
      states.set(key, {
        labels,
        counts: new Array<number>(sortedBuckets.length + 1).fill(0),
        sum:    0,
        total:  0,
      })
    }
    return states.get(key)!
  }

  return {
    observe(labels: Labels, value: number): void {
      const state = getOrCreate(labels)
      state.sum += value
      state.total += 1
      for (let i = 0; i < sortedBuckets.length; i++) {
        if (value <= sortedBuckets[i]!) {
          state.counts[i]! += 1
        }
      }
      // +Inf bucket always gets the observation
      state.counts[sortedBuckets.length]! += 1
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} histogram`,
      ]
      for (const state of states.values()) {
        const base = labelStr(state.labels)
        const labelEntries = Object.entries(state.labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}="${v}"`)

        for (let i = 0; i < sortedBuckets.length; i++) {
          const le = sortedBuckets[i]!.toString()
          const bucketLabels = [...labelEntries, `le="${le}"`].join(',')
          lines.push(`${name}_bucket{${bucketLabels}} ${state.counts[i]} ${now()}`)
        }
        const infLabels = [...labelEntries, `le="+Inf"`].join(',')
        lines.push(`${name}_bucket{${infLabels}} ${state.counts[sortedBuckets.length]} ${now()}`)
        lines.push(`${name}_sum${base} ${state.sum} ${now()}`)
        lines.push(`${name}_count${base} ${state.total} ${now()}`)
      }
      return lines.join('\n')
    },
  }
}

// ── Gauge ─────────────────────────────────────────────────────────────────────

export function createGauge(name: string, help: string, _labelNames: string[]): Gauge {
  const values = new Map<string, number>()
  const labelsMap = new Map<string, Labels>()

  return {
    set(labels: Labels, value: number): void {
      const key = labelKey(labels)
      values.set(key, value)
      labelsMap.set(key, labels)
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} gauge`,
      ]
      for (const [key, value] of values) {
        const labels = labelsMap.get(key) ?? {}
        lines.push(`${name}${labelStr(labels)} ${value} ${now()}`)
      }
      return lines.join('\n')
    },
  }
}

// ── Metric instances ──────────────────────────────────────────────────────────

export const httpRequestsTotal = createCounter(
  'http_requests_total',
  'Total HTTP requests',
  ['method', 'route', 'status_code'],
)

export const httpRequestDurationSeconds = createHistogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  ['method', 'route'],
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
)

export const graphqlResolverDurationSeconds = createHistogram(
  'graphql_resolver_duration_seconds',
  'GraphQL resolver execution duration in seconds',
  ['resolver'],
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
)

export const neo4jQueryDurationSeconds = createHistogram(
  'neo4j_query_duration_seconds',
  'Neo4j query execution duration in seconds',
  ['operation'],
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
)

export const bullmqQueueDepth = createGauge(
  'bullmq_queue_depth',
  'BullMQ queue depth by status',
  ['queue'],
)

// ── Route normaliser ──────────────────────────────────────────────────────────

const UUID_RE   = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const OBJECT_ID_RE = /[0-9a-f]{24}/gi
const NUMERIC_RE = /\/\d+/g

function normaliseRoute(path: string): string {
  return path
    .replace(UUID_RE, ':id')
    .replace(OBJECT_ID_RE, ':id')
    .replace(NUMERIC_RE, '/:id')
}

// ── Express middleware ────────────────────────────────────────────────────────

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint()

  res.on('finish', () => {
    const route      = normaliseRoute(req.path)
    const method     = req.method
    const statusCode = String(res.statusCode)
    const durationNs = process.hrtime.bigint() - start
    const durationS  = Number(durationNs) / 1e9

    httpRequestsTotal.inc({ method, route, status_code: statusCode })
    httpRequestDurationSeconds.observe({ method, route }, durationS)
  })

  next()
}

// ── Metrics handler ───────────────────────────────────────────────────────────

export function metricsHandler(_req: Request, res: Response): void {
  const metrics = [
    httpRequestsTotal.collect(),
    httpRequestDurationSeconds.collect(),
    graphqlResolverDurationSeconds.collect(),
    neo4jQueryDurationSeconds.collect(),
    bullmqQueueDepth.collect(),
  ].join('\n\n')

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(metrics)
}

// ── Apollo Server plugin ──────────────────────────────────────────────────────

export const graphqlMetricsPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart() {
    return {
      async executionDidStart() {
        return {
          willResolveField({ info }) {
            const start = process.hrtime.bigint()
            return () => {
              const durationNs = process.hrtime.bigint() - start
              const durationS  = Number(durationNs) / 1e9
              const resolver   = `${info.parentType.name}.${info.fieldName}`
              graphqlResolverDurationSeconds.observe({ resolver }, durationS)
            }
          },
        }
      },
    }
  },
}

// ── Structured data interfaces ────────────────────────────────────────────────

export interface RequestMetricsData {
  totalRequests: number
  requestsPerMinute: number
  averageResponseMs: number
  p95ResponseMs: number
  errorRate: number
  statusCodes: { code: string; count: number }[]
}

export interface ResolverMetricData {
  name: string
  averageMs: number
  maxMs: number
  count: number
}

export interface ResolverErrorData {
  name: string
  count: number
  lastError: string | null
}

export interface GraphQLMetricsData {
  totalOperations: number
  slowestResolvers: ResolverMetricData[]
  errorsByResolver: ResolverErrorData[]
}

export interface SlowQueryEntry {
  query: string
  durationMs: number
  timestamp: string
}

export interface Neo4jMetricsData {
  totalQueries: number
  averageQueryMs: number
  slowQueries: SlowQueryEntry[]
  connectionPoolActive: number
  connectionPoolIdle: number
}

export interface ProcessMetricsData {
  memoryUsageMb: number
  memoryRssMb: number
  cpuUsagePercent: number
  nodeVersion: string
  uptimeSeconds: number
  pid: number
}

// ── Slow query buffer ─────────────────────────────────────────────────────────

const slowQueryBuffer: SlowQueryEntry[] = []
const MAX_SLOW_QUERIES = 20

export function recordSlowQuery(query: string, durationMs: number): void {
  slowQueryBuffer.push({
    query: query.slice(0, 200),
    durationMs,
    timestamp: new Date().toISOString(),
  })
  if (slowQueryBuffer.length > MAX_SLOW_QUERIES) slowQueryBuffer.shift()
}

// ── Resolver error tracking ───────────────────────────────────────────────────

const resolverErrors = new Map<string, { count: number; lastError: string }>()

export function recordResolverError(resolverName: string, error: string): void {
  const existing = resolverErrors.get(resolverName)
  if (existing) {
    existing.count += 1
    existing.lastError = error
  } else {
    resolverErrors.set(resolverName, { count: 1, lastError: error })
  }
}

// ── Rolling requests-per-minute window ───────────────────────────────────────

const rpmWindow: number[] = []  // timestamps in ms
const RPM_WINDOW_MS = 60_000

function recordRequest(): void {
  const now = Date.now()
  rpmWindow.push(now)
  // prune stale entries
  const cutoff = now - RPM_WINDOW_MS
  while (rpmWindow.length > 0 && rpmWindow[0]! < cutoff) rpmWindow.shift()
}

// ── Structured getters ────────────────────────────────────────────────────────

export function getRequestMetrics(): RequestMetricsData {
  // Compute totals from httpRequestsTotal
  const metricsText = httpRequestsTotal.collect()
  const lines = metricsText.split('\n').filter(l => !l.startsWith('#') && l.trim())

  let totalRequests = 0
  let errorRequests = 0
  const statusCodeMap = new Map<string, number>()

  for (const line of lines) {
    const match = /status_code="(\d+)"[^}]*}\s+([\d.]+)/.exec(line)
    if (match) {
      const code  = match[1]!
      const count = parseInt(match[2]!, 10)
      totalRequests += count
      statusCodeMap.set(code, (statusCodeMap.get(code) ?? 0) + count)
      if (code.startsWith('5')) errorRequests += count
    }
  }

  // Response time from histogram
  const histText = httpRequestDurationSeconds.collect()
  const histLines = histText.split('\n').filter(l => !l.startsWith('#'))

  let histSum   = 0
  let histCount = 0
  const bucketCounts: { le: number; count: number }[] = []

  for (const line of histLines) {
    const sumMatch   = /_sum\s+([\d.]+)/.exec(line)
    const countMatch = /_count\s+([\d.]+)/.exec(line)
    const bucketMatch = /le="([\d.]+)"[^}]*}\s+([\d.]+)/.exec(line)

    if (sumMatch)   histSum   += parseFloat(sumMatch[1]!)
    if (countMatch) histCount += parseInt(countMatch[1]!, 10)
    if (bucketMatch && bucketMatch[1] !== '+Inf') {
      const le    = parseFloat(bucketMatch[1]!)
      const count = parseInt(bucketMatch[2]!, 10)
      bucketCounts.push({ le, count })
    }
  }

  const averageResponseMs = histCount > 0 ? (histSum / histCount) * 1000 : 0

  // p95 estimate
  let p95ResponseMs = 0
  if (histCount > 0) {
    const p95Target = histCount * 0.95
    const sorted = [...bucketCounts].sort((a, b) => a.le - b.le)
    for (const b of sorted) {
      if (b.count >= p95Target) {
        p95ResponseMs = b.le * 1000
        break
      }
    }
    if (p95ResponseMs === 0 && sorted.length > 0) {
      p95ResponseMs = (sorted[sorted.length - 1]!.le) * 1000
    }
  }

  const statusCodes = Array.from(statusCodeMap.entries()).map(([code, count]) => ({ code, count }))

  return {
    totalRequests,
    requestsPerMinute: rpmWindow.length,
    averageResponseMs,
    p95ResponseMs,
    errorRate: totalRequests > 0 ? errorRequests / totalRequests : 0,
    statusCodes,
  }
}

export function getGraphQLMetrics(): GraphQLMetricsData {
  const text   = graphqlResolverDurationSeconds.collect()
  const lines  = text.split('\n').filter(l => !l.startsWith('#') && l.trim())

  const resolverMap = new Map<string, { sum: number; count: number; max: number }>()

  for (const line of lines) {
    const sumMatch   = /resolver="([^"]+)"[^}]*}_sum\s+([\d.]+)/.exec(line)
    const countMatch = /resolver="([^"]+)"[^}]*}_count\s+([\d.]+)/.exec(line)
    if (sumMatch) {
      const resolver = sumMatch[1]!
      const sum      = parseFloat(sumMatch[2]!)
      const entry    = resolverMap.get(resolver) ?? { sum: 0, count: 0, max: 0 }
      entry.sum += sum
      resolverMap.set(resolver, entry)
    }
    if (countMatch) {
      const resolver = countMatch[1]!
      const count    = parseInt(countMatch[2]!, 10)
      const entry    = resolverMap.get(resolver) ?? { sum: 0, count: 0, max: 0 }
      entry.count += count
      resolverMap.set(resolver, entry)
    }
  }

  const resolverList: ResolverMetricData[] = Array.from(resolverMap.entries()).map(([name, s]) => ({
    name,
    averageMs: s.count > 0 ? (s.sum / s.count) * 1000 : 0,
    maxMs:     s.max * 1000,
    count:     s.count,
  }))

  resolverList.sort((a, b) => b.averageMs - a.averageMs)

  const totalOperations = resolverList.reduce((acc, r) => acc + r.count, 0)

  const errorsByResolver: ResolverErrorData[] = Array.from(resolverErrors.entries()).map(([name, e]) => ({
    name,
    count:     e.count,
    lastError: e.lastError,
  }))

  return {
    totalOperations,
    slowestResolvers: resolverList.slice(0, 10),
    errorsByResolver,
  }
}

export function getNeo4jMetrics(): Neo4jMetricsData {
  const text  = neo4jQueryDurationSeconds.collect()
  const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim())

  let totalSum   = 0
  let totalCount = 0

  for (const line of lines) {
    const sumMatch   = /_sum(?:\{[^}]*\})?\s+([\d.eE+\-]+)/.exec(line)
    const countMatch = /_count(?:\{[^}]*\})?\s+([\d.eE+\-]+)/.exec(line)
    if (sumMatch)   totalSum   += parseFloat(sumMatch[1]!)
    if (countMatch) totalCount += parseInt(countMatch[1]!, 10)
  }

  return {
    totalQueries:        totalCount,
    averageQueryMs:      totalCount > 0 ? (totalSum / totalCount) * 1000 : 0,
    slowQueries:         [...slowQueryBuffer],
    connectionPoolActive: 0,
    connectionPoolIdle:   0,
  }
}

let lastCpuUsage = process.cpuUsage()
let lastCpuTime  = Date.now()

export function getProcessMetrics(): ProcessMetricsData {
  const mem = process.memoryUsage()

  const now     = Date.now()
  const elapsed = now - lastCpuTime
  const cpu     = process.cpuUsage(lastCpuUsage)
  lastCpuUsage  = process.cpuUsage()
  lastCpuTime   = now

  const cpuPercent = elapsed > 0
    ? ((cpu.user + cpu.system) / 1000 / elapsed) * 100
    : 0

  return {
    memoryUsageMb:    mem.heapUsed   / 1024 / 1024,
    memoryRssMb:      mem.rss        / 1024 / 1024,
    cpuUsagePercent:  cpuPercent,
    nodeVersion:      process.version,
    uptimeSeconds:    Math.floor(process.uptime()),
    pid:              process.pid,
  }
}

// ── BullMQ structured data ────────────────────────────────────────────────────

export interface QueueMetricsData {
  name:      string
  waiting:   number
  active:    number
  completed: number
  failed:    number
  delayed:   number
}

// Reads the current snapshot from the gauge data (set by startBullMQMetricsCollector)
export function getQueueMetricsSnapshot(): QueueMetricsData[] {
  const text  = bullmqQueueDepth.collect()
  const lines = text.split('\n').filter(l => !l.startsWith('#') && l.trim())

  const queueMap = new Map<string, QueueMetricsData>()

  for (const line of lines) {
    const m = /queue="([^"]+)",status="([^"]+)"\s+([\d.]+)/.exec(line)
    if (!m) continue
    const name  = m[1]!
    const status = m[2]!
    const value  = m[3]!
    const val = parseInt(value, 10)

    const entry = queueMap.get(name) ?? { name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
    if (status === 'waiting')   entry.waiting   = val
    if (status === 'active')    entry.active     = val
    if (status === 'completed') entry.completed  = val
    if (status === 'failed')    entry.failed     = val
    if (status === 'delayed')   entry.delayed    = val
    queueMap.set(name, entry)
  }

  return Array.from(queueMap.values())
}

// ── Patch metricsMiddleware to record rpm window ───────────────────────────────

const _origMiddleware = metricsMiddleware

export function metricsMiddlewareWithRpm(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  recordRequest()
  _origMiddleware(req, res, next)
}

// ── BullMQ gauge collector ────────────────────────────────────────────────────

export function startBullMQMetricsCollector(queues: Queue[]): NodeJS.Timeout {
  const metricsLogger = logger.child({ module: 'metrics' })

  async function collect(): Promise<void> {
    for (const queue of queues) {
      try {
        const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed', 'paused')
        const name   = queue.name
        bullmqQueueDepth.set({ queue: name, status: 'active' },    counts['active']    ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'waiting' },   counts['waiting']   ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'delayed' },   counts['delayed']   ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'failed' },    counts['failed']    ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'completed' }, counts['completed'] ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'paused' },    counts['paused']    ?? 0)
      } catch (err) {
        metricsLogger.warn({ err, queue: queue.name }, 'Failed to collect BullMQ metrics')
      }
    }
  }

  void collect()
  return setInterval(() => void collect(), 30_000)
}
