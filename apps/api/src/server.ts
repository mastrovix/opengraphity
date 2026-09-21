import express, { type Application, type Request, type Response, type NextFunction } from 'express'
import { auditMutationsPlugin } from './graphql/auditMutationsPlugin.js'
import { runInLogTenantScope } from './lib/logTenantScope.js'
import { runInAuditScope } from './lib/auditScope.js'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import { compressionFilter } from './lib/compressionFilter.js'
import { rateLimit } from 'express-rate-limit'
import { config } from './lib/config.js'
import { ApolloServer } from '@apollo/server'
import type { GraphQLSchema } from 'graphql'
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default'
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled'
/*
 * APOLLO SERVER 5 (21 set 2026).
 *
 * In Apollo 5 l'adattatore per express non sta piu' dentro il pacchetto
 * (`@apollo/server/express4` non esiste): e' un pacchetto a se'. Restando su
 * express 4 e' `@as-integrations/express4` — Apollo 5 NON obbliga a express 5,
 * e le due migrazioni sono indipendenti.
 *
 * Chiude `GHSA-9q82-xgwf-vj6h` (Apollo Server: bypass della prevenzione
 * XS-Search), che era in `audit-allowlist.json` proprio in attesa di questo.
 */
import { expressMiddleware } from '@as-integrations/express4'
import type { GraphQLRequestContextDidEncounterErrors } from '@apollo/server'
import { buildContext, type GraphQLContext } from './context.js'
import { getSchemaForTenant, getSchemaState } from './lib/schemaCache.js'
import { healthRouter } from './rest/health.js'
import { sseRouter } from './rest/sse.js'
import { reportStreamRouter } from './rest/report-stream.js'
import { assistantRouter } from './rest/assistant.js'
import { clientLogRouter } from './rest/client-logs.js'
import { platformTenantsRouter } from './rest/platform-tenants.js'
import { platformServerLogsRouter } from './rest/platform-server-logs.js'
import { handleSlackCommands, handleSlackActions, handleSlackOAuthCallback } from './rest/slack.js'
import { attachmentRouter } from './rest/attachments.js'
import { brandRouter } from './rest/brand.js'
import { incidentPdfRouter } from './rest/incident-pdf.js'
import { changePdfRouter } from './rest/change-pdf.js'
import { problemPdfRouter } from './rest/problem-pdf.js'
import { reportsRouter } from './rest/reports.js'
import { webhookInboundRouter } from './rest/webhooks-inbound.js'
import { v1Router } from './rest/v1/index.js'
import { logger, httpLogger, graphqlLogger } from './lib/logger.js'
import { maskDriverError } from './lib/maskInternalErrors.js'
import { depthLimit, fieldCountLimit } from './lib/queryLimits.js'
import { graphqlRateLimiterPlugin } from './middleware/graphqlRateLimiter.js'
import { metricsMiddlewareWithRpm, metricsHandler, graphqlMetricsPlugin } from './middleware/metrics.js'
import { startGraphQLSpan, updateActiveSpanName, type GraphQLSpanHandle } from './telemetry.js'
import http from 'http'
import { TENANT_SUSPENDED } from './auth/resolveAuth.js'

const PORT = config.port


// ── Express app ──────────────────────────────────────────────────────────────

export const app: Application = express()

app.use(helmet({
  contentSecurityPolicy: config.isProduction,
}))

// ── Compression ────────────────────────────────────────────────────────────────

