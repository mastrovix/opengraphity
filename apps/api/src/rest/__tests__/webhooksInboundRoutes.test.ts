/**
 * POST /api/webhooks/inbound/:hookId over a real Express app: Bearer-header-only
 * auth (A-05), disabled hook → 404, rate limit counted AFTER authentication
 * (A-20), fail-loud transform script / mapping / missing-title (no fabricated
 * entities), delegation to incidentService/problemService, typed vs generic errors.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../services/problemService.js', () => ({ createProblem: vi.fn() }))
vi.mock('@opengraphity/scripting', () => ({ runScript: vi.fn() }))
// Redis in memoria: lo script Lua INCR+EXPIRE conta per chiave; il suffisso
// `:<minuto>` viene ignorato così un test a cavallo di due minuti non si azzera.
const rateCounts = new Map<string, number>()
const redis = {
  eval: vi.fn(async (_lua: string, _n: number, key: string) => {
    const k = key.replace(/:\d+$/, '')
    const c = (rateCounts.get(k) ?? 0) + 1
    rateCounts.set(k, c)
    return c
  }),
}
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => redis }))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createIncident } = await import('../../services/incidentService.js')
const { createProblem } = await import('../../services/problemService.js')
const { runScript } = await import('@opengraphity/scripting')
const { logger } = await import('../../lib/logger.js')
const { webhookRateLimitedTotal } = await import('../../middleware/metrics.js')
const { webhookInboundRouter, transformScriptSemaphore, TRANSFORM_SCRIPT_MAX_CONCURRENCY, TRANSFORM_SCRIPT_MAX_WAIT_MS, TRANSFORM_SCRIPT_RETRY_AFTER_SECONDS, WEBHOOK_BODY_LIMIT } = await import('../webhooks-inbound.js')
const { SemaphoreTimeoutError } = await import('../../lib/semaphore.js')

const TOKEN = 'wh-secret-token'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

type HookProps = Record<string, unknown>
function hook(overrides: HookProps = {}): { props: HookProps } {
  return {
    props: {
      id:               'hook-1',
      tenant_id:        'tenant-1',
      secret:           sha(TOKEN),
      entity_type:      'incident',
      field_mapping:    JSON.stringify({ summary: 'title', level: 'severity', body: 'description' }),
      default_values:   JSON.stringify({ severity: 'medium' }),
      transform_script: null,
      ...overrides,
    },
  }
}

let server: Server
let base: string
const session = { close: vi.fn().mockResolvedValue(undefined) }

beforeAll(async () => {
  const app = express()
  // Nessun express.json a livello app: il router monta il proprio parser (2 MB)
  // sulla route, così gli errori del body-parser finiscono nel suo restErrorHandler (B4).
  app.use('/api', webhookInboundRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/inbound`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQuery).mockResolvedValue([])
  vi.mocked(createIncident).mockResolvedValue({ id: 'inc-new', number: 'INC00000007' } as never)
  vi.mocked(createProblem).mockResolvedValue({ id: 'prb-new' } as never)
})

/** Valore corrente del contatore 429 per connector (metrica webhook_rate_limited_total). */
function rateLimited(connector: string): number {
  return webhookRateLimitedTotal.snapshot().find((s) => s.labels['connector'] === connector)?.value ?? 0
}

