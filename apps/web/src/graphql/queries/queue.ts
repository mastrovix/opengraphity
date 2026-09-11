import { gql } from '@apollo/client'

// ── Queues & monitoring ──────────────────────────────────────────────────────

// `group` (events | services | itsm | platform) e `retryable` vengono dal
// registro unico delle code dell'API (lib/queueRegistry.ts): la pagina
// raggruppa e mostra il rigioco senza conoscere i nomi delle code.
export const GET_QUEUE_STATS = gql`
  query GetQueueStats {
    queueStats {
      name
      group
      retryable
      counts {
        waiting active completed failed delayed paused
      }
    }
  }
`

export const GET_SYSTEM_HEALTH = gql`
  query GetSystemHealth {
    systemHealth {
      status uptime
      checks {
        neo4j    { status latencyMs error }
        redis    { status latencyMs error }
        keycloak { status latencyMs error }
      }
    }
  }
`

export const GET_SYSTEM_METRICS = gql`
  query GetSystemMetrics {
    systemMetrics {
      requests {
        totalRequests requestsPerMinute averageResponseMs p95ResponseMs errorRate
        statusCodes { code count }
      }
      graphql {
        totalOperations
        slowestResolvers { name averageMs maxMs count }
        errorsByResolver { name count lastError }
      }
      queues { name waiting active completed failed delayed }
      neo4j {
        totalQueries averageQueryMs connectionPoolActive connectionPoolIdle
        slowQueries { query durationMs timestamp }
      }
      system { memoryUsageMb memoryRssMb cpuUsagePercent nodeVersion uptimeSeconds pid }
    }
  }
`

export const GET_TRACE_INFO = gql`
  query GetTraceInfo {
    traceInfo {
      enabled endpoint
      recentTraces { traceId operationName durationMs status timestamp spanCount }
    }
  }
`

export const GET_QUEUE_JOBS = gql`
  query GetQueueJobs($queueName: String!, $status: String, $limit: Int) {
    queueJobs(queueName: $queueName, status: $status, limit: $limit) {
      id name queueName status data
      timestamp processedOn finishedOn
      failedReason stacktrace
      attemptsMade maxAttempts returnValue
    }
  }
`
