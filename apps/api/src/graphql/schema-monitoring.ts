export function monitoringSDL(): string {
  return `#graphql
    type SystemHealth {
      status:  String!
      uptime:  Int!
      checks:  HealthChecks!
    }
    type HealthChecks {
      neo4j:    ServiceCheck!
      redis:    ServiceCheck!
      keycloak: ServiceCheck!
    }
    type ServiceCheck {
      status:    String!
      latencyMs: Int
      error:     String
    }
    type SystemMetrics {
      requests: RequestMetrics!
      graphql:  GraphQLMetrics!
      queues:   [QueueMetrics!]!
      neo4j:    Neo4jMetrics!
      system:   ProcessMetrics!
    }
    type RequestMetrics {
      totalRequests:      Int!
      requestsPerMinute:  Float!
      averageResponseMs:  Float!
      p95ResponseMs:      Float!
      errorRate:          Float!
      statusCodes:        [StatusCodeCount!]!
    }
    type StatusCodeCount {
      code:  String!
      count: Int!
    }
    type GraphQLMetrics {
      totalOperations:   Int!
      slowestResolvers:  [ResolverMetric!]!
      errorsByResolver:  [ResolverError!]!
    }
    type ResolverMetric {
      name:      String!
      averageMs: Float!
      maxMs:     Float!
      count:     Int!
    }
    type ResolverError {
      name:      String!
      count:     Int!
      lastError: String
    }
    type QueueMetrics {
      name:      String!
      waiting:   Int!
      active:    Int!
      completed: Int!
      failed:    Int!
      delayed:   Int!
    }
    type Neo4jMetrics {
      totalQueries:          Int!
      averageQueryMs:        Float!
      slowQueries:           [SlowQuery!]!
      connectionPoolActive:  Int!
      connectionPoolIdle:    Int!
    }
    type SlowQuery {
      query:      String!
      durationMs: Float!
      timestamp:  String!
    }
    type ProcessMetrics {
      memoryUsageMb:    Float!
      memoryRssMb:      Float!
      cpuUsagePercent:  Float!
      nodeVersion:      String!
      uptimeSeconds:    Int!
      pid:              Int!
    }
    type TraceInfo {
      enabled:      Boolean!
      endpoint:     String
      recentTraces: [RecentTrace!]!
    }
    type RecentTrace {
      traceId:       String!
      operationName: String!
      durationMs:    Float!
      status:        String!
      timestamp:     String!
      spanCount:     Int!
    }
  `
}
