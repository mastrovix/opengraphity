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
