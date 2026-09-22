/**
 * The HTTP front door of the API (server.ts).
 *
 * Every request of every tenant crosses this file before any resolver runs,
 * so a regression here breaks the whole product at once, usually silently:
 *
 * - an auth failure answered 500 instead of 401 (or with the wrong media
 *   type) stops the web from refreshing an expired token and throws users
 *   back to the login page; a database outage answered 401 does the same and
 *   hides the outage from monitoring;
 * - the per-tenant Apollo routing is what makes types created in the
 *   designer reachable: a request served by the wrong (stale or another
 *   tenant's) schema answers "Cannot query field";
 * - the 'system' instance must never be evicted, or GET /graphql turns 500;
 * - CORS wildcards, the JSON body-error contract, the Slack raw body and the
 *   query-string-free request log are all contracts other parts depend on.
 *
 * The server runs for real (express + Apollo on an ephemeral port); only the
 * collaborators that would reach Neo4j, Redis or the network are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ApolloServer } from '@apollo/server'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { GraphQLError, type GraphQLSchema } from 'graphql'

// ── Mocks ───────────────────────────────────────────────────────────────────

const cfg = vi.hoisted(() => ({
  port: 0,
  isProduction: false,
  corsOrigin: 'https://app.example.com, https://*.tenant.example.com' as string | undefined,
  rateLimitWindowMinutes: 1,
  rateLimitMax: 1000,
  graphqlIntrospection: false,
  graphqlSchemaCacheMax: 3,
}))
vi.mock('../lib/config.js', () => ({ config: cfg }))

const log = vi.hoisted(() => {
  const make = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
  return { logger: make(), httpLogger: make(), graphqlLogger: make() }
})
vi.mock('../lib/logger.js', () => ({ ...log, logger: { ...log.logger, child: () => log.logger } }))

const span = vi.hoisted(() => ({
  start: vi.fn(),
  updateName: vi.fn(),
  setAttribute: vi.fn(),
  setError: vi.fn(),
  end: vi.fn(),
  updateActive: vi.fn(),
}))
vi.mock('../telemetry.js', () => ({
  startGraphQLSpan: (name: string) => {
    span.start(name)
    return { updateName: span.updateName, setAttribute: span.setAttribute, setError: span.setError, end: span.end }
  },
  updateActiveSpanName: span.updateActive,
}))

vi.mock('../middleware/metrics.js', () => ({
  metricsMiddlewareWithRpm: (_req: unknown, _res: unknown, next: () => void) => next(),
  metricsHandler: (_req: unknown, res: { status: (n: number) => { send: (b: string) => void } }) => res.status(200).send('metrics-body'),
  graphqlMetricsPlugin: {},
}))
vi.mock('../middleware/graphqlRateLimiter.js', () => ({ graphqlRateLimiterPlugin: {} }))
vi.mock('../graphql/auditMutationsPlugin.js', () => ({ auditMutationsPlugin: () => ({}) }))
vi.mock('../auth/resolveAuth.js', () => ({ TENANT_SUSPENDED: 'TENANT_SUSPENDED' }))

const buildContext = vi.hoisted(() => vi.fn())
vi.mock('../context.js', () => ({ buildContext }))

const schemaCache = vi.hoisted(() => ({ getSchemaForTenant: vi.fn(), getSchemaState: vi.fn() }))
vi.mock('../lib/schemaCache.js', () => schemaCache)

const slack = vi.hoisted(() => ({ commands: vi.fn(), actions: vi.fn(), oauth: vi.fn() }))
vi.mock('../rest/slack.js', () => ({
  handleSlackCommands: slack.commands,
  handleSlackActions: slack.actions,
  handleSlackOAuthCallback: slack.oauth,
}))

// Every REST router is a stub: this file only owns the mounting, not the routes.
vi.mock('../rest/health.js', async () => {
  const { Router } = await import('express')
  const r = Router()
  r.get('/health', (_req, res) => { res.json({ ok: true }) })
  r.post('/api/echo', (req, res) => { res.json({ body: req.body as unknown }) })
  return { healthRouter: r }
})
vi.mock('../rest/webhooks-inbound.js', async () => {
  const { Router } = await import('express')
  const r = Router()
  r.post('/webhooks/inbound', (req, res) => { res.status(202).json({ globalParserRan: req.body !== undefined }) })
  return { webhookInboundRouter: r }
})
vi.mock('../rest/sse.js', async () => {
  const { Router } = await import('express')
  const r = Router()
  r.get('/sse', (_req, res) => { res.json({ sse: true }) })
  return { sseRouter: r }
})
vi.mock('../rest/v1/index.js', async () => ({ v1Router: (await import('express')).Router() }))
vi.mock('../rest/report-stream.js', async () => ({ reportStreamRouter: (await import('express')).Router() }))
vi.mock('../rest/assistant.js', async () => ({ assistantRouter: (await import('express')).Router() }))
vi.mock('../rest/client-logs.js', async () => ({ clientLogRouter: (await import('express')).Router() }))
vi.mock('../rest/platform-tenants.js', async () => ({ platformTenantsRouter: (await import('express')).Router() }))
vi.mock('../rest/platform-server-logs.js', async () => ({ platformServerLogsRouter: (await import('express')).Router() }))
vi.mock('../rest/attachments.js', async () => ({ attachmentRouter: (await import('express')).Router() }))
vi.mock('../rest/brand.js', async () => ({ brandRouter: (await import('express')).Router() }))
vi.mock('../rest/incident-pdf.js', async () => ({ incidentPdfRouter: (await import('express')).Router() }))
vi.mock('../rest/change-pdf.js', async () => ({ changePdfRouter: (await import('express')).Router() }))
vi.mock('../rest/problem-pdf.js', async () => ({ problemPdfRouter: (await import('express')).Router() }))
vi.mock('../rest/reports.js', async () => ({ reportsRouter: (await import('express')).Router() }))

// ── Schemas ─────────────────────────────────────────────────────────────────

class DriverError extends Error { override name = 'Neo4jError' }

function makeSchema(extraField?: string): GraphQLSchema {
  return makeExecutableSchema({
    typeDefs: `
      type Query {
        hello: String
        whoami: String
        logTenant: String
        forbidden: String
        boom: String
        driver: String
        ${extraField ? `${extraField}: String` : ''}
      }
      type Mutation { touch: Boolean }
    `,
    resolvers: {
      Query: {
        hello: () => 'world',
        whoami: (_: unknown, __: unknown, ctx: { tenantId: string }) => ctx.tenantId,
        logTenant: async () => (await import('../lib/logTenantScope.js')).currentLogTenant(),
        forbidden: () => { throw new GraphQLError('Not allowed', { extensions: { code: 'FORBIDDEN' } }) },
        boom: () => { throw new Error('kaboom') },
        driver: () => { throw new DriverError('Expected parameter(s): tenantId') },
        ...(extraField ? { [extraField]: () => 'extra' } : {}),
      },
      Mutation: { touch: () => true },
    },
  })
}

const systemSchema = makeSchema()
const schemas = new Map<string, GraphQLSchema>()
const states = new Map<string, { degraded?: boolean; reason?: string }>()

function schemaOf(tenant: string): GraphQLSchema {
  let s = schemas.get(tenant)
  if (!s) { s = makeSchema(); schemas.set(tenant, s) }
  return s
}

// ── Harness ─────────────────────────────────────────────────────────────────

let base = ''
let httpServer: http.Server

type Mod = typeof import('../server.js')
let mod: Mod

beforeAll(async () => {
  schemaCache.getSchemaForTenant.mockImplementation(async () => systemSchema)
  schemaCache.getSchemaState.mockImplementation(async (tenant: string) => ({ schema: schemaOf(tenant), ...states.get(tenant) }))
  mod = await import('../server.js')
  httpServer = await mod.startServer()
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise((r) => httpServer.close(r)) })

beforeEach(() => {
  vi.clearAllMocks()
  buildContext.mockImplementation(async (req: { headers: Record<string, string | undefined> }) => {
    const tenant = req.headers['x-tenant']
    if (!tenant) throw new GraphQLError('Missing token', { extensions: { code: 'UNAUTHORIZED' } })
    return { tenantId: tenant, userId: 'u1' }
  })
})

async function gql(tenant: string | undefined, query: string, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tenant ? { 'x-tenant': tenant } : {}), ...extra },
    body: JSON.stringify({ query }),
  })
}

// The request log is written on 'finish', which can land just after fetch resolves.
const flush = () => new Promise((r) => setTimeout(r, 20))

// ── Tests ───────────────────────────────────────────────────────────────────

describe('apolloEvictionVictim', () => {
  it('evicts the least recently used tenant, never the current one nor system', () => {
    expect(mod.apolloEvictionVictim(['system', 'a', 'b'], 'b')).toBe('a')
    expect(mod.apolloEvictionVictim(['a', 'system'], 'a')).toBeUndefined()
    expect(mod.SYSTEM_TENANT).toBe('system')
  })
})

describe('per-tenant GraphQL routing', () => {
  it('serves each tenant from its own schema, with the context built once by the route', async () => {
    const res = await gql('t-one', '{ whoami logTenant }')
    expect(res.status).toBe(200)
    // logTenant proves the request ran inside the tenant log scope: without it
    // the Log page of one customer showed every customer's lines.
    expect(await res.json()).toEqual({ data: { whoami: 't-one', logTenant: 't-one' } })
    expect(buildContext).toHaveBeenCalledTimes(1)
    expect(schemaCache.getSchemaState).toHaveBeenCalledWith('t-one')
  })

  it('a field that exists only in one tenant schema is not visible to another tenant', async () => {
    schemas.set('t-custom', makeSchema('customType'))
    const own = await (await gql('t-custom', '{ customType }')).json() as { data?: unknown }
    expect(own.data).toEqual({ customType: 'extra' })
    const other = await (await gql('t-plain', '{ customType }')).json() as { errors?: Array<{ message: string }> }
    expect(other.errors?.[0]?.message).toMatch(/Cannot query field "customType"/)
  })

  it('a metamodel change (new schema object) replaces the tenant instance and stops the old one', async () => {
    await gql('t-swap', '{ hello }')
    const stop = vi.spyOn(ApolloServer.prototype, 'stop')
    schemas.set('t-swap', makeSchema('added'))
    const body = await (await gql('t-swap', '{ added }')).json()
    expect(body).toEqual({ data: { added: 'extra' } })
    expect(stop).toHaveBeenCalledTimes(1)
    stop.mockRestore()
  })

  it('a previous instance that fails to stop is only a warning, the request still succeeds', async () => {
    await gql('t-stopfail', '{ hello }')
    const stop = vi.spyOn(ApolloServer.prototype, 'stop').mockRejectedValueOnce(new Error('stuck'))
    schemas.set('t-stopfail', makeSchema('again'))
    expect(await (await gql('t-stopfail', '{ again }')).json()).toEqual({ data: { again: 'extra' } })
    await flush()
    expect(log.graphqlLogger.warn).toHaveBeenCalledWith({ tenantId: 't-stopfail', err: 'Error: stuck' }, 'Previous Apollo instance did not stop')
    stop.mockRestore()
  })

  it('concurrent first requests share one build; one for a newer schema does not get the old one (A-18)', async () => {
    const realStart = ApolloServer.prototype.start
    const startSpy = vi.spyOn(ApolloServer.prototype, 'start').mockImplementation(async function (this: ApolloServer) {
      await new Promise((r) => setTimeout(r, 60))
      return realStart.call(this)
    })
    const s1 = makeSchema()
    const s2 = makeSchema('fresh')
    schemas.set('t-race', s1)
    const first = gql('t-race', '{ hello }')
    const same = gql('t-race', '{ hello }')
    await new Promise((r) => setTimeout(r, 20))
    schemas.set('t-race', s2)
    const newer = gql('t-race', '{ fresh }')
    const [a, b, c] = await Promise.all([first, same, newer])
    expect(await a.json()).toEqual({ data: { hello: 'world' } })
    expect(await b.json()).toEqual({ data: { hello: 'world' } })
    // Without the schema check the third request would have been bound to s1.
    expect(await c.json()).toEqual({ data: { fresh: 'extra' } })
    // One build for s1 (shared by the first two), one for s2.
    expect(startSpy).toHaveBeenCalledTimes(2)
    startSpy.mockRestore()
  })

  it('evicts the least recently used tenant when the cache is full, never system (A-5)', async () => {
    cfg.graphqlSchemaCacheMax = 2
    try {
      await gql('t-evict-a', '{ hello }')
      await gql('t-evict-b', '{ hello }')
      expect(log.logger.info).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), expect.stringContaining('Apollo'))
      expect(log.logger.info).not.toHaveBeenCalledWith({ tenantId: 'system' }, expect.anything())
      // GET /graphql still reaches the system instance after evictions.
      const get = await fetch(`${base}/graphql?query=${encodeURIComponent('{ hello }')}`, { headers: { 'apollo-require-preflight': 'true', 'x-tenant': 'system' } })
      expect(await get.json()).toEqual({ data: { hello: 'world' } })
      // An evicted tenant is simply rebuilt on its next request.
      expect(await (await gql('t-evict-a', '{ hello }')).json()).toEqual({ data: { hello: 'world' } })
    } finally {
      cfg.graphqlSchemaCacheMax = 3
    }
  })

  it('with a cache of one, nothing evictable means the loop stops instead of spinning', async () => {
    cfg.graphqlSchemaCacheMax = 0
    try {
      expect(await (await gql('t-tiny', '{ hello }')).json()).toEqual({ data: { hello: 'world' } })
    } finally {
      cfg.graphqlSchemaCacheMax = 3
    }
  })

  it('GET /graphql builds the context itself, since no route put one on the request', async () => {
    const res = await fetch(`${base}/graphql?query=${encodeURIComponent('{ whoami }')}`, { headers: { 'apollo-require-preflight': 'true', 'x-tenant': 'from-get' } })
    expect(await res.json()).toEqual({ data: { whoami: 'from-get' } })
    expect(buildContext).toHaveBeenCalledTimes(1)
  })

  it('a degraded schema is announced in a header, with the reason (or a default) encoded', async () => {
    states.set('t-deg', { degraded: true, reason: 'type Foo collides' })
    const res = await gql('t-deg', '{ hello }')
    expect(decodeURIComponent(res.headers.get('x-schema-degraded') ?? '')).toBe('type Foo collides')
    states.set('t-deg2', { degraded: true })
    const res2 = await gql('t-deg2', '{ hello }')
    expect(decodeURIComponent(res2.headers.get('x-schema-degraded') ?? '')).toBe('schema cannot be assembled')
    const plain = await gql('t-one', '{ hello }')
    expect(plain.headers.get('x-schema-degraded')).toBeNull()
  })

  it('a schema lookup failure goes to the error handler (5xx), not to an auth error', async () => {
    schemaCache.getSchemaState.mockRejectedValueOnce(new Error('neo4j down'))
    const res = await gql('t-one', '{ hello }')
    expect(res.status).toBe(500)
  })
})

describe('authentication errors', () => {
  it('UNAUTHORIZED is a 401 with a GraphQL body the web can read to refresh the token', async () => {
    const res = await gql(undefined, '{ hello }')
    expect(res.status).toBe(401)
    // Apollo HttpLink reads the body of a 4xx only with this media type.
    expect(res.headers.get('content-type')).toMatch(/^application\/graphql-response\+json/)
    expect(await res.json()).toEqual({ errors: [{ message: 'Missing token', extensions: { code: 'UNAUTHORIZED' } }] })
  })

  it('FORBIDDEN and TENANT_SUSPENDED are 401 too, keeping their code; a missing message gets a default', async () => {
    buildContext.mockRejectedValueOnce({ extensions: { code: 'FORBIDDEN' } })
    const f = await gql('t', '{ hello }')
    expect(f.status).toBe(401)
    expect(await f.json()).toEqual({ errors: [{ message: 'Unauthorized', extensions: { code: 'FORBIDDEN' } }] })

    buildContext.mockRejectedValueOnce(new GraphQLError('Suspended', { extensions: { code: 'TENANT_SUSPENDED' } }))
    const s = await gql('t', '{ hello }')
    expect(s.status).toBe(401)
    expect((await s.json() as { errors: Array<{ extensions: unknown }> }).errors[0]!.extensions).toEqual({ code: 'TENANT_SUSPENDED' })
    expect(log.graphqlLogger.error).not.toHaveBeenCalled()
  })

  it('any other failure while building the context is a 500 that hides the cause (A-4)', async () => {
    buildContext.mockRejectedValueOnce(new Error('Neo4j connection refused at 10.0.0.3'))
    const res = await gql('t', '{ hello }')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ errors: [{ message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
    expect(body).not.toContain('10.0.0.3')
    expect(log.graphqlLogger.error).toHaveBeenCalledWith({ code: null, message: 'Neo4j connection refused at 10.0.0.3' }, expect.any(String))
  })
})

describe('GraphQL error handling and tracing', () => {
  it('an expected client error is neither logged as error nor marked on the span (A-16)', async () => {
    const body = await (await gql('t-one', 'query Named { forbidden }')).json() as { errors: Array<{ extensions: { code: string } }> }
    expect(body.errors[0]!.extensions.code).toBe('FORBIDDEN')
    expect(log.graphqlLogger.error).not.toHaveBeenCalled()
    expect(span.setError).not.toHaveBeenCalled()
    // The span is renamed once the operation is parsed, and always ended.
    // The client sent no operationName, so the span starts anonymous and gets
    // its real name only once the document is parsed.
    expect(span.start).toHaveBeenCalledWith('GraphQL anonymous')
    expect(span.updateName).toHaveBeenCalledWith('GraphQL Query.Named')
    expect(span.setAttribute).toHaveBeenCalledWith('graphql.operation.type', 'query')
    expect(span.updateActive).toHaveBeenCalledWith('query', 'Named')
    expect(span.end).toHaveBeenCalled()
  })

  it('a product error is logged with its operation and marks the span', async () => {
    await gql('t-one', '{ boom }')
    expect(log.graphqlLogger.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'kaboom' }), 'GraphQL error')
    expect(span.setError).toHaveBeenCalledWith('kaboom')
    expect(span.start).toHaveBeenCalledWith('GraphQL anonymous')
    expect(span.updateName).toHaveBeenCalledWith('GraphQL Query.anonymous')
  })

  it('a mutation span is labelled Mutation', async () => {
    expect(await (await gql('t-one', 'mutation Touch { touch }')).json()).toEqual({ data: { touch: true } })
    expect(span.updateName).toHaveBeenCalledWith('GraphQL Mutation.Touch')
  })

  it('a database driver error never reaches the client verbatim', async () => {
    const body = await (await gql('t-one', '{ driver }')).json() as { errors: Array<{ message: string; extensions: { code: string } }> }
    expect(body.errors[0]!.message).not.toContain('tenantId')
    expect(body.errors[0]!.extensions.code).toBe('INTERNAL_SERVER_ERROR')
    expect(log.graphqlLogger.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('tenantId') }), 'Database driver error masked for the client')
  })

  it('outside production introspection and the Sandbox landing page are available', async () => {
    expect((await (await gql('t-one', '{ __schema { queryType { name } } }')).json() as { data: unknown }).data).toEqual({ __schema: { queryType: { name: 'Query' } } })
    const page = await fetch(`${base}/graphql`, { headers: { accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/<html/i)
  })

  it('the depth limit rejects an over-deep query before it runs', async () => {
    const deep = `{ ${'__schema { types { fields { type { ofType { ofType { ofType { ofType { ofType { ofType { ofType { name } } } } } } } } } } }'} }`
    const body = await (await gql('t-one', deep)).json() as { errors?: unknown[]; data?: unknown }
    expect(body.errors?.length).toBeGreaterThan(0)
    expect(body.data).toBeUndefined()
  })
})

describe('express pipeline', () => {
  it('malformed JSON is a JSON 400, never the default HTML page (A-9)', async () => {
    const res = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_JSON')
    expect(body.error.message).toMatch(/^Request body is not valid JSON: /)
  })

  it('a body over 512 kB is a JSON 413', async () => {
    const res = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(600 * 1024) }) })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } })
  })

  it('a valid JSON body is parsed for ordinary routes', async () => {
    const res = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    expect(await res.json()).toEqual({ body: { a: 1 } })
  })

  it('the inbound webhook is skipped by the global parser (it has its own, with a 2 MB limit)', async () => {
    const res = await fetch(`${base}/api/webhooks/inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ globalParserRan: false })
  })

  it('the request log carries the path without the query string (A-05)', async () => {
    await fetch(`${base}/health?token=secret-value`)
    await flush()
    const entry = log.httpLogger.info.mock.calls.find((c) => (c[0] as { url?: string }).url === '/health')
    expect(entry?.[0]).toMatchObject({ method: 'GET', url: '/health', status: 200 })
    expect(JSON.stringify(log.httpLogger.info.mock.calls)).not.toContain('secret-value')
  })

  it('Slack routes receive the RAW body (signature verification needs the exact bytes)', async () => {
    const seen: unknown[] = []
    const handler = (req: { body: unknown }, res: { status: (n: number) => { end: () => void } }) => { seen.push(req.body); res.status(200).end() }
    slack.commands.mockImplementation(handler)
    slack.actions.mockImplementation(handler)
    slack.oauth.mockImplementation((_req: unknown, res: { status: (n: number) => { end: () => void } }) => res.status(204).end())
    await fetch(`${base}/api/slack/commands`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=hi' })
    await fetch(`${base}/api/slack/actions`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'payload=x' })
    expect(seen.map((b) => Buffer.isBuffer(b) && b.toString())).toEqual(['text=hi', 'payload=x'])
    expect((await fetch(`${base}/api/slack/oauth/callback?code=1`)).status).toBe(204)
  })

  it('/metrics is mounted', async () => {
    expect(await (await fetch(`${base}/metrics`)).text()).toBe('metrics-body')
  })

  it('outside production there is no CSP header (the Sandbox needs inline scripts)', async () => {
    expect((await fetch(`${base}/health`)).headers.get('content-security-policy')).toBeNull()
  })
})

describe('CORS', () => {
  const allowed = async (origin: string) => {
    const res = await fetch(`${base}/health`, { headers: { origin } })
    return { status: res.status, acao: res.headers.get('access-control-allow-origin') }
  }

  it('allows exact origins, one-label wildcards and any localhost', async () => {
    expect(await allowed('https://app.example.com')).toEqual({ status: 200, acao: 'https://app.example.com' })
    expect(await allowed('https://acme.tenant.example.com')).toEqual({ status: 200, acao: 'https://acme.tenant.example.com' })
    expect(await allowed('http://portal.c-one.localhost:5174')).toEqual({ status: 200, acao: 'http://portal.c-one.localhost:5174' })
    expect((await fetch(`${base}/health`)).status).toBe(200)
  })

  it('rejects other origins, including a wildcard spanning two labels', async () => {
    // A CORS rejection is not a body error: it falls through to express's error handler.
    expect((await allowed('https://a.b.tenant.example.com')).status).toBe(500)
    expect((await allowed('https://evil.example.org')).status).toBe(500)
    expect((await allowed('https://tenant.example.com.evil.org')).status).toBe(500)
  })
})

describe('module-level configuration', () => {
  it('refuses to load in production without CORS_ORIGIN', async () => {
    vi.resetModules()
    Object.assign(cfg, { isProduction: true, corsOrigin: undefined })
    try {
      await expect(import('../server.js')).rejects.toThrow('CORS_ORIGIN environment variable is required in production.')
    } finally {
      Object.assign(cfg, { isProduction: false, corsOrigin: 'https://app.example.com, https://*.tenant.example.com' })
    }
  })

  it('without CORS_ORIGIN in development nothing is logged and localhost still works', async () => {
    vi.resetModules()
    cfg.corsOrigin = undefined
    try {
      const dev = await import('../server.js')
      expect(log.logger.info).not.toHaveBeenCalledWith(expect.anything(), 'CORS origins configured')
      const srv = dev.app.listen(0)
      await new Promise((r) => srv.once('listening', r))
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
      expect((await fetch(`${url}/health`, { headers: { origin: 'http://c-one.localhost' } })).status).toBe(200)
      expect((await fetch(`${url}/health`, { headers: { origin: 'https://app.example.com' } })).status).toBe(500)
      await new Promise((r) => srv.close(r))
    } finally {
      cfg.corsOrigin = 'https://app.example.com, https://*.tenant.example.com'
    }
  })

  describe('in production', () => {
    let prodServer: http.Server
    let prodBase = ''
    let corsLog: unknown[] | undefined

    beforeAll(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      Object.assign(cfg, { isProduction: true, rateLimitMax: 3 })
      const prod = await import('../server.js')
      // Logged at import time: keep it before beforeEach clears the mocks.
      corsLog = log.logger.info.mock.calls.find((c) => c[1] === 'CORS origins configured')
      prodServer = await prod.startServer()
      prodBase = `http://127.0.0.1:${(prodServer.address() as AddressInfo).port}`
    })
    afterAll(async () => {
      Object.assign(cfg, { isProduction: false, rateLimitMax: 1000 })
      await new Promise((r) => prodServer.close(r))
    })

    it('logs the configured CORS origins by kind', () => {
      // Two entries in CORS_ORIGIN: one exact, one wildcard (A-11: the wildcard used to be dropped silently).
      expect(corsLog?.[0]).toEqual({ exact: 1, wildcards: 1 })
    })

    it('sends a CSP, disables introspection and the landing page', async () => {
      buildContext.mockResolvedValue({ tenantId: 'p1' })
      const res = await fetch(`${prodBase}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.1' }, body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }) })
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
      const body = await res.json() as { errors?: Array<{ message: string }> }
      expect(body.errors?.[0]?.message).toMatch(/introspection/i)
      const page = await fetch(`${prodBase}/graphql`, { headers: { accept: 'text/html', 'x-forwarded-for': '10.9.9.2' } })
      expect(await page.text()).not.toMatch(/<html/i)
    })

    it('applies RATE_LIMIT_MAX per client, but never to the SSE stream', async () => {
      const hit = (path: string) => fetch(`${prodBase}${path}`, { headers: { 'x-forwarded-for': '10.1.1.1' } })
      const statuses = [] as number[]
      for (let i = 0; i < 4; i++) statuses.push((await hit('/health')).status)
      expect(statuses).toEqual([200, 200, 200, 429])
      // The SSE stream reconnects often and must not be starved by the limit.
      for (let i = 0; i < 5; i++) expect((await hit('/api/sse')).status).toBe(200)
    })
  })
})
