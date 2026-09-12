import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { rateLimit } from 'express-rate-limit'
import { config } from './lib/config.js'
import { ApolloServer } from '@apollo/server'
import type { GraphQLSchema } from 'graphql'
import { ApolloServerPluginLandingPageLocalDefault, ApolloServerPluginLandingPageProductionDefault } from '@apollo/server/plugin/landingPage/default'
import { expressMiddleware } from '@apollo/server/express4'
import type { GraphQLRequestContextDidEncounterErrors } from '@apollo/server'
import type { ValidationRule } from 'graphql'
import { GraphQLError } from 'graphql'
import { buildContext, type GraphQLContext } from './context.js'
import { getSchemaForTenant, getSchemaState } from './lib/schemaCache.js'
import { healthRouter } from './rest/health.js'
import { sseRouter } from './rest/sse.js'
import { reportStreamRouter } from './rest/report-stream.js'
import { assistantRouter } from './rest/assistant.js'
import { clientLogRouter } from './rest/client-logs.js'
import { handleSlackCommands, handleSlackActions } from './rest/slack.js'
import { attachmentRouter } from './rest/attachments.js'
import { incidentPdfRouter } from './rest/incident-pdf.js'
import { changePdfRouter } from './rest/change-pdf.js'
import { problemPdfRouter } from './rest/problem-pdf.js'
import { reportsRouter } from './rest/reports.js'
import { webhookInboundRouter } from './rest/webhooks-inbound.js'
import { v1Router } from './rest/v1/index.js'
import { logger, httpLogger, graphqlLogger } from './lib/logger.js'
import { graphqlRateLimiterPlugin } from './middleware/graphqlRateLimiter.js'
import { metricsMiddlewareWithRpm, metricsHandler, graphqlMetricsPlugin } from './middleware/metrics.js'
import { startGraphQLSpan, updateActiveSpanName, type GraphQLSpanHandle } from './telemetry.js'
import http from 'http'

const PORT = config.port

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

// Total field count across the whole operation (aliases included). Depth alone
// does not stop breadth amplification — the same expensive field aliased N
// times stays shallow but multiplies the work. This caps that.
function countFields(node: FieldLikeNode): number {
  if (!node.selectionSet) return 0
  let total = 0
  for (const sel of node.selectionSet.selections) {
    total += 1 + countFields(sel as FieldLikeNode)
  }
  return total
}

