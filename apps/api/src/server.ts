import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { typeDefs } from './graphql/schema.js'
import { resolvers } from './graphql/resolvers/index.js'
import { buildContext, type GraphQLContext } from './context.js'
import { healthRouter } from './rest/health.js'
import { sseRouter } from './rest/sse.js'
import { reportStreamRouter } from './rest/report-stream.js'
import { handleSlackCommands, handleSlackActions } from './rest/slack.js'
import { logger, httpLogger, graphqlLogger } from './lib/logger.js'
import http from 'http'

const PORT = parseInt(process.env['PORT'] ?? '4000', 10)

// ── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express()

app.use(helmet({
  // Disable CSP for GraphQL playground in development
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

// ── Slack routes — express.raw() per-route, dopo express.json() ───────────────

app.post('/api/slack/commands',
  express.raw({ type: '*/*' }),
  (req: Request, res: Response) => void handleSlackCommands(req, res),
)
app.post('/api/slack/actions',
  express.raw({ type: '*/*' }),
  (req: Request, res: Response) => void handleSlackActions(req, res),
)

app.use(rateLimit({
  windowMs: 15 * 60 * 1_000, // 15 minutes
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
}))

// ── REST routes ───────────────────────────────────────────────────────────────

app.use('/',    healthRouter)
app.use('/api', sseRouter)
app.use('/api', reportStreamRouter)

// ── Apollo Server ─────────────────────────────────────────────────────────────

const apolloServer = new ApolloServer<GraphQLContext>({
  typeDefs,
  resolvers,
  formatError: (error) => {
    if (error.extensions?.['code'] !== 'UNAUTHORIZED') {
      graphqlLogger.error({
        message: error.message,
        code:    error.extensions?.['code'],
        path:    error.path,
      }, 'GraphQL error')
    }
    return error
  },
})

// ── startServer ───────────────────────────────────────────────────────────────

export async function startServer(): Promise<http.Server> {
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
