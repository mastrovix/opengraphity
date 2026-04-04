import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { rateLimit } from 'express-rate-limit'
import { ApolloServer } from '@apollo/server'
import { ApolloServerPluginLandingPageLocalDefault, ApolloServerPluginLandingPageProductionDefault } from '@apollo/server/plugin/landingPage/default'
import { expressMiddleware } from '@apollo/server/express4'
import type { GraphQLRequestContextDidEncounterErrors } from '@apollo/server'
import type { ValidationRule } from 'graphql'
import { GraphQLError } from 'graphql'
import { buildContext, type GraphQLContext } from './context.js'
import { getSchemaForTenant } from './lib/schemaCache.js'
import { healthRouter } from './rest/health.js'
import { sseRouter } from './rest/sse.js'
import { reportStreamRouter } from './rest/report-stream.js'
import { clientLogRouter } from './rest/client-logs.js'
import { handleSlackCommands, handleSlackActions } from './rest/slack.js'
import { attachmentRouter } from './rest/attachments.js'
import { reportsRouter } from './rest/reports.js'
import { logger, httpLogger, graphqlLogger } from './lib/logger.js'
import { graphqlRateLimiterMiddleware } from './middleware/graphqlRateLimiter.js'
import { metricsMiddlewareWithRpm, metricsHandler, graphqlMetricsPlugin } from './middleware/metrics.js'
import { startGraphQLSpan, updateActiveSpanName, type GraphQLSpanHandle } from './telemetry.js'
import http from 'http'

const PORT = parseInt(process.env['PORT'] ?? '4000', 10)

// ── GraphQL depth limit (inline, no external dependency) ─────────────────────

interface SelectionSetNode { selections: unknown[] }
interface FieldLikeNode { selectionSet?: SelectionSetNode }

function getDepth(node: FieldLikeNode, current: number): number {
  if (!node.selectionSet) return current
  return Math.max(
    ...node.selectionSet.selections.map((sel) =>
      getDepth(sel as FieldLikeNode, current + 1),
    ),
  )
}

