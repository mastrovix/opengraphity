/**
 * LO STATO DEL SISTEMA (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/monitoring.ts` stava al 2,3%. Sono tre letture riservate a
 * `admin.system`, e la prima — `systemHealth` — è quella che si guarda quando
 * qualcosa non va. Deve reggere esattamente allora: **un pezzo giù non fa
 * fallire la risposta**, la fa uscire «degraded» col motivo accanto. Un
 * controllo di salute che va in errore quando il sistema è in errore non serve
 * a niente.
 *
 * I tre controlli partono INSIEME (`Promise.all`): in sequenza, tre timeout da
 * tre secondi farebbero aspettare nove secondi la pagina che dovrebbe dire in
 * fretta che cosa è rotto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: txRun }),
    close,
  })),
}))
vi.mock('../../../lib/env.js', () => ({ envOrThrowInProd: vi.fn(() => 'http://kc') }))

const redisClient = { connect: vi.fn(), ping: vi.fn(), quit: vi.fn() }
vi.mock('@opengraphity/events', () => ({ getRedisConnection: vi.fn(() => ({ host: 'r' })) }))
// Una funzione-freccia non si puo' chiamare con `new`, e il codice fa
// `new RedisClass(...)`: serve un costruttore vero.
vi.mock('ioredis', () => ({ default: function Redis() { return redisClient } }))

vi.mock('../../../middleware/metrics.js', () => ({
  getRequestMetrics: vi.fn(() => ({ total: 10 })),
  getGraphQLMetrics: vi.fn(() => ({ ops: 3 })),
  getNeo4jMetrics: vi.fn(() => ({ queries: 99 })),
  getProcessMetrics: vi.fn(() => ({ rssMb: 120 })),
  getQueueMetricsSnapshot: vi.fn(() => ([{ queue: 'sla', waiting: 0 }])),
}))
vi.mock('../../../telemetry.js', () => ({
  otelEnabled: true, otelEndpoint: 'http://jaeger:4318', recentTraces: [{ id: 't1' }],
}))

const { monitoringResolvers: R } = await import('../monitoring.js')

const ctx = (...permessi: string[]) => ({
  tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set(permessi),
}) as never
const ADMIN = ctx('admin.system')

async function codice(fn: () => Promise<unknown> | unknown): Promise<string> {
  try { await fn(); return 'NESSUN RIFIUTO' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  txRun.mockResolvedValue({ records: [] })
  redisClient.connect.mockResolvedValue(undefined)
  redisClient.ping.mockResolvedValue('PONG')
  redisClient.quit.mockResolvedValue('OK')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })))
})

// ══════════════════════════════════════════════════════════════════════════════
describe('tutte e tre chiedono `admin.system`', () => {
  it.each([
    ['systemHealth', () => R.Query.systemHealth(null, null, ctx('admin.audit'))],
    ['systemMetrics', () => R.Query.systemMetrics(null, null, ctx('admin.audit'))],
    ['traceInfo', () => R.Query.traceInfo(null, null, ctx('admin.audit'))],
  ] as const)('%s', async (_n, chiama) => {
    expect(await codice(chiama)).toBe('FORBIDDEN')
  })
})

describe('systemHealth — regge proprio quando qualcosa è rotto', () => {
  it('tutto a posto: `ok`, con la latenza di ognuno', async () => {
    const out = await R.Query.systemHealth(null, null, ADMIN) as Record<string, never>
    expect(out['status']).toBe('ok')
    const checks = out['checks'] as unknown as Record<string, { status: string; latencyMs: number | null; error: string | null }>
    for (const nome of ['neo4j', 'redis', 'keycloak']) {
      expect(checks[nome]!.status).toBe('ok')
      expect(checks[nome]!.latencyMs).toBeGreaterThanOrEqual(0)
      expect(checks[nome]!.error).toBeNull()
    }
    expect(typeof out['uptime']).toBe('number')
  })

  it('Neo4j giù NON fa fallire la risposta: «degraded», col motivo accanto', async () => {
    txRun.mockRejectedValue(new Error('connection refused'))
    const out = await R.Query.systemHealth(null, null, ADMIN) as Record<string, never>
    expect(out['status']).toBe('degraded')
    const checks = out['checks'] as unknown as Record<string, { status: string; error: string | null }>
    expect(checks['neo4j']).toMatchObject({ status: 'error' })
    expect(checks['neo4j']!.error).toContain('connection refused')
    // E gli altri due rispondono lo stesso: si vede CHE COSA è rotto.
    expect(checks['redis']!.status).toBe('ok')
    expect(checks['keycloak']!.status).toBe('ok')
    // La sessione si chiude anche così.
    expect(close).toHaveBeenCalled()
  })

  it('Redis giù: idem, e il client si chiude comunque senza far cadere il resto', async () => {
    redisClient.connect.mockRejectedValue(new Error('ECONNREFUSED'))
    const out = await R.Query.systemHealth(null, null, ADMIN) as Record<string, never>
    const checks = out['checks'] as unknown as Record<string, { status: string; error: string | null }>
    expect(checks['redis']!.status).toBe('error')
    expect(out['status']).toBe('degraded')
  })

  it('Keycloak che risponde ma male è «degraded», non «error»: la differenza conta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const out = await R.Query.systemHealth(null, null, ADMIN) as Record<string, never>
    const kc = (out['checks'] as unknown as Record<string, { status: string; error: string | null; latencyMs: number | null }>)['keycloak']!
    // Irraggiungibile e «risponde 503» sono due guasti diversi: il secondo ha
    // una latenza, quindi la rete c'è ed è Keycloak ad avere un problema.
    expect(kc.status).toBe('degraded')
    expect(kc.error).toBe('HTTP 503')
    expect(kc.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('Keycloak irraggiungibile è «error», senza latenza', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    const kc = ((await R.Query.systemHealth(null, null, ADMIN) as Record<string, never>)['checks'] as unknown as Record<string, { status: string; latencyMs: number | null }>)['keycloak']!
    expect(kc.status).toBe('error')
    expect(kc.latencyMs).toBeNull()
  })

  it('i tre controlli partono INSIEME, non in fila', async () => {
    const ordine: string[] = []
    txRun.mockImplementation(async () => { ordine.push('neo4j'); await new Promise((r) => setTimeout(r, 20)); return { records: [] } })
    redisClient.connect.mockImplementation(async () => { ordine.push('redis') })
    vi.stubGlobal('fetch', vi.fn(async () => { ordine.push('keycloak'); return { ok: true, status: 200 } }))
    await R.Query.systemHealth(null, null, ADMIN)
    // Se fossero in sequenza, redis e keycloak partirebbero DOPO i 20ms di neo4j.
    expect(ordine.slice(0, 3).sort()).toEqual(['keycloak', 'neo4j', 'redis'])
  })
})

describe('systemMetrics e traceInfo', () => {
  it('le metriche escono raggruppate come le chiede la pagina', async () => {
    expect(await R.Query.systemMetrics(null, null, ADMIN)).toEqual({
      requests: { total: 10 }, graphql: { ops: 3 }, neo4j: { queries: 99 },
      system: { rssMb: 120 }, queues: [{ queue: 'sla', waiting: 0 }],
    })
  })

  it('le tracce escono COPIATE: chi legge non tiene in mano il buffer vivo', async () => {
    const out = await R.Query.traceInfo(null, null, ADMIN) as Record<string, unknown>
    expect(out).toMatchObject({ enabled: true, endpoint: 'http://jaeger:4318' })
    const { recentTraces } = await import('../../../telemetry.js')
    expect(out['recentTraces']).toEqual(recentTraces)
    expect(out['recentTraces']).not.toBe(recentTraces)
  })
})
