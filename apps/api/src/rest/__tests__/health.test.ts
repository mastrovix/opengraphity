/**
 * GET /health over a real Express app: 200 "ok" when Neo4j and Redis answer,
 * 503 "degraded" naming the failing dependency when either one fails or hangs
 * past the 2 s guard. Neo4j, the events Redis config and ioredis are mocked;
 * the Redis probe must use the same connection options as the queues.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const redisState = vi.hoisted(() => ({
  connect:    vi.fn<() => Promise<void>>(),
  ping:       vi.fn<() => Promise<string>>(),
  disconnect: vi.fn(),
  ctorOpts:   [] as unknown[],
}))

// Mock PARZIALE: le funzioni pure del pacchetto (`toNumber`, che converte gli
// Integer del driver) restano quelle vere. Sostituirle nasconderebbe proprio le
// conversioni che in passato hanno rotto `deleteEnumType`.
vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return { ...orig, getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }
})
vi.mock('@opengraphity/events', () => ({
  getRedisConnection: vi.fn(() => ({ host: 'redis.internal', port: 6380, password: 'pw' })),
}))
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(opts: unknown) { redisState.ctorOpts.push(opts) }
    connect()    { return redisState.connect() }
    ping()       { return redisState.ping() }
    disconnect() { redisState.disconnect() }
  },
}))

const { getSession } = await import('@opengraphity/neo4j')
const { healthRouter } = await import('../health.js')

const neo = { run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/', healthRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  redisState.ctorOpts.length = 0
  vi.mocked(getSession).mockReturnValue(neo as never)
  neo.run.mockResolvedValue({ records: [] })
  redisState.connect.mockResolvedValue(undefined)
  redisState.ping.mockResolvedValue('PONG')
})

interface HealthBody { status: string; timestamp: string; version: string; services: { neo4j: string; redis: string } }

describe('GET /health', () => {
  it('all dependencies up → 200 ok', async () => {
    const res = await fetch(base)
    expect(res.status).toBe(200)
    const body = await res.json() as HealthBody
    expect(body).toMatchObject({ status: 'ok', services: { neo4j: 'ok', redis: 'ok' } })
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false)
    expect(neo.run).toHaveBeenCalledWith('RETURN 1')
    expect(neo.close).toHaveBeenCalled()
    expect(redisState.disconnect).toHaveBeenCalled()
  })

  it('Redis probe uses the queues connection options, lazyConnect and no retries', async () => {
    await fetch(base)
    expect(redisState.ctorOpts[0]).toEqual({
      host: 'redis.internal', port: 6380, password: 'pw', lazyConnect: true, maxRetriesPerRequest: 0,
    })
  })

  it('Neo4j failure → 503 degraded, neo4j: error, redis: ok', async () => {
    neo.run.mockRejectedValueOnce(new Error('ServiceUnavailable'))
    const res = await fetch(base)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', services: { neo4j: 'error', redis: 'ok' } })
    expect(neo.close).toHaveBeenCalled()
  })

  it('Redis connect failure → 503 degraded, redis: error, client disconnected', async () => {
    redisState.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await fetch(base)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', services: { neo4j: 'ok', redis: 'error' } })
    expect(redisState.disconnect).toHaveBeenCalled()
  })

  it('Redis connects but PING fails → redis: error', async () => {
    redisState.ping.mockRejectedValueOnce(new Error('NOAUTH'))
    const res = await fetch(base)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ services: { neo4j: 'ok', redis: 'error' } })
  })

  it('both down → 503 with both marked error', async () => {
    neo.run.mockRejectedValueOnce(new Error('down'))
    redisState.connect.mockRejectedValueOnce(new Error('down'))
    const res = await fetch(base)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', services: { neo4j: 'error', redis: 'error' } })
  })

  it('a dependency that never answers is reported as error after the 2 s guard (real timer)', async () => {
    neo.run.mockReturnValueOnce(new Promise(() => { /* never settles */ }))
    const started = Date.now()
    const res = await fetch(base)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ services: { neo4j: 'error', redis: 'ok' } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(neo.close).toHaveBeenCalled()
  }, 10_000)
})
