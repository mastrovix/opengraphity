/**
 * The two health probes and what they must NOT depend on.
 *
 * - `/health/live` is the container healthcheck: it answers "is this process
 *   alive and are its dependencies reachable?" and deliberately ignores
 *   pending migrations. During the documented two-step deploy (new image up,
 *   then `migrate`) the API must not look dead in `docker compose ps`.
 * - `/health` is the full probe. Incomplete tenants are reported as a COUNT
 *   only (the endpoint is unauthenticated; tenant ids would leak to any uptime
 *   probe) and never degrade the status: a tenant still to configure is not a
 *   process failure.
 * - The migration and provisioning lookups must never make the probe itself
 *   crash: a failing lookup degrades to "nothing known", and neither runs at
 *   all when Neo4j is already down.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const h = vi.hoisted(() => ({
  connect:  vi.fn<() => Promise<void>>(),
  ping:     vi.fn<() => Promise<string>>(),
  pending:  vi.fn<() => Promise<string[]>>(),
  gaps:     vi.fn<() => Promise<Record<string, string[]>>>(),
  neoRun:   vi.fn<() => Promise<unknown>>(),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ run: h.neoRun, close: vi.fn(async () => undefined) }),
}))
vi.mock('@opengraphity/events', () => ({ getRedisConnection: () => ({ host: 'r', port: 6379 }) }))
vi.mock('ioredis', () => ({
  Redis: class {
    connect() { return h.connect() }
    ping() { return h.ping() }
    disconnect() { /* nothing to release */ }
  },
}))
vi.mock('../../lib/migrationState.js', () => ({ pendingMigrations: () => h.pending() }))
vi.mock('../../lib/provisioningGauge.js', () => ({ provisioningGaps: () => h.gaps() }))

const { healthRouter } = await import('../health.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/', healthRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  h.neoRun.mockResolvedValue({ records: [] })
  h.connect.mockResolvedValue(undefined)
  h.ping.mockResolvedValue('PONG')
  h.pending.mockResolvedValue([])
  h.gaps.mockResolvedValue({})
})

describe('GET /health/live', () => {
  it('dependencies up → 200 ok, even with pending migrations (they are a deploy matter)', async () => {
    h.pending.mockResolvedValue(['20260930_x'])
    const res = await fetch(`${base}/health/live`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ status: 'ok', services: { neo4j: 'ok', redis: 'ok' } })
    expect(body).not.toHaveProperty('pendingMigrations')
    expect(h.pending).not.toHaveBeenCalled()
  })

  it('a dependency down → 503 degraded naming it', async () => {
    h.ping.mockRejectedValueOnce(new Error('NOAUTH'))
    const res = await fetch(`${base}/health/live`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', services: { neo4j: 'ok', redis: 'error' } })
  })
})

describe('GET /health — incomplete tenants and failing lookups', () => {
  it('incomplete tenants are counted, never named, and do not degrade the probe', async () => {
    h.gaps.mockResolvedValue({ 'c-one': ['workflow incident'], 'c-two': ['dashboard'], 'c-ok': [] })
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toMatchObject({ status: 'ok', incompleteTenants: 2 })
    // Why: the endpoint has no auth; tenant ids must not leak to an uptime probe.
    expect(text).not.toContain('c-one')
    expect(text).not.toContain('c-two')
  })

  it('failing migration and provisioning lookups degrade to "nothing known", not to a crashed probe', async () => {
    h.pending.mockRejectedValue(new Error('neo4j blip'))
    h.gaps.mockRejectedValue(new Error('neo4j blip'))
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body).not.toHaveProperty('pendingMigrations')
    expect(body).not.toHaveProperty('incompleteTenants')
  })

  it('with Neo4j down the graph-backed lookups are not even attempted', async () => {
    h.neoRun.mockRejectedValue(new Error('ServiceUnavailable'))
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(503)
    expect(h.pending).not.toHaveBeenCalled()
    expect(h.gaps).not.toHaveBeenCalled()
  })
})