interface PostOpts { token?: string | null; query?: string; body?: unknown; rawBody?: string }
function post(hookId: string, opts: PostOpts = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? TOKEN}`
  return fetch(`${base}/${hookId}${opts.query ?? ''}`, {
    method: 'POST', headers,
    body: opts.rawBody ?? JSON.stringify(opts.body ?? { summary: 'Disk full', level: 'high', body: 'on db-01' }),
  })
}

type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('authentication', () => {
  beforeEach(() => { vi.mocked(runQueryOne).mockResolvedValue(hook()) })

  it('token only in the query string → 401, nothing created', async () => {
    const res = await post('hook-1', { token: null, query: `?token=${TOKEN}` })
    expect(res.status).toBe(401)
    expect((await err(res)).message).toMatch(/Missing Bearer token/)
    expect(createIncident).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('wrong token → 401 "Invalid token"', async () => {
    const res = await post('hook-1', { token: 'nope' })
    expect(res.status).toBe(401)
    expect((await err(res)).message).toBe('Invalid token')
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('non-Bearer scheme → 401', async () => {
    const res = await fetch(`${base}/hook-1`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${TOKEN}` }, body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('corrupt stored secret (not a sha256 hex) → 401, never a match', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ secret: 'plaintext-legacy' }))
    const res = await post('hook-1')
    expect(res.status).toBe(401)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('disabled / unknown hook → 404; the lookup requires enabled: true', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    const res = await post('hook-off')
    expect(res.status).toBe(404)
    expect((await err(res)).code).toBe('NOT_FOUND')
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toMatch(/InboundWebhook \{id: \$hookId, enabled: true\}/)
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ hookId: 'hook-off' })
    expect(session.close).toHaveBeenCalled()
  })
})

describe('happy path', () => {
  it('valid Bearer token → 201, incidentService.createIncident with mapped fields + webhook ctx, stats updated', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook())
    const res = await post('hook-1')
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'hook-1', entity_type: 'incident', entity_id: 'inc-new' })
    expect(createIncident).toHaveBeenCalledWith(
      { title: 'Disk full', description: 'on db-01', severity: 'high', category: undefined },
      { tenantId: 'tenant-1', userId: 'webhook' },
    )
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SET w\.receive_count/)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ hookId: 'hook-1', tenantId: 'tenant-1' })
    expect(session.close).toHaveBeenCalled()
  })

  it('default_values fill only missing fields (severity from defaults when the payload has none)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook())
    const res = await post('hook-1', { body: { summary: 'No level given' } })
    expect(res.status).toBe(201)
    expect(createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'No level given', severity: 'medium' }),
      { tenantId: 'tenant-1', userId: 'webhook' },
    )
  })

  it('entity_type problem → problemService.createProblem with the priority', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({
      entity_type: 'problem',
      field_mapping: JSON.stringify({ summary: 'title', prio: 'priority' }),
      default_values: '{}',
    }))
    const res = await post('hook-1', { body: { summary: 'Recurring outage', prio: 'P2' } })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ entity_type: 'problem', entity_id: 'prb-new' })
    expect(createProblem).toHaveBeenCalledWith(
      { title: 'Recurring outage', description: undefined, priority: 'P2', category: undefined },
      { tenantId: 'tenant-1', userId: 'webhook' },
    )
    expect(createIncident).not.toHaveBeenCalled()
  })
})