function fieldCountLimit(maxFields: number): ValidationRule {
  return (context) => ({
    Document(node) {
      for (const def of node.definitions) {
        if (def.kind === 'OperationDefinition') {
          const count = countFields(def as unknown as FieldLikeNode)
          if (count > maxFields) {
            context.reportError(
              new GraphQLError(
                `Query selects ${count} fields, exceeding the maximum of ${maxFields}`,
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
  contentSecurityPolicy: config.isProduction,
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
// /metrics is guarded inside metricsHandler: bearer METRICS_TOKEN when set,
// otherwise loopback/private networks only (A-15).

app.use(metricsMiddlewareWithRpm)
app.get('/metrics', metricsHandler)

/**
 * Build a cors origin function.
 *
 * In development (no CORS_ORIGIN set) any *.localhost origin is allowed so
 * that subdomain routing (c-one.localhost, portal.c-one.localhost, …) works
 * without configuration.
 *
 * In production CORS_ORIGIN must be set to a comma-separated list of allowed
 * origins (exact matches).
 */
// Matches any localhost origin regardless of subdomain depth or port.
// e.g. http://localhost, http://c-one.localhost, http://portal.c-one.localhost:5174
const LOCALHOST_ORIGIN_RE = /^https?:\/\/([a-z0-9-]+\.)*localhost(:\d+)?$/

/**
 * Build a cors origin function.
 *
 * Always allows any *.localhost origin (safe for local dev/Docker).
 * In production, set CORS_ORIGIN to a comma-separated list of allowed origins
 * for non-localhost traffic.
 */
function buildCorsOrigin(
  envOrigin: string | undefined,
): (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void {
  const explicit = envOrigin
    ? new Set(
        envOrigin.split(',')
          .map((s) => s.trim())
          .filter((s) => s && !s.includes('*')),  // skip wildcard placeholders
      )
    : new Set<string>()

  return (origin, callback) => {
    if (!origin || LOCALHOST_ORIGIN_RE.test(origin) || explicit.has(origin)) {
      callback(null, true)
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`))
    }
  }
}

if (!config.corsOrigin && config.isProduction) {
  throw new Error('CORS_ORIGIN environment variable is required in production.')
}

app.use(cors({
  origin:      buildCorsOrigin(config.corsOrigin),
  credentials: true,
}))

// Il webhook in ingresso (/api/webhooks/inbound) monta il PROPRIO parser JSON
// sulla route (rest/webhooks-inbound.ts, WEBHOOK_BODY_LIMIT 2 MB: un batch
// Alertmanager da 500 allarmi supera i 100 KB predefiniti) così JSON malformato
// e corpo troppo grande finiscono nel suo restErrorHandler come risposta JSON.
// In Express 4 un errore nato in un parser a livello app salterebbe i router
// (arità 3) e finirebbe nel gestore predefinito in HTML: per questo il parser
// globale NON si applica a quel percorso.
const WEBHOOK_INBOUND_PATH = '/api/webhooks/inbound'
// 512 kB: payloadKeys / previewInboundEvents accettano campioni fino a PAYLOAD_MAX_CHARS
// (256 kB, resolvers/events.ts) più la query GraphQL che li avvolge.
const jsonBody = express.json({ limit: '512kb' })
app.use((req, res, next) => (req.path.startsWith(WEBHOOK_INBOUND_PATH) ? next() : jsonBody(req, res, next)))

// ── HTTP request logging ───────────────────────────────────────────────────

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now()
  res.on('finish', () => {
    httpLogger.info({
      method:    req.method,
      url:       req.path, // no query string: tokens/ids must not reach logs (A-05)
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
  max:      config.isProduction ? config.rateLimitMax : 1000,
  skip:     (req) => req.path === '/api/sse',
  standardHeaders: true,
  legacyHeaders:   false,
}))

// The per-mutation GraphQL rate limiter is an Apollo plugin (see
// middleware/graphqlRateLimiter.ts): it needs the parsed operation and the
// verified tenant from the context, neither of which exists at Express level.

// ── REST routes ───────────────────────────────────────────────────────────────

app.use('/',    healthRouter)
app.use('/api', webhookInboundRouter)  // Webhook inbound uses own token auth
app.use('/api/v1', v1Router)           // REST API v1 uses API key auth
app.use('/api', sseRouter)
app.use('/api', reportStreamRouter)
app.use('/api', assistantRouter)
app.use('/api', clientLogRouter)
app.use('/api', attachmentRouter)
app.use('/api', incidentPdfRouter)
app.use('/api', changePdfRouter)
app.use('/api', problemPdfRouter)
app.use('/api', reportsRouter)

// ── startServer ───────────────────────────────────────────────────────────────

/**
 * Un'istanza Apollo per uno schema. Ondata 5 (A-1): lo schema non è più uno
 * solo, quindi la costruzione — plugin, regole di validazione, formato degli
 * errori, tracciamento — diventa una fabbrica che si chiama una volta per
 * tenant. Le opzioni sono le stesse di prima, parola per parola.
 */
function buildApolloServer(schema: GraphQLSchema): ApolloServer<GraphQLContext> {
  return new ApolloServer<GraphQLContext>({
    schema,
    // Off in production unless explicitly re-enabled (local compose sets
    // NODE_ENV=production, so the flag keeps Apollo Sandbox usable in dev)
    introspection: config.graphqlIntrospection || !config.isProduction,
    validationRules: [depthLimit(10), fieldCountLimit(2000)],
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
      !config.isProduction
        ? ApolloServerPluginLandingPageLocalDefault({ embed: true })
        : ApolloServerPluginLandingPageProductionDefault(),
      graphqlMetricsPlugin,
      graphqlRateLimiterPlugin,
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
}

/** Istanza Apollo viva per un tenant, legata allo schema con cui è nata. */
interface TenantApollo {
  schema:  GraphQLSchema
  server:  ApolloServer<GraphQLContext>
  handler: express.RequestHandler
}

const apolloByTenant = new Map<string, TenantApollo>()
const apolloInFlight = new Map<string, Promise<TenantApollo>>()

/** Simbolo su cui la rotta lascia il contesto già costruito, per non autenticare due volte. */
const CONTEXT_KEY = Symbol('graphqlContext')

/**
 * L'istanza Apollo del tenant per QUESTO schema. Se lo schema è cambiato (il
 * metamodello è stato modificato e la cache invalidata) l'istanza vecchia
 * viene fermata e sostituita: il confronto è sull'identità dell'oggetto, che
 * `getSchemaForTenant` mantiene stabile finché la voce in cache è valida.
 */
async function apolloFor(tenantId: string, schema: GraphQLSchema): Promise<TenantApollo> {
  const live = apolloByTenant.get(tenantId)
  if (live && live.schema === schema) {
    // Uso recente: riordina per lo sfratto (la prima chiave è la meno usata).
    apolloByTenant.delete(tenantId)
    apolloByTenant.set(tenantId, live)
    return live
  }
  const running = apolloInFlight.get(tenantId)
  if (running) return running

  const start = (async (): Promise<TenantApollo> => {
    const server = buildApolloServer(schema)
    await server.start()
    const handler = expressMiddleware(server, {
      // Il contesto è già stato costruito dalla rotta (serve a scegliere lo
      // schema del tenant): qui si riusa, non si autentica una seconda volta.
      context: async ({ req }) => {
        const holder = req as unknown as Record<symbol, GraphQLContext | undefined>
        return holder[CONTEXT_KEY] ?? buildContext(req)
      },
    })
    const entry: TenantApollo = { schema, server, handler }
    const previous = apolloByTenant.get(tenantId)
    apolloByTenant.set(tenantId, entry)
    if (previous) void previous.server.stop().catch((e: unknown) => graphqlLogger.warn({ tenantId, err: String(e) }, 'Vecchia istanza Apollo non fermata'))
    // Lo stesso limite degli schemi: un'istanza per schema in memoria.
    while (apolloByTenant.size > Math.max(1, config.graphqlSchemaCacheMax)) {
      const oldest = apolloByTenant.keys().next()
      if (oldest.done || oldest.value === tenantId) break
      const victim = apolloByTenant.get(oldest.value)!
      apolloByTenant.delete(oldest.value)
      void victim.server.stop().catch(() => undefined)
      logger.info({ tenantId: oldest.value }, 'Istanza Apollo del tenant fermata (limite di cache raggiunto)')
    }
    return entry
  })().finally(() => apolloInFlight.delete(tenantId))

  apolloInFlight.set(tenantId, start)
  return start
}

/**
 * Errore di autenticazione nella stessa forma di prima: l'autenticazione
 * avveniva dentro il contesto di Apollo, che risponde 500 con il corpo
 * GraphQL. Cambiare quel codice adesso romperebbe il web, quindi si riproduce
 * identico (il 500 su «non autorizzato» è un difetto suo, da correggere a
 * parte e con il web davanti).
 */
function respondAuthError(res: express.Response, err: unknown): void {
  const e = err as { message?: string; extensions?: Record<string, unknown> }
  res.status(500).json({
    errors: [{
      message:    e?.message ?? 'Unauthorized',
      extensions: e?.extensions ?? { code: 'UNAUTHORIZED' },
    }],
  })
}

export async function startServer(): Promise<http.Server> {
  // Lo schema di sistema si costruisce all'avvio: se la parte base non
  // assembla, l'API non deve partire (fail-fast), e serve alle richieste che
  // non hanno un tenant (la pagina di Apollo Sandbox in sviluppo).
  const systemSchema = await getSchemaForTenant('system')
  await apolloFor('system', systemSchema)

  /**
   * Una rotta sola, che sceglie lo schema del tenant: autentica (una volta),
   * prende lo schema di QUEL tenant e passa la richiesta alla sua istanza
   * Apollo. Prima qui c'era un'istanza unica con lo schema di `'system'`:
   * ecco perché i tipi creati dal disegnatore non arrivavano all'API.
   */
  app.use('/graphql', (req, res, next) => {
    // GET = pagina di Apollo Sandbox (in sviluppo) e richieste senza corpo:
    // non hanno un tenant e passano dallo schema di sistema, come prima.
    if (req.method !== 'POST') {
      const system = apolloByTenant.get('system')
      if (!system) { next(new Error('Istanza Apollo di sistema non pronta')); return }
      system.handler(req, res, next); return
    }

    void (async () => {
      let ctx: GraphQLContext
      try {
        ctx = await buildContext(req)
      } catch (err) {
        respondAuthError(res, err)
        return
      }
      try {
        const state = await getSchemaState(ctx.tenantId)
        if (state.degraded) {
          // Chi chiama deve poter sapere che sta parlando con lo schema sicuro
          // (senza i tipi del cliente): è un'informazione operativa, non un
          // dettaglio interno.
          res.setHeader('X-Schema-Degraded', encodeURIComponent((state.reason ?? 'schema non assemblabile').slice(0, 200)))
        }
        const holder = req as unknown as Record<symbol, GraphQLContext>
        holder[CONTEXT_KEY] = ctx
        const { handler } = await apolloFor(ctx.tenantId, state.schema)
        handler(req, res, next)
      } catch (err) {
        next(err)
      }
    })()
  })

  return new Promise((resolve) => {
    const httpServer = http.createServer(app)
    httpServer.listen(PORT, () => {
      logger.info({ port: PORT }, 'OpenGraphity API ready')
      resolve(httpServer)
    })
  })
}
