/**
 * lib/metricsServer.ts: GET /metrics del processo worker con la stessa
 * esposizione e la stessa politica di accesso dell'API; tutto il resto 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }))

const { metricsRequestListener, startMetricsServer } = await import('../metricsServer.js')
const { resetConfigCache } = await import('../config.js')
const { eventsReceivedTotal } = await import('../../middleware/metrics.js')

function fakeReq(method: string, url: string, remoteAddress: string, authorization?: string): IncomingMessage {
  return { method, url, headers: authorization ? { authorization } : {}, socket: { remoteAddress } } as unknown as IncomingMessage
}
function fakeRes(): ServerResponse & { body: string; headers: Record<string, string> } {
  const res = { statusCode: 200, body: '', headers: {} as Record<string, string> }
  return Object.assign(res, {
    setHeader: (k: string, v: string) => { res.headers[k] = v },
    end: (chunk?: string) => { res.body = chunk ?? '' },
  }) as never
}

beforeEach(() => { vi.stubEnv('METRICS_TOKEN', ''); resetConfigCache() })
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache() })

describe('metricsRequestListener', () => {
  it('GET /metrics da rete privata → 200 con l\'esposizione Prometheus (comprese le metriche dell\'Event Management)', () => {
    eventsReceivedTotal.inc({ connector: 'generic' })
    const res = fakeRes()
    metricsRequestListener(fakeReq('GET', '/metrics', '172.18.0.9'), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8')
    expect(res.body).toContain('# TYPE events_received_total counter')
    expect(res.body).toContain('# TYPE event_ingest_lag_seconds histogram')
    expect(res.body).toContain('# TYPE bullmq_queue_depth gauge')
  })

  it('altri percorsi o metodi → 404; indirizzo pubblico senza token → 403; con METRICS_TOKEN il bearer è obbligatorio (401 senza)', () => {
    let res = fakeRes()
    metricsRequestListener(fakeReq('GET', '/health', '127.0.0.1'), res)
    expect(res.statusCode).toBe(404)
    res = fakeRes()
    metricsRequestListener(fakeReq('POST', '/metrics', '127.0.0.1'), res)
    expect(res.statusCode).toBe(404)
    res = fakeRes()
    metricsRequestListener(fakeReq('GET', '/metrics', '203.0.113.7'), res)
    expect(res.statusCode).toBe(403)

    vi.stubEnv('METRICS_TOKEN', 's3cret'); resetConfigCache()
    res = fakeRes()
    metricsRequestListener(fakeReq('GET', '/metrics', '127.0.0.1'), res)
    expect(res.statusCode).toBe(401)
    res = fakeRes()
    metricsRequestListener(fakeReq('GET', '/metrics', '203.0.113.7', 'Bearer s3cret'), res)
    expect(res.statusCode).toBe(200)
  })
})

describe('startMetricsServer', () => {
  it('ascolta sulla porta data e risponde a GET /metrics; una porta occupata è un errore d\'avvio', async () => {
    const server = await startMetricsServer(0)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const r = await fetch(`http://127.0.0.1:${address.port}/metrics`)
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('# TYPE events_failed_total counter')
    await expect(startMetricsServer(address.port)).rejects.toThrow(/EADDRINUSE/)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
