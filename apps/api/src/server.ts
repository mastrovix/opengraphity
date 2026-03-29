import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import type { GraphQLRequestContextDidEncounterErrors } from '@apollo/server'
import { buildContext, type GraphQLContext } from './context.js'
import { getSchemaForTenant } from './lib/schemaCache.js'
import { healthRouter } from './rest/health.js'
import { sseRouter } from './rest/sse.js'
import { reportStreamRouter } from './rest/report-stream.js'
import { clientLogRouter } from './rest/client-logs.js'
import { handleSlackCommands, handleSlackActions } from './rest/slack.js'
import { logger, httpLogger, graphqlLogger } from './lib/logger.js'
import http from 'http'

const PORT = parseInt(process.env['PORT'] ?? '4000', 10)

// ── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express()

app.use(helmet({
  contentSecurityPolicy: process.env['NODE_ENV'] === 'production',
}))

app.use(cors({
  origin:      process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
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

// ── REST routes ───────────────────────────────────────────────────────────────

app.use('/',    healthRouter)
app.use('/api', sseRouter)
app.use('/api', reportStreamRouter)
app.use('/api', clientLogRouter)

// ── startServer ───────────────────────────────────────────────────────────────

export async function startServer(): Promise<http.Server> {
  // Build schema from metamodel at startup (cached with TTL)
  const schema = await getSchemaForTenant('system')

  const apolloServer = new ApolloServer<GraphQLContext>({
    schema,
    introspection: true,
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
      {
        async requestDidStart() {
          return {
            async didEncounterErrors(ctx: GraphQLRequestContextDidEncounterErrors<GraphQLContext>) {
              ctx.errors.forEach((err) => {
                const e = err as { extensions?: { code?: string }; message?: string; path?: unknown }
                if (e.extensions?.['code'] !== 'UNAUTHORIZED') {
                  graphqlLogger.error({
                    operation:     ctx.operation?.operation,
                    message:       e.message,
                    path:          e.path,
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
