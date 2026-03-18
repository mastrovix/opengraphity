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

const apolloServer = new ApolloServer<GraphQLContext>({ typeDefs, resolvers })

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
      console.log(`🚀 OpenGraphity API ready at http://localhost:${PORT}/graphql`)
      console.log(`🏥 Health check: http://localhost:${PORT}/health`)
      console.log(`📡 SSE endpoint: http://localhost:${PORT}/api/sse`)
      resolve(httpServer)
    })
  })
}
