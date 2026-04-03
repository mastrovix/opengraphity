import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import {
  getRequestMetrics,
  getGraphQLMetrics,
  getNeo4jMetrics,
  getProcessMetrics,
  getQueueMetricsSnapshot,
} from '../../middleware/metrics.js'
import { otelEnabled, otelEndpoint, recentTraces } from '../../telemetry.js'

// ── Health check helpers ──────────────────────────────────────────────────────

async function checkNeo4j(): Promise<{ status: string; latencyMs: number | null; error: string | null }> {
  const start   = Date.now()
  const session = getSession(undefined, 'READ')
  try {
    await session.executeRead((tx) => tx.run('RETURN 1 AS ok'))
    return { status: 'ok', latencyMs: Date.now() - start, error: null }
  } catch (err) {
    return { status: 'error', latencyMs: null, error: String(err) }
  } finally {
    await session.close()
  }
}

async function checkRedis(): Promise<{ status: string; latencyMs: number | null; error: string | null }> {
  const start = Date.now()
  try {
    const { getRedisOptions }   = await import('@opengraphity/events')
    const ioredisModule         = await import('ioredis')
    // ioredis exports the class as both default and named export
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RedisClass = (ioredisModule as any).default ?? ioredisModule
    const opts   = getRedisOptions()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: { connect(): Promise<void>; ping(): Promise<string>; quit(): Promise<string> } = new (RedisClass as any)({ ...opts, lazyConnect: true, connectTimeout: 3000 })
    await client.connect()
    await client.ping()
    await client.quit()
    return { status: 'ok', latencyMs: Date.now() - start, error: null }
  } catch (err) {
    return { status: 'error', latencyMs: null, error: String(err) }
  }
}

async function checkKeycloak(): Promise<{ status: string; latencyMs: number | null; error: string | null }> {
  const kcUrl = process.env['KEYCLOAK_URL'] ?? 'http://localhost:8080'
  const start  = Date.now()
  try {
    const res = await fetch(`${kcUrl}/health/ready`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      return { status: 'ok', latencyMs: Date.now() - start, error: null }
    }
    return { status: 'degraded', latencyMs: Date.now() - start, error: `HTTP ${res.status}` }
  } catch (err) {
    return { status: 'error', latencyMs: null, error: String(err) }
  }
}

// ── Resolvers ─────────────────────────────────────────────────────────────────

function requireAdmin(ctx: GraphQLContext): void {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Forbidden — admin role required', {
      extensions: { code: 'FORBIDDEN' },
    })
  }
}

export const monitoringResolvers = {
  Query: {
    systemHealth: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx)

      const [neo4j, redis, keycloak] = await Promise.all([
        checkNeo4j(),
        checkRedis(),
        checkKeycloak(),
      ])

      const allOk = neo4j.status === 'ok' && redis.status === 'ok' && keycloak.status === 'ok'

      return {
        status: allOk ? 'ok' : 'degraded',
        uptime: Math.floor(process.uptime()),
        checks: { neo4j, redis, keycloak },
      }
    },

    systemMetrics: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx)

      const requests = getRequestMetrics()
      const graphql  = getGraphQLMetrics()
      const neo4j    = getNeo4jMetrics()
      const system   = getProcessMetrics()
      const queues   = getQueueMetricsSnapshot()

      return { requests, graphql, neo4j, system, queues }
    },

    traceInfo: (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireAdmin(ctx)

      return {
        enabled:      otelEnabled,
        endpoint:     otelEndpoint ?? null,
        recentTraces: [...recentTraces],
      }
    },
  },
}