app.use(compression({
  threshold: 1024,
  level:     6,
  // Mai gli stream SSE: vedi lib/compressionFilter.ts.
  filter:    compressionFilter,
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
  const entries  = (envOrigin ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const explicit = new Set(entries.filter((s) => !s.includes('*')))
  /**
   * `https://*.esempio.com` vale per UNA etichetta (revisione totale · A-11):
   * l'esempio spedito documenta il carattere jolly e questo codice lo
   * SCARTAVA in silenzio, senza errore né log. Con host per tenant la scrittura
   * con il jolly è quella ovvia, e il risultato era un insieme vuoto: avvio
   * riuscito, e ogni richiesta del browser respinta per CORS senza una riga
   * nei log che lo spiegasse.
   */
  const wildcards = entries.filter((s) => s.includes('*')).map((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+')
    return new RegExp(`^${escaped}$`)
  })
  if (entries.length > 0) {
    logger.info({ exact: explicit.size, wildcards: wildcards.length }, 'CORS origins configured')
  }

  return (origin, callback) => {
    if (!origin || LOCALHOST_ORIGIN_RE.test(origin) || explicit.has(origin) || wildcards.some((re) => re.test(origin))) {
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

/**
 * Un errore del PARSER resta JSON (revisione totale · A-9). Il parser è a
 * livello di applicazione, quindi un corpo malformato o troppo grande nasceva
 * prima dei router: in Express 4 quell'errore salta i gestori dei router
 * (arità 3) e finisce nel gestore predefinito, che risponde **HTML**. Un
 * client REST che parsava JSON riceveva `<pre>Unexpected token…</pre>`, e il
 * contratto `{error:{code,message}}` documentato in docs/API.md non valeva
 * proprio per gli errori più probabili di un'integrazione.
 */
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string } | null
  const status = e?.status ?? e?.statusCode
  const isBodyError = e != null && typeof e.type === 'string' && status !== undefined && status < 500
  if (!isBodyError) return next(err)
  const tooLarge = e.type === 'entity.too.large'
  httpLogger.warn({ url: req.path, type: e.type, status }, 'Request body rejected')
  res.status(tooLarge ? 413 : 400).json({
    error: {
      code:    tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON',
      message: tooLarge ? 'Request body is too large' : `Request body is not valid JSON: ${e.message ?? 'parse error'}`,
    },
  })
})

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
app.get('/api/slack/oauth/callback', (req: Request, res: Response) => void handleSlackOAuthCallback(req, res))
app.post('/api/slack/actions',
  express.raw({ type: '*/*' }),
  (req: Request, res: Response) => void handleSlackActions(req, res),
)

app.set('trust proxy', 1)

/**
 * La FINESTRA del limite è configurata, non nascosta nel codice (revisione
 * totale · A-10): la documentazione di `RATE_LIMIT_MAX` diceva «richieste al
 * minuto» e qui la finestra era di quindici minuti, quindi chi scriveva 300
 * credendo «300 al minuto» otteneva 20 al minuto — e un ufficio dietro NAT,
 * che condivide l'IP, li consumava in pochi minuti di uso normale.
 */
app.use(rateLimit({
  windowMs: config.rateLimitWindowMinutes * 60 * 1_000,
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
/*
 * LA CONSOLE DI PIATTAFORMA, fuori da `/api` e con la sua autenticazione
 * (realm dedicato + host della console). Senza `PLATFORM_REALM` e
 * `PLATFORM_CONSOLE_HOST` ogni richiesta qui è rifiutata: la console non
 * esiste dove nessuno l'ha configurata.
 */
app.use(platformTenantsRouter)
// Ondata 3: l'archivio dei log del server, leggibile solo dall'identità di piattaforma.
app.use(platformServerLogsRouter)
app.use('/api', attachmentRouter)
app.use('/api', brandRouter)
app.use('/api', incidentPdfRouter)
app.use('/api', changePdfRouter)
app.use('/api', problemPdfRouter)
app.use('/api', reportsRouter)

// ── startServer ───────────────────────────────────────────────────────────────

/**
 * Gli errori che sono del CLIENTE, non del prodotto (revisione totale · A-16):
 * un permesso che manca, un input non valido, una cosa che non esiste, un
 * limite superato. Vanno nella risposta, non nel registro degli errori: prima
 * ognuno di questi scriveva DUE righe `error` per richiesta.
 */
const EXPECTED_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'UNAUTHORIZED', 'FORBIDDEN', 'BAD_USER_INPUT', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'BAD_REQUEST',
  // Un tenant sospeso è una decisione di chi amministra la piattaforma, non un guasto.
  TENANT_SUSPENDED,
])

function isExpectedClientError(code: unknown): boolean {
  return typeof code === 'string' && EXPECTED_CLIENT_ERROR_CODES.has(code)
}

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
      // Gli errori ATTESI del client non sono errori del prodotto (revisione
      // totale · A-16): un viewer che apre una pagina non permessa scriveva
      // due righe `error` nel log (qui e in `didEncounterErrors`) a ogni
      // richiesta, e gli errori veri ci affogavano. Qui resta una riga sola,
      // al livello giusto.
      if (!isExpectedClientError(formattedError.extensions?.['code'])) {
        graphqlLogger.error({
          message:   formattedError.message,
          code:      formattedError.extensions?.['code'],
          path:      formattedError.path,
          operation: (error as { source?: { body?: string } })?.source?.body?.slice(0, 200),
        }, 'GraphQL error')
      }
      return maskDriverError(formattedError, error, ({ ref, message }) => graphqlLogger.error({ ref, message }, 'Database driver error masked for the client'))
    },
    plugins: [
      /**
       * In produzione NESSUNA landing page (revisione totale · A-17): quella
       * di Apollo carica script inline e da CDN, che la CSP di helmet
       * (`script-src 'self'`) blocca — chi apriva `/graphql` per controllare
       * che l'API rispondesse vedeva una pagina bianca e la console piena di
       * violazioni. Disabilitata, `GET /graphql` risponde con un messaggio
       * chiaro. La Sandbox resta in sviluppo.
       */
      !config.isProduction
        ? ApolloServerPluginLandingPageLocalDefault({ embed: true })
        : ApolloServerPluginLandingPageDisabled(),
      graphqlMetricsPlugin,
      graphqlRateLimiterPlugin,
      // Giro UI del 15 set · U-25: ogni mutation riuscita senza una voce sua va nell'Audit Log.
      auditMutationsPlugin(),
      {
        // ── GraphQL tracing plugin ─────────────────────────────────────────────
        // Creates an explicit OTEL root span per GraphQL operation. This is
        // necessary because Apollo Server + expressMiddleware processes POST
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
              // Tipo e nome SEPARATI: il composto sta nel nome dello span.
              updateActiveSpanName(opType, opName)
            },

            async willSendResponse() {
              handle.end()
            },

            async didEncounterErrors(ctx: GraphQLRequestContextDidEncounterErrors<GraphQLContext>) {
              ctx.errors.forEach((err) => {
                const e = err as { extensions?: { code?: string }; message?: string; path?: unknown }
                // A-16: lo span porta l'errore solo se è del prodotto; per un
                // errore atteso del client resta una riga di debug (già
                // scritta da `formatError`), non un secondo `error`.
                if (!isExpectedClientError(e.extensions?.['code'])) {
                  handle.setError(e.message ?? 'GraphQL error')
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

/** Il tenant «condiviso»: la sua istanza serve la Sandbox su GET /graphql e non si sfratta (A-5). */
export const SYSTEM_TENANT = 'system'

/**
 * Quale istanza Apollo fermare quando la cache supera il limite: la meno usata
 * di recente (le chiavi della Map sono in ordine d'uso), mai quella appena
 * costruita né quella di sistema. `undefined` = non c'è nulla da sfrattare.
 */
export function apolloEvictionVictim(keys: readonly string[], current: string): string | undefined {
  return keys.find((k) => k !== current && k !== SYSTEM_TENANT)
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
  /**
   * Una costruzione in volo si riusa solo se è per lo STESSO schema (revisione
   * totale · A-18): prima si restituiva qualunque costruzione in corso, quindi
   * un'invalidazione del metamodello arrivata nel mezzo lasciava le richieste
   * successive legate allo schema vecchio («Cannot query field» una tantum).
   */
  const running = apolloInFlight.get(tenantId)
  if (running) {
    const entry = await running
    if (entry.schema === schema) return entry
    return apolloFor(tenantId, schema)
  }

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
    if (previous) void previous.server.stop().catch((e: unknown) => graphqlLogger.warn({ tenantId, err: String(e) }, 'Previous Apollo instance did not stop'))
    // Lo stesso limite degli schemi: un'istanza per schema in memoria.
    // L'istanza di `'system'` non si sfratta MAI (revisione totale · A-5): è
    // inserita per prima all'avvio, la rotta GET la legge senza riordinarla e
    // quindi era sempre la prima candidata; sfrattarla rendeva
    // `GET /graphql` un 500 («System Apollo instance not ready») dopo
    // GRAPHQL_SCHEMA_CACHE_MAX tenant serviti. È la stessa protezione che la
    // cache degli schemi ha già (NEVER_EVICTED in lib/schemaCache.ts).
    while (apolloByTenant.size > Math.max(1, config.graphqlSchemaCacheMax)) {
      const oldest = apolloEvictionVictim([...apolloByTenant.keys()], tenantId)
      if (oldest === undefined) break
      const victim = apolloByTenant.get(oldest)!
      apolloByTenant.delete(oldest)
      void victim.server.stop().catch(() => undefined)
      logger.info({ tenantId: oldest }, 'Istanza Apollo del tenant fermata (limite di cache raggiunto)')
    }
    return entry
  })().finally(() => apolloInFlight.delete(tenantId))

  apolloInFlight.set(tenantId, start)
  return start
}

/**
 * Errore di autenticazione: **401**, col corpo GraphQL e il media type
 * `application/graphql-response+json`.
 *
 * Qui c'era un 500, e il commento diceva «da correggere a parte e con il web
 * davanti». Il web davanti ha mostrato che il difetto era più grosso dello
 * stato sbagliato: **il rinfresco del token non funzionava affatto** su HTTP.
 * `HttpLink` di Apollo, per una risposta non-2xx con media type
 * `application/json`, solleva `ServerError` e NON legge il corpo; la catena di
 * link riconosce UNAUTHORIZED solo da `CombinedGraphQLErrors`, quindi un token
 * scaduto finiva nel ramo «errore di rete» — avviso «Errore di connessione al
 * server» e pagina in errore, invece di un rinfresco silenzioso. I test di
 * `web-core` passavano perché iniettavano `CombinedGraphQLErrors` a mano, con
 * un link finto: un'altra asserzione su una forma che il prodotto non produce.
 *
 * `application/graphql-response+json` è il media type che la specifica GraphQL
 * over HTTP riserva alle risposte GraphQL ben formate, e per cui Apollo legge
 * il corpo anche su un 4xx. Con questo la catena vede UNAUTHORIZED, rinfresca
 * e ripete — e lo stato resta quello giusto per tutti gli altri (monitoraggio
 * compreso: un 500 sveglia qualcuno, un 401 no).
 * Pinnato in `packages/web-core/src/__tests__/apollo.test.ts`.
 */
function respondAuthError(res: express.Response, err: unknown): void {
  const e = err as { message?: string; extensions?: Record<string, unknown> }
  /**
   * 401 SOLO quando è davvero un problema di autenticazione (revisione totale
   * · A-4). Prima ogni eccezione di `buildContext` diventava 401: un Neo4j
   * irraggiungibile faceva rispondere «UNAUTHORIZED» a tutte le richieste, il
   * web rinfrescava il token, ritentava e finiva per riportare l'utente alla
   * pagina di accesso — e il monitoraggio contava 401, non 5xx, quindi
   * nessun allarme. `resolveAuth` marca già con INTERNAL_SERVER_ERROR i casi
   * che non sono dell'utente (ruolo non valido, più nodi User).
   */
  const code   = typeof e?.extensions?.['code'] === 'string' ? (e.extensions['code'] as string) : null
  // `TENANT_SUSPENDED` è un accesso negato come gli altri due: 401 col corpo
  // leggibile, perché è dal corpo che il client capisce di non dover riprovare.
  const isAuth = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === TENANT_SUSPENDED
  const status = isAuth ? 401 : 500
  if (!isAuth) {
    graphqlLogger.error({ code, message: e?.message }, 'GraphQL context build failed: answering 500, not 401')
  }
  res.status(status)
    .type('application/graphql-response+json')
    .send(JSON.stringify({
      errors: [{
        // Un guasto del server non racconta al client cosa è andato storto.
        message:    isAuth ? (e?.message ?? 'Unauthorized') : 'Internal server error',
        extensions: isAuth ? (e?.extensions ?? { code: 'UNAUTHORIZED' }) : { code: 'INTERNAL_SERVER_ERROR' },
      }],
    }))
}

export async function startServer(): Promise<http.Server> {
  // Lo schema di sistema si costruisce all'avvio: se la parte base non
  // assembla, l'API non deve partire (fail-fast), e serve alle richieste che
  // non hanno un tenant (la pagina di Apollo Sandbox in sviluppo).
  const systemSchema = await getSchemaForTenant(SYSTEM_TENANT)
  await apolloFor(SYSTEM_TENANT, systemSchema)

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
      const system = apolloByTenant.get(SYSTEM_TENANT)
      if (!system) { next(new Error('System Apollo instance not ready')); return }
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
          res.setHeader('X-Schema-Degraded', encodeURIComponent((state.reason ?? 'schema cannot be assembled').slice(0, 200)))
        }
        const holder = req as unknown as Record<symbol, GraphQLContext>
        holder[CONTEXT_KEY] = ctx
        const { handler } = await apolloFor(ctx.tenantId, state.schema)
        // Il conto delle voci d'Audit Log della richiesta (lib/auditScope.ts):
        // lo legge il registro delle mutation per non scriverne una seconda.
        // Di chi è ogni riga di log scritta da qui in poi (lib/logTenantScope.ts):
        // senza, la pagina Log di un cliente mostrava le righe di tutti.
        runInLogTenantScope(ctx.tenantId, () => runInAuditScope(() => handler(req, res, next)))
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