describe('rate limit is applied AFTER authentication (A-20)', () => {
  it('101 requests with a bad token never consume the bucket: the legitimate sender still gets 201', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-a' }))
    for (let i = 0; i < 101; i++) {
      const res = await post('hook-rl-a', { token: 'attacker' })
      expect(res.status).toBe(401)
    }
    const ok = await post('hook-rl-a')
    expect(ok.status).toBe(201)
    expect(createIncident).toHaveBeenCalledTimes(1)
  })

  it('the 101st authenticated request within a minute → 429 with Retry-After (default limit 100 when the source has none) and nothing created', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-b' }))
    for (let i = 0; i < 100; i++) {
      const res = await post('hook-rl-b')
      expect(res.status).toBe(201)
    }
    const before = rateLimited('incident')
    const res = await post('hook-rl-b')
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get('retry-after'))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(await res.json()).toEqual({ error: { code: 'RATE_LIMITED', message: 'Max 100 requests/min per webhook', retry_after: retryAfter } })
    expect(createIncident).toHaveBeenCalledTimes(100)
    expect(rateLimited('incident')).toBe(before + 1)
  })

  it('il bucket è per (tenant, webhook) su Redis con INCR+EXPIRE atomici: chiave og:webhook:rate:<tenant>:<hook>:<minuto>', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-key' }))
    await post('hook-rl-key')
    const [lua, nKeys, key, ttl] = redis.eval.mock.calls.at(-1)!
    expect(lua).toMatch(/INCR.*EXPIRE/s)
    expect(nKeys).toBe(1)
    expect(key).toMatch(/^og:webhook:rate:tenant-1:hook-rl-key:\d+$/)
    expect(ttl).toBe(120)
  })

  it('limite per sorgente (rate_limit_per_minute = 2): la terza → 429 che cita il limite della sorgente, metrica etichettata col connettore', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-c', rate_limit_per_minute: 2, connector_kind: 'zabbix' }))
    expect((await post('hook-rl-c')).status).toBe(201)
    expect((await post('hook-rl-c')).status).toBe(201)
    const before = rateLimited('zabbix')
    const res = await post('hook-rl-c')
    expect(res.status).toBe(429)
    expect((await err(res)).message).toBe('Max 2 requests/min per webhook')
    expect(rateLimited('zabbix')).toBe(before + 1)
    expect(createIncident).toHaveBeenCalledTimes(2)
  })

  it('rate_limit_per_minute corrotto sul webhook → 400 (errore di configurazione, come un field_mapping corrotto)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-bad', rate_limit_per_minute: 0 }))
    const res = await post('hook-rl-bad')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/rate_limit_per_minute must be an integer in 1\.\.10000/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('Redis irraggiungibile → 500 generico, MAI "limite disattivato" (nessuna entità creata)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-rl-d' }))
    redis.eval.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'))
    const res = await post('hook-rl-d')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Processing error' } })
    expect(createIncident).not.toHaveBeenCalled()
  })
})

