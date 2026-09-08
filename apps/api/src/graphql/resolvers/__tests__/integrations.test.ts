/**
 * integrations.ts — testOutboundWebhook/createOutboundWebhook con URL SSRF →
 * ValidationError senza fetch; createApiKey salva SOLO sha256(key) e restituisce
 * la chiave in chiaro una volta; createInboundWebhook idem col token;
 * operazioni su risorse di altro tenant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { createHash } from 'node:crypto'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('@opengraphity/events', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/events')>()
  const lookup = async (host: string) => {
    if (host === 'hooks.example.com') return [{ address: '3.3.3.3', family: 4 }]
    throw new Error(`getaddrinfo ENOTFOUND ${host}`)
  }
  return {
    ...orig,
    assertSafeOutboundUrl: (url: string, opts?: import('@opengraphity/events').SafeUrlOptions) =>
      orig.assertSafeOutboundUrl(url, { ...opts, lookup }),
  }
})

const { integrationsResolvers } = await import('../integrations.js')
const { runQuery } = await import('@opengraphity/neo4j')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { tenantId: 'tenant-1', userId: 'op-1',    userEmail: 'op@test.io',  role: 'operator' }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function lastQuery(): { cypher: string; params: Record<string, unknown> } {
  const call = vi.mocked(runQuery).mock.calls.at(-1)!
  return { cypher: call[1] as string, params: call[2] as Record<string, unknown> }
}

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

describe('testOutboundWebhook — SSRF di lettura', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1:4000/graphql',
    'https://10.0.0.1/',
    'https://localhost/',
    'file:///etc/passwd',
  ])('webhook salvato con URL %s → ValidationError, fetch MAI chiamata', async (url) => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'wh-1', url, method: 'POST' } }] as never)
    await expectCode(integrationsResolvers.Mutation.testOutboundWebhook(null, { id: 'wh-1' }, admin), 'BAD_USER_INPUT')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('webhook di un altro tenant → NotFound, nessuna fetch (query scoped per tenant)', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expectCode(integrationsResolvers.Mutation.testOutboundWebhook(null, { id: 'wh-altrui' }, admin), 'NOT_FOUND', /Webhook not found/)
    expect(lastQuery().cypher).toContain('MATCH (w:OutboundWebhook {id: $id, tenant_id: $t})')
    expect(lastQuery().params).toEqual({ id: 'wh-altrui', t: 'tenant-1' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('URL pubblico → fetch con firma HMAC del body e tenant_id nel payload', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'wh-1', url: 'https://hooks.example.com/x', method: 'POST', secret: 's3' } }] as never)
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'pong' })

    const out = await integrationsResolvers.Mutation.testOutboundWebhook(null, { id: 'wh-1' }, admin)

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }]
    expect(url).toBe('https://hooks.example.com/x')
    expect(init.method).toBe('POST')
    expect(init.headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(init.body)).toMatchObject({ event_type: 'test', tenant_id: 'tenant-1' })
    expect(out).toMatchObject({ success: true, statusCode: 200, responseBody: 'pong', error: null })
  })
})

describe('createOutboundWebhook / updateOutboundWebhook — guardia SSRF prima di scrivere', () => {
  beforeEach(() => vi.clearAllMocks())

  it('URL privato in creazione → ValidationError, nessuna CREATE', async () => {
    await expectCode(integrationsResolvers.Mutation.createOutboundWebhook(null, { input: { name: 'x', url: 'https://192.168.0.1/h', events: [] } }, admin), 'BAD_USER_INPUT')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('URL privato in update → ValidationError, nessun SET', async () => {
    await expectCode(integrationsResolvers.Mutation.updateOutboundWebhook(null, { id: 'wh-1', input: { url: 'https://[::1]/h' } }, admin), 'BAD_USER_INPUT')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('URL pubblico → CREATE con tenant_id del contesto', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'wh-2', name: 'x', url: 'https://hooks.example.com/h', events: [] } }] as never)
    const out = await integrationsResolvers.Mutation.createOutboundWebhook(null, { input: { name: 'x', url: 'https://hooks.example.com/h', events: ['incident.created'] } }, admin)
    expect(lastQuery().cypher).toContain('CREATE (w:OutboundWebhook {id: $id, tenant_id: $t')
    expect(lastQuery().params).toMatchObject({ t: 'tenant-1', url: 'https://hooks.example.com/h', events: ['incident.created'] })
    expect(out).toMatchObject({ id: 'wh-2', url: 'https://hooks.example.com/h' })
  })
})

describe('createApiKey — solo l\'hash è persistito', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([] as never)
  })

  it('admin → chiave og_live_… restituita in chiaro una volta; nei parametri Cypher c\'è solo sha256 + prefisso', async () => {
    const out = await integrationsResolvers.Mutation.createApiKey(null, { input: { name: 'CI bot', permissions: ['read'], rateLimit: 100 } }, admin)

    expect(out.key).toMatch(/^og_live_[0-9a-f]{64}$/)
    expect(out.keyPrefix).toBe(out.key.slice(0, 16))
    expect(out).toMatchObject({ name: 'CI bot', permissions: ['read'] })

    const { cypher, params } = lastQuery()
    expect(cypher).toContain('CREATE (k:ApiKey {id: $id, tenant_id: $t')
    expect(cypher).toContain('key_hash: $keyHash')
    expect(cypher).not.toMatch(/\bkey:\s*\$/)
    expect(params['keyHash']).toBe(sha256(out.key))
    expect(params['keyPrefix']).toBe(out.key.slice(0, 16))
    expect(params).toMatchObject({ t: 'tenant-1', createdBy: 'admin-1', rateLimit: 100 })
    // la chiave in chiaro non compare in NESSUN parametro (né come valore né dentro stringhe)
    expect(JSON.stringify(params)).not.toContain(out.key)
    expect(JSON.stringify(params)).not.toContain(out.key.slice(16))
  })

  it('due creazioni → chiavi diverse', async () => {
    const a = await integrationsResolvers.Mutation.createApiKey(null, { input: { name: 'a', permissions: [] } }, admin)
    const b = await integrationsResolvers.Mutation.createApiKey(null, { input: { name: 'b', permissions: [] } }, admin)
    expect(a.key).not.toBe(b.key)
  })

  it('operator → ForbiddenError (requireRole locale), nessuna query', async () => {
    await expectCode(integrationsResolvers.Mutation.createApiKey(null, { input: { name: 'x', permissions: [] } }, operator), 'FORBIDDEN')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('regenerateApiKey → nuovo hash + prefisso, chiave in chiaro solo nella risposta', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'k-1', name: 'CI bot', permissions: ['read'] } }] as never)
    const out = await integrationsResolvers.Mutation.regenerateApiKey(null, { id: 'k-1' }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (k:ApiKey {id: $id, tenant_id: $t}) SET k.key_hash = $keyHash')
    expect(params['keyHash']).toBe(sha256(out.key))
    expect(JSON.stringify(params)).not.toContain(out.key)
  })

  it('apiKeys (lista) non espone key_hash', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'k-1', name: 'a', key_hash: 'HASH', key_prefix: 'og_live_abcdefgh', permissions: [] } }] as never)
    const out = await integrationsResolvers.Query.apiKeys(null, {}, admin)
    expect(out[0]).toMatchObject({ id: 'k-1', keyPrefix: 'og_live_abcdefgh' })
    expect(JSON.stringify(out)).not.toContain('HASH')
    expect(lastQuery().cypher).toContain('MATCH (k:ApiKey {tenant_id: $t})')
  })
})

describe('deleteApiKey / updateApiKey su chiavi di altro tenant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(runQuery).mockResolvedValue([] as never)
  })

  it('deleteApiKey: DETACH DELETE scoped per tenant (mai cancella fuori tenant); comportamento REALE: ritorna true anche se nulla è stato cancellato', async () => {
    await expect(integrationsResolvers.Mutation.deleteApiKey(null, { id: 'k-altrui' }, admin)).resolves.toBe(true)
    expect(lastQuery().cypher).toContain('MATCH (k:ApiKey {id: $id, tenant_id: $t}) DETACH DELETE k')
    expect(lastQuery().params).toEqual({ id: 'k-altrui', t: 'tenant-1' })
  })

  it.todo('deleteApiKey di un altro tenant → NotFound — GAP: nessuna verifica di esistenza, ritorna sempre true (integrations.ts:227-231)')

  it('deleteApiKey: operator → Forbidden senza query', async () => {
    await expectCode(integrationsResolvers.Mutation.deleteApiKey(null, { id: 'k-1' }, operator), 'FORBIDDEN')
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('updateApiKey di un altro tenant → NotFound — BUG: `rows[0]!.props` su lista vuota → TypeError generico invece di NotFoundError (integrations.ts:223)', async () => {
    await expectCode(integrationsResolvers.Mutation.updateApiKey(null, { id: 'k-altrui', input: { name: 'x' } }, admin), 'NOT_FOUND')
  })

  it('regenerateApiKey di un altro tenant → NotFound — BUG: `rows[0]!.props` su lista vuota → TypeError (integrations.ts:240)', async () => {
    await expectCode(integrationsResolvers.Mutation.regenerateApiKey(null, { id: 'k-altrui' }, admin), 'NOT_FOUND')
  })
})

describe('createInboundWebhook — token in chiaro una sola volta, hash salvato', () => {
  beforeEach(() => vi.clearAllMocks())

  it('CREATE con secret = sha256(token), tenant_id del contesto; il token non compare nei parametri', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'iw-1', name: 'Zabbix', entity_type: 'incident', secret: 'HASH', field_mapping: '{}', enabled: true, receive_count: 0 } }] as never)

    const out = await integrationsResolvers.Mutation.createInboundWebhook(null, { input: { name: 'Zabbix', entityType: 'incident', fieldMapping: '{}' } }, admin)

    expect(out.token).toMatch(/^[0-9a-f]{64}$/)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('CREATE (w:InboundWebhook {id: $id, tenant_id: $t')
    expect(cypher).toContain('secret: $secret')
    expect(params['secret']).toBe(sha256(out.token))
    expect(params['t']).toBe('tenant-1')
    expect(JSON.stringify(params)).not.toContain(out.token)
    // il mapper non espone il secret (né l'hash)
    expect(out).not.toHaveProperty('secret')
    expect(JSON.stringify({ ...out, token: undefined })).not.toContain('HASH')
  })

  it('regenerateWebhookToken → nuovo token, nuovo hash, scoped per tenant', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'iw-1', name: 'Zabbix', entity_type: 'incident' } }] as never)
    const out = await integrationsResolvers.Mutation.regenerateWebhookToken(null, { id: 'iw-1' }, admin)
    const { cypher, params } = lastQuery()
    expect(cypher).toContain('MATCH (w:InboundWebhook {id: $id, tenant_id: $t}) SET w.secret = $secret')
    expect(params['secret']).toBe(sha256(out.token))
    expect(JSON.stringify(params)).not.toContain(out.token)
  })

  it('regenerateWebhookToken di un altro tenant → NotFound — BUG: `rows[0]!.props` su lista vuota → TypeError (integrations.ts:106)', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expectCode(integrationsResolvers.Mutation.regenerateWebhookToken(null, { id: 'iw-altrui' }, admin), 'NOT_FOUND')
  })
})
