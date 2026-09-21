/**
 * lib/shutdown.ts (revisione 2 · D1.2): l'HTTP viene atteso davvero (idle
 * subito, tutte dopo la grazia), i worker si chiudono entro il timeout, e se
 * non lo fanno le risorse condivise NON vengono chiuse sotto i job e il
 * processo esce con un codice ≠ 0.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runGracefulShutdown, closeHttpServer, EXIT_OK, EXIT_RESOURCES_FAILED, EXIT_WORKERS_TIMED_OUT, type ClosableHttpServer, type Closable } from '../shutdown.js'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const exit = vi.fn((code: number) => { throw new ExitSignal(code) })
class ExitSignal extends Error { constructor(public readonly code: number) { super(`exit ${code}`) } }

function fakeHttp(closeDelayMs = 0): ClosableHttpServer & { closeIdleConnections: ReturnType<typeof vi.fn>; closeAllConnections: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn((cb?: (err?: Error) => void) => { setTimeout(() => cb?.(), closeDelayMs) }),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  }
}
const closable = (name: string, close: () => Promise<unknown> = async () => undefined): Closable & { close: ReturnType<typeof vi.fn> } => ({ name, close: vi.fn(close) })
const exitCodeOf = (p: Promise<never>) => p.then(() => -1, (e: unknown) => (e instanceof ExitSignal ? e.code : Promise.reject(e)))

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('closeHttpServer', () => {
  it('chiude subito le connessioni inattive e, passata la grazia, tutte le altre; attende la promessa di close()', async () => {
    vi.useFakeTimers()
    const http = fakeHttp(200)
    const done = closeHttpServer(http, 100, log)
    expect(http.closeIdleConnections).toHaveBeenCalledTimes(1)
    expect(http.closeAllConnections).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(http.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ graceMs: 100 }), expect.stringMatching(/still open/))
    await vi.advanceTimersByTimeAsync(100)
    await expect(done).resolves.toBeUndefined()
  })

  it('se close() finisce prima della grazia, closeAllConnections non viene chiamata', async () => {
    vi.useFakeTimers()
    const http = fakeHttp(10)
    const done = closeHttpServer(http, 1_000, log)
    await vi.advanceTimersByTimeAsync(10)
    await done
    await vi.advanceTimersByTimeAsync(2_000)
    expect(http.closeAllConnections).not.toHaveBeenCalled()
  })
})

describe('runGracefulShutdown', () => {
  it('sequenza felice: HTTP → worker e consumer → risorse nell\'ordine dato → exit 0', async () => {
    const http = fakeHttp()
    const order: string[] = []
    const w1 = closable('w1', async () => { order.push('w1') })
    const c1 = closable('c1', async () => { order.push('c1') })
    const r1 = closable('r1', async () => { order.push('r1') })
    const r2 = closable('r2', async () => { order.push('r2') })
    const code = await exitCodeOf(runGracefulShutdown({ signal: 'SIGTERM', httpServer: http, workers: [w1, c1], resources: [r1, r2], log, exit: exit as never, workersTimeoutMs: 1_000, httpGraceMs: 50 }))
    expect(code).toBe(EXIT_OK)
    expect(http.close).toHaveBeenCalled()
    expect(order).toEqual(['w1', 'c1', 'r1', 'r2'])
    expect(log.info).toHaveBeenCalledWith('HTTP server closed')
    expect(log.info).toHaveBeenCalledWith('Graceful shutdown completed')
  })

  it('worker che non si fermano entro il timeout → le risorse NON vengono chiuse e il processo esce con EXIT_WORKERS_TIMED_OUT', async () => {
    vi.useFakeTimers()
    const stuck = closable('events-ingest', () => new Promise(() => undefined))
    const r1 = closable('neo4j-driver')
    const pending = exitCodeOf(runGracefulShutdown({ signal: 'SIGTERM', httpServer: null, workers: [stuck], resources: [r1], log, exit: exit as never, workersTimeoutMs: 30_000 }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await pending).toBe(EXIT_WORKERS_TIMED_OUT)
    expect(r1.close).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ workersTimeoutMs: 30_000, workers: ['events-ingest'] }), expect.stringMatching(/leaving queues, Redis and Neo4j OPEN/))
    expect(EXIT_WORKERS_TIMED_OUT).not.toBe(0)
  })

  it('un worker che fallisce la chiusura non blocca gli altri; una risorsa che fallisce → log.error ed exit EXIT_RESOURCES_FAILED', async () => {
    const bad = closable('bad-worker', async () => { throw new Error('close boom') })
    const ok = closable('ok-worker')
    const r1 = closable('bullmq-queues', async () => { throw new Error('quit failed') })
    const r2 = closable('neo4j-driver')
    const code = await exitCodeOf(runGracefulShutdown({ signal: 'SIGINT', workers: [bad, ok], resources: [r1, r2], log, exit: exit as never, workersTimeoutMs: 1_000 }))
    expect(code).toBe(EXIT_RESOURCES_FAILED)
    expect(ok.close).toHaveBeenCalled()
    expect(r2.close).toHaveBeenCalled()   // le risorse successive vengono comunque chiuse
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ closable: 'bad-worker' }), 'Close failed during shutdown')
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ resource: 'bullmq-queues' }), 'Resource close failed')
  })

  it('HTTP che fallisce la chiusura non impedisce di fermare i worker', async () => {
    const http: ClosableHttpServer = { close: (cb) => cb?.(new Error('EBADF')), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() }
    const w = closable('w')
    const code = await exitCodeOf(runGracefulShutdown({ signal: 'SIGTERM', httpServer: http, workers: [w], resources: [], log, exit: exit as never, workersTimeoutMs: 100 }))
    expect(code).toBe(EXIT_OK)
    expect(w.close).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/HTTP server close failed/))
  })
})