describe('transform script sotto semaforo (B3)', () => {
  it('costanti: 4 isolate concorrenti, attesa massima 10 s, Retry-After 5 s', () => {
    expect(TRANSFORM_SCRIPT_MAX_CONCURRENCY).toBe(4)
    expect(TRANSFORM_SCRIPT_MAX_WAIT_MS).toBe(10_000)
    expect(TRANSFORM_SCRIPT_RETRY_AFTER_SECONDS).toBe(5)
    expect(transformScriptSemaphore.limit).toBe(4)
  })

  it('5 richieste con script insieme: al massimo 4 runScript in volo, la quinta ATTENDE e poi passa (nessuno scartato)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-sem', transform_script: 'return input' }))
    let inFlight = 0; let maxInFlight = 0
    const gates: Array<() => void> = []
    vi.mocked(runScript).mockImplementation(() => new Promise((resolve) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      gates.push(() => { inFlight--; resolve({ success: true, output: { summary: 'ok', level: 'low' }, logs: [], executionTimeMs: 1 } as never) })
    }))
    const requests = Array.from({ length: 5 }, () => post('hook-sem'))
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(4))
    expect(transformScriptSemaphore.active).toBe(4)
    expect(transformScriptSemaphore.waiting).toBe(1)
    gates.shift()!()
    await vi.waitFor(() => expect(runScript).toHaveBeenCalledTimes(5))
    while (gates.length) gates.shift()!()
    const statuses = (await Promise.all(requests)).map((r) => r.status)
    expect(statuses).toEqual([201, 201, 201, 201, 201])
    expect(maxInFlight).toBe(4)
    expect(transformScriptSemaphore.active).toBe(0)
  })

  it('attesa scaduta → 503 con Retry-After e codice SERVICE_UNAVAILABLE; niente last_error sulla sorgente (non è colpa del payload)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ id: 'hook-sem-busy', transform_script: 'return input' }))
    vi.spyOn(transformScriptSemaphore, 'run').mockRejectedValueOnce(new SemaphoreTimeoutError('webhook-transform-script', TRANSFORM_SCRIPT_MAX_WAIT_MS, TRANSFORM_SCRIPT_RETRY_AFTER_SECONDS))
    const res = await post('hook-sem-busy')
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: expect.stringMatching(/webhook-transform-script.*busy.*10000 ms/), retry_after: 5 } })
    expect(createIncident).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('errori del body-parser gestiti dal router (B4)', () => {
  it('JSON malformato → 400 JSON { error: { code: BAD_REQUEST } }, nessuna query', async () => {
    const res = await fetch(`${base}/hook-1`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{not json' })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringMatching(/JSON|token/i) } })
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('corpo oltre WEBHOOK_BODY_LIMIT (2 MB) → 413 JSON { error: { code: BAD_REQUEST } }', async () => {
    expect(WEBHOOK_BODY_LIMIT).toBe('2mb')
    const res = await fetch(`${base}/hook-1`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: `{"pad":"${'x'.repeat(2 * 1024 * 1024 + 64)}"}` })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringMatching(/too large/i) } })
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('fail-loud payload/config handling', () => {
  beforeEach(() => { vi.mocked(runQueryOne).mockResolvedValue(hook()) })

  it('transform script failure → 400 with the script error, no entity created', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ transform_script: 'throw new Error("boom")' }))
    vi.mocked(runScript).mockResolvedValueOnce({ success: false, error: 'boom', logs: [], executionTimeMs: 1 } as never)
    const res = await post('hook-1')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toBe('Transform script failed: boom')
    expect(runScript).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1', code: 'throw new Error("boom")' }),
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'webhook' }),
    )
    expect(createIncident).not.toHaveBeenCalled()
    // nessuna statistica di ricezione: l'unica scrittura è il motivo del rifiuto sul webhook
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SET w\.last_error = \$message/)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).not.toMatch(/receive_count/)
  })

  it('transform script returning a non-object → 400', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ transform_script: 'return null' }))
    vi.mocked(runScript).mockResolvedValueOnce({ success: true, output: null, logs: [], executionTimeMs: 1 } as never)
    const res = await post('hook-1')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/returned null, expected an object/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('transform script output replaces the payload before mapping', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ transform_script: 'return {...}' }))
    vi.mocked(runScript).mockResolvedValueOnce({ success: true, output: { summary: 'Transformed', level: 'critical' }, logs: [], executionTimeMs: 1 } as never)
    const res = await post('hook-1', { body: { unrelated: true } })
    expect(res.status).toBe(201)
    expect(createIncident).toHaveBeenCalledWith(expect.objectContaining({ title: 'Transformed', severity: 'critical' }), expect.anything())
  })

  it('JSON array body → 400 (must be an object)', async () => {
    const res = await post('hook-1', { body: [{ summary: 'x' }] })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/must be a JSON object/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('mapped payload without a title → 400 (no placeholder entity)', async () => {
    const res = await post('hook-1', { body: { level: 'high' } })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/no title/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('incident without severity (no default) → 400', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ default_values: null }))
    const res = await post('hook-1', { body: { summary: 'x' } })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/no severity/)
  })

  it('corrupt field_mapping JSON → 400 naming the config field', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ field_mapping: '{not json' }))
    const res = await post('hook-1')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Corrupt field_mapping JSON/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('unsupported entity_type → 400', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ entity_type: 'change' }))
    const res = await post('hook-1')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Unsupported entity_type: change/)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('service ValidationError → 400 with the service message', async () => {
    const { ValidationError } = await import('../../lib/errors.js')
    vi.mocked(createIncident).mockRejectedValueOnce(new ValidationError('Un incident deve avere almeno un CI impattato'))
    const res = await post('hook-1')
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/CI impattato/)
    // nessuna statistica di ricezione: l'unica scrittura è il motivo del rifiuto sul webhook
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SET w\.last_error = \$message/)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ hookId: 'hook-1', tenantId: 'tenant-1', message: expect.stringMatching(/CI impattato/) })
  })

  it('unexpected error → 500 with a generic body; details only in the log', async () => {
    vi.mocked(createIncident).mockRejectedValueOnce(new Error('bolt://secret-host refused'))
    const res = await post('hook-1')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Processing error' } })
    expect(logger.child({ module: 'webhook-inbound' }).error).toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })
})
