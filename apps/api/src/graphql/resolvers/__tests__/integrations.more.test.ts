/**
 * Integrations resolvers: the paths integrations.test.ts leaves open.
 *
 * Why these behaviours matter:
 *  - every list and every write on webhooks and API keys is scoped by the
 *    tenant of the CONTEXT: a missing `tenant_id` in one MATCH lets an admin
 *    read or delete another customer's integration;
 *  - the "Test" button on an outbound webhook is what an admin uses to decide
 *    whether the receiving system works. It must report a failure (non-2xx,
 *    network error) as a failure, send the configured headers and signature,
 *    and never hang forever;
 *  - an API key expiry typed as a bare date means "until the end of that day
 *    in the ORGANISATION's time zone", so the zone is read exactly then;
 *  - a key written before `rate_limit` became mandatory is shown with the
 *    legacy value (and logged), not with a blank the page cannot render.
 * The SSRF guard itself is tested in integrations.test.ts and in the events
 * package; here it is a stub so the tests do not depend on DNS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const mockSession = {}
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
const assertSafeOutboundUrl = vi.fn()
vi.mock('../../../lib/safeUrl.js', () => ({ assertSafeOutboundUrl: (...a: unknown[]) => assertSafeOutboundUrl(...a) }))
const tenantTimezone = vi.fn()
vi.mock('../../../lib/tenantTimezone.js', () => ({ tenantTimezone: (...a: unknown[]) => tenantTimezone(...a) }))
vi.mock('../../../services/events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({}), setEventPolicy: vi.fn() }))
vi.mock('../../../services/events/sourceCache.js', () => ({ invalidateSourceCache: vi.fn() }))
vi.mock('../../../lib/logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const { integrationsResolvers, validateConnectorKind } = await import('../integrations.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { logger } = await import('../../../lib/logger.js')

const admin: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const Q = integrationsResolvers.Query
const M = integrationsResolvers.Mutation

function lastQuery(): { cypher: string; params: Record<string, unknown> } {
  const call = vi.mocked(runQuery).mock.calls.at(-1)!
  return { cypher: call[1] as string, params: call[2] as Record<string, unknown> }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([] as never)
  assertSafeOutboundUrl.mockResolvedValue(new URL('https://hooks.example.com/'))
  tenantTimezone.mockResolvedValue('Europe/Rome')
})

describe('validateConnectorKind', () => {
  it('a connector kind on a ticket webhook is refused: it would be silently ignored at delivery', () => {
    expect(() => validateConnectorKind('incident', 'grafana')).toThrow(/only allowed for entityType "event"/)
    expect(validateConnectorKind('incident', null)).toBeNull()
    expect(validateConnectorKind('incident', undefined)).toBeNull()
  })

  it('an event webhook without a known connector is refused, naming the allowed ones', () => {
    expect(() => validateConnectorKind('event', undefined)).toThrow(/connectorKind is required.*Got: null/)
    expect(validateConnectorKind('event', 'grafana')).toBe('grafana')
  })
})

describe('outboundWebhooks (list)', () => {
  it('is scoped by tenant, maps the defaults and sorts by name descending by default', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'w1', name: 'a', url: 'https://x' } }] as never)
    const out = await Q.outboundWebhooks(null, {}, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (w:OutboundWebhook {tenant_id: $t})')
    expect(cypher).not.toContain('WHERE')
    expect(cypher).toContain('ORDER BY w.name DESC')
    expect(params).toEqual({ t: 'tenant-1' })
    // Missing properties come back as the documented defaults, never undefined.
    expect(out).toEqual([{
      id: 'w1', name: 'a', url: 'https://x', method: 'POST', headers: null, events: [],
      payloadTemplate: null, enabled: false, lastSentAt: null, lastStatusCode: null,
      sendCount: 0, errorCount: 0, lastError: null, retryOnFailure: true,
    }])
  })

  it('applies the advanced filter as parameters and a whitelisted sort column', async () => {
    const filters = JSON.stringify({ rules: [{ field: 'url', operator: 'contains', value: 'slack', logic: 'AND' }] })
    await Q.outboundWebhooks(null, { filters, sortField: 'sendCount', sortDirection: 'asc' }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('WHERE toLower(w.url) CONTAINS toLower($af_0)')
    expect(cypher).toContain('ORDER BY w.send_count ASC')
    expect(params).toEqual({ t: 'tenant-1', af_0: 'slack' })
  })

  it('an unknown sort field falls back to the default column instead of reaching the query text', async () => {
    await Q.outboundWebhooks(null, { sortField: 'name; DETACH DELETE w' }, admin)
    expect(lastQuery().cypher).toContain('ORDER BY w.name DESC')
    expect(lastQuery().cypher).not.toContain('DETACH')
  })
})

describe('inboundWebhooks (list)', () => {
  it('filters and sorts within the tenant', async () => {
    const filters = JSON.stringify({ rules: [{ field: 'name', operator: 'equals', value: 'grafana', logic: 'AND' }] })
    await Q.inboundWebhooks(null, { filters, sortField: 'receiveCount', sortDirection: 'desc' }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (w:InboundWebhook {tenant_id: $t}) WHERE w.name = $af_0')
    expect(cypher).toContain('ORDER BY w.receive_count DESC')
    expect(params).toEqual({ t: 'tenant-1', af_0: 'grafana' })
  })
})

describe('updateOutboundWebhook / deleteOutboundWebhook', () => {
  it('updates only the fields given, scoped by tenant, without re-checking an unchanged URL', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'w1', name: 'renamed', enabled: false } }] as never)
    const out = await M.updateOutboundWebhook(null, { id: 'w1', input: { name: 'renamed', enabled: false, retryOnFailure: false } }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) SET w.updated_at = $now, w.name = $name, w.enabled = $enabled, w.retry_on_failure = $retryOnFailure')
    expect(cypher).not.toContain('w.url')
    expect(params).toMatchObject({ id: 'w1', t: 'tenant-1', name: 'renamed', enabled: false, retryOnFailure: false })
    expect(assertSafeOutboundUrl).not.toHaveBeenCalled()
    expect(out).toMatchObject({ id: 'w1', name: 'renamed', enabled: false })
  })

  it('a new URL goes through the SSRF guard before it is written', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'w1', url: 'https://hooks.example.com/new' } }] as never)
    await M.updateOutboundWebhook(null, { id: 'w1', input: { url: 'https://hooks.example.com/new' } }, admin)
    expect(assertSafeOutboundUrl).toHaveBeenCalledWith('https://hooks.example.com/new')
    expect(lastQuery().params['url']).toBe('https://hooks.example.com/new')
  })

  it('a null URL is checked as an empty string (and so refused by the guard), not skipped', async () => {
    assertSafeOutboundUrl.mockRejectedValueOnce(new Error('unsafe'))
    await expect(M.updateOutboundWebhook(null, { id: 'w1', input: { url: null } }, admin)).rejects.toThrow('unsafe')
    expect(assertSafeOutboundUrl).toHaveBeenCalledWith('')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a webhook of another tenant is NotFound, not an empty success', async () => {
    const err = await M.updateOutboundWebhook(null, { id: 'other', input: { name: 'x' } }, admin).catch((e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
  })

  it('delete is scoped by tenant', async () => {
    await expect(M.deleteOutboundWebhook(null, { id: 'w1' }, admin)).resolves.toBe(true)
    expect(lastQuery()).toEqual({
      cypher: 'MATCH (w:OutboundWebhook {id: $id, tenant_id: $t}) DETACH DELETE w',
      params: { id: 'w1', t: 'tenant-1' },
    })
  })
})

describe('testOutboundWebhook — the result an admin reads', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => { vi.stubGlobal('fetch', fetchSpy) })
  afterEach(() => { vi.unstubAllGlobals() })

  const stored = (extra: Record<string, unknown> = {}) =>
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'w1', url: 'https://hooks.example.com/h', ...extra } }] as never)

  it('sends the configured method and headers; without a secret there is no signature header', async () => {
    stored({ method: 'PUT', headers: JSON.stringify({ Authorization: 'Bearer abc' }) })
    fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    const [, init] = fetchSpy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; signal: AbortSignal }]
    expect(init.method).toBe('PUT')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer abc' })
    // A timeout is armed: without a signal a black-holed host would hang the request.
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a non-2xx answer is reported as a failure with its status code', async () => {
    stored()
    fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 503 }))
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out).toMatchObject({ success: false, statusCode: 503, error: null })
    expect(typeof out.duration).toBe('number')
  })

  it('a response whose body cannot be read still reports the status', async () => {
    stored()
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 204, body: null, text: () => Promise.reject(new Error('gone')) })
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out).toMatchObject({ success: true, statusCode: 204, responseBody: '' })
  })

  it("a real response's body is shown to the admin: the reason of a refusal is readable", async () => {
    // Until 23 Sep 2026 the body was cancelled before being read, and a real
    // fetch Response then always answered an empty body.
    stored()
    fetchSpy.mockResolvedValueOnce(new Response('{"error":"bad signature"}', { status: 400 }))
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out).toMatchObject({ success: false, statusCode: 400, responseBody: '{"error":"bad signature"}' })
  })

  it('a large body is cut to its first 500 characters and the rest is never downloaded', async () => {
    stored()
    let pulled = 0
    let cancelled = false
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    // An endless body: reading it whole would never finish.
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(chunk) },
      cancel() { cancelled = true },
    })
    fetchSpy.mockResolvedValueOnce(new Response(endless, { status: 200 }))
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out.responseBody).toBe('x'.repeat(500))
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })

  it('a network error is a failure carrying the message, not an exception on the page', async () => {
    stored()
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out).toMatchObject({ success: false, statusCode: null, responseBody: null, error: 'ECONNREFUSED' })
  })

  it('a non-Error rejection is still turned into a readable message', async () => {
    stored()
    fetchSpy.mockRejectedValueOnce('socket hang up')
    const out = await M.testOutboundWebhook(null, { id: 'w1' }, admin)
    expect(out.error).toBe('socket hang up')
  })
})

describe('API keys', () => {
  it('a key written before rate_limit was mandatory is shown with the legacy value, and logged', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { props: { id: 'k-old', name: 'old', key_prefix: 'og_live_1' } },
      { props: { id: 'k-new', name: 'new', key_prefix: 'og_live_2', rate_limit: 250 } },
    ] as never)
    const out = await Q.apiKeys(null, { sortField: 'requestCount', sortDirection: 'asc' }, admin)
    expect(out.map((k) => k.rateLimit)).toEqual([60, 250])
    expect(lastQuery().cypher).toContain('ORDER BY k.request_count ASC')
    expect(vi.mocked(logger.warn)).toHaveBeenCalledOnce()
  })

  it('a bare-date expiry on create ends at midnight of the next day in the ORGANISATION zone', async () => {
    const out = await M.createApiKey(null, { input: { name: 'bot', permissions: [], rateLimit: 60, expiresAt: '2099-01-10' } }, admin)
    expect(tenantTimezone).toHaveBeenCalledWith('tenant-1')
    // Rome is UTC+1 in January: the end of 10 Jan local is 23:00 UTC.
    expect(lastQuery().params['expiresAt']).toBe('2099-01-10T23:00:00.000Z')
    expect(out.name).toBe('bot')
  })

  it('a full instant needs no time zone, so none is read', async () => {
    await M.createApiKey(null, { input: { name: 'bot', permissions: [], rateLimit: 60, expiresAt: '2099-01-10T08:00:00Z' } }, admin)
    expect(tenantTimezone).not.toHaveBeenCalled()
    expect(lastQuery().params['expiresAt']).toBe('2099-01-10T08:00:00.000Z')
  })

  it('updateApiKey writes a validated rate limit and a normalised expiry, scoped by tenant', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'k-1', name: 'bot', rate_limit: 500, expires_at: '2099-01-10T23:00:00.000Z' } }] as never)
    const out = await M.updateApiKey(null, { id: 'k-1', input: { rateLimit: 500, expiresAt: '2099-01-10', enabled: true } }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET k.updated_at = $now')
    expect(cypher).toContain('k.rate_limit = $rateLimit')
    expect(cypher).toContain('k.expires_at = $expiresAt')
    expect(params).toMatchObject({ id: 'k-1', t: 'tenant-1', rateLimit: 500, expiresAt: '2099-01-10T23:00:00.000Z', enabled: true })
    expect(out).toMatchObject({ id: 'k-1', rateLimit: 500 })
  })

  it('updateApiKey with expiresAt null REMOVES the expiry (a choice, not an absent field)', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'k-1', rate_limit: 60 } }] as never)
    await M.updateApiKey(null, { id: 'k-1', input: { expiresAt: null } }, admin)
    expect(lastQuery().cypher).toContain('k.expires_at = $expiresAt')
    expect(lastQuery().params['expiresAt']).toBeNull()
    expect(tenantTimezone).not.toHaveBeenCalled()
  })

  it('updateApiKey refuses an out-of-range rate limit before touching the database', async () => {
    await expect(M.updateApiKey(null, { id: 'k-1', input: { rateLimit: 0 } }, admin)).rejects.toThrow(/rateLimit must be a whole number/)
    expect(runQuery).not.toHaveBeenCalled()
  })
})