function depthLimit(maxDepth: number): ValidationRule {
  return (context) => ({
    Document(node) {
      for (const def of node.definitions) {
        if (def.kind === 'OperationDefinition') {
          const depth = getDepth(def as unknown as FieldLikeNode, 0)
          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}`,
                { nodes: [def] },
              ),
            )
          }
        }
      }
    },
  })
}

// ── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express()

app.use(helmet({
  contentSecurityPolicy: process.env['NODE_ENV'] === 'production',
}))

// ── Compression ────────────────────────────────────────────────────────────────

app.use(compression({
  threshold: 1024,
  level:     6,
  filter:    (req: Request, res: Response) => {
    if (req.path === '/api/sse') return false
    return compression.filter(req, res)
  },
}))

// ── Prometheus metrics ─────────────────────────────────────────────────────────

app.use(metricsMiddlewareWithRpm)
app.get('/metrics', metricsHandler)

const CORS_ORIGIN = (() => {
  if (process.env['CORS_ORIGIN']) return process.env['CORS_ORIGIN']
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('CORS_ORIGIN environment variable is required in production.')
  }
  return 'http://localhost:5173'
})()

app.use(cors({
  origin:      CORS_ORIGIN,
  credentials: true,
}))

app.use(express.json())

// ── HTTP request logging ───────────────────────────────────────────────────

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  res.on('finish', () => {
    httpLogger.info({
      method:    req.method,
      url:       req.url,
      status:    res.statusCode,
      duration:  Date.now() - start,
      userAgent: req.headers['user-agent'],
    }, 'HTTP request')
  })
  next()
})

// ── Slack routes ───────────────────────────────────────────────────────────

app.post('/api/slack/commands',
  express.raw({ type: '*/*' }),
  (req: Request, res: Response) => void handleSlackCommands(req, res),
)
app.post('/api/slack/actions',
  express.raw({ type: '*/*' }),
  (req: Request, res: Response) => void handleSlackActions(req, res),
)

app.set('trust proxy', 1)

app.use(rateLimit({
  windowMs: 15 * 60 * 1_000,
  max:      100,
  skip:     (req) => req.path === '/api/sse',
  standardHeaders: true,
  legacyHeaders:   false,
}))

// ── GraphQL per-mutation rate limiter ─────────────────────────────────────────

app.use(graphqlRateLimiterMiddleware)

// ── REST routes ───────────────────────────────────────────────────────────────

app.use('/',    healthRouter)
app.use('/api', sseRouter)
app.use('/api', reportStreamRouter)
app.use('/api', clientLogRouter)
app.use('/api', attachmentRouter)
app.use('/api', reportsRouter)

// ── startServer ───────────────────────────────────────────────────────────────

export async function startServer(): Promise<http.Server> {
  // Build schema from metamodel at startup (cached with TTL)
  const schema = await getSchemaForTenant('system')

  const apolloServer = new ApolloServer<GraphQLContext>({
    schema,
    introspection: true,
    validationRules: [depthLimit(10)],
    formatError: (formattedError, error) => {
      if (formattedError.extensions?.['code'] !== 'UNAUTHORIZED') {
        graphqlLogger.error({
          message:   formattedError.message,
          code:      formattedError.extensions?.['code'],
          path:      formattedError.path,
          operation: (error as { source?: { body?: string } })?.source?.body?.slice(0, 200),
        }, 'GraphQL error')
      }
      return formattedError
    },
    plugins: [
      process.env['NODE_ENV'] !== 'production'
        ? ApolloServerPluginLandingPageLocalDefault({ embed: true })
        : ApolloServerPluginLandingPageProductionDefault(),
      graphqlMetricsPlugin,
      {
        // ── GraphQL tracing plugin ─────────────────────────────────────────────
        // Creates an explicit OTEL root span per GraphQL operation. This is
        // necessary because Apollo Server 4 + expressMiddleware processes POST
        // bodies in its own pipeline, breaking out of the HTTP auto-instrumentation
        // context — so POST spans never appear in Jaeger without manual creation.
        async requestDidStart(reqCtx) {
          // Start the span with the client-supplied operation name (if any).
          // We refine the name in executionDidStart once the AST is parsed.
          const initialName = reqCtx.request.operationName ?? 'anonymous'
          const handle: GraphQLSpanHandle = startGraphQLSpan(`GraphQL ${initialName}`)

          return {
            async executionDidStart(ctx) {
              // After parsing we have the full operation type and canonical name.
              const opName = ctx.request.operationName ?? ctx.operation?.name?.value ?? 'anonymous'
              const opType: string = ctx.operation?.operation ?? 'query'
              const type   = opType.charAt(0).toUpperCase() + opType.slice(1)
              const label  = `GraphQL ${type}.${opName}`

              handle.updateName(label)
              handle.setAttribute('graphql.operation.name', opName)
              handle.setAttribute('graphql.operation.type', opType)
              handle.setAttribute('graphql.document', (ctx.request.query ?? '').slice(0, 200))

              // Also rename the active HTTP span (auto-instrumentation) as best-effort.
              updateActiveSpanName(`${type}.${opName}`)
            },

            async willSendResponse() {
              handle.end()
            },

            async didEncounterErrors(ctx: GraphQLRequestContextDidEncounterErrors<GraphQLContext>) {
              ctx.errors.forEach((err) => {
                const e = err as { extensions?: { code?: string }; message?: string; path?: unknown }
                if (e.extensions?.['code'] !== 'UNAUTHORIZED') {
                  handle.setError(e.message ?? 'GraphQL error')
                  graphqlLogger.error({
                    operation: ctx.operation?.operation,
                    message:   e.message,
                    path:      e.path,
                  }, 'GraphQL operation error')
                }
              })
            },
          }
        },
      },
    ],
  })

  await apolloServer.start()

  app.use(
    '/graphql',
    expressMiddleware(apolloServer, {
      context: async ({ req }) => buildContext(req),
    }),
  )

  return new Promise((resolve) => {
    const httpServer = http.createServer(app)
    httpServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'OpenGraphity API ready')
      resolve(httpServer)
    })
  })
}
