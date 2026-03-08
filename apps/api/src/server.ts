import express, { type Application } from 'express'
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
import http from 'http'

const PORT = parseInt(process.env['PORT'] ?? '4000', 10)

// ── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express()

app.use(helmet({
  // Disable CSP for GraphQL playground in development
  contentSecurityPolicy: process.env['NODE_ENV'] === 'production',
}))

app.use(cors({
  origin:      process.env['CORS_ORIGIN'] ?? 'http://localhost:3000',
  credentials: true,
}))

app.use(express.json())

app.use(rateLimit({
  windowMs: 15 * 60 * 1_000, // 15 minutes
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
}))

// ── REST routes ───────────────────────────────────────────────────────────────

app.use('/',    healthRouter)
app.use('/api', sseRouter)

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
