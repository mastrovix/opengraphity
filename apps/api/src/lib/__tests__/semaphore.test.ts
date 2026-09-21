/**
 * lib/semaphore.ts — al massimo `limit` esecuzioni contemporanee, chi arriva
 * oltre attende in coda FIFO (mai scartato), oltre `waitMs` →
 * SemaphoreTimeoutError (ServiceUnavailableError con retryAfterSeconds), il
 * permesso torna libero anche se `fn` fallisce, rilascio doppio ignorato.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Semaphore, SemaphoreTimeoutError } from '../semaphore.js'
import { ServiceUnavailableError } from '../errors.js'

const OPTS = { name: 'test-sem', limit: 2, waitMs: 1_000, retryAfterSeconds: 5 }

/** Promise controllabile dall'esterno. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => { vi.useRealTimers() })

describe('Semaphore', () => {
  it('esegue fino a `limit` funzioni in parallelo; la terza aspetta che una finisca (FIFO)', async () => {
    const sem = new Semaphore(OPTS)
    const a = deferred(); const b = deferred(); const c = deferred()
    const order: string[] = []
    const pa = sem.run(async () => { order.push('a'); await a.promise; return 'A' })
    const pb = sem.run(async () => { order.push('b'); await b.promise; return 'B' })
    const pc = sem.run(async () => { order.push('c'); await c.promise; return 'C' })
    await Promise.resolve()
    expect(sem.active).toBe(2)
    expect(sem.waiting).toBe(1)
    expect(order).toEqual(['a', 'b'])

    a.resolve()
    await expect(pa).resolves.toBe('A')
    await vi.waitFor(() => expect(order).toEqual(['a', 'b', 'c']))
    expect(sem.active).toBe(2)
    expect(sem.waiting).toBe(0)

    b.resolve(); c.resolve()
    await expect(Promise.all([pb, pc])).resolves.toEqual(['B', 'C'])
    expect(sem.active).toBe(0)
  })

  it('fn che fallisce → l\'errore propaga e il permesso torna libero', async () => {
    const sem = new Semaphore({ ...OPTS, limit: 1 })
    await expect(sem.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sem.active).toBe(0)
    await expect(sem.run(async () => 1)).resolves.toBe(1)
  })

  it('attesa oltre waitMs → SemaphoreTimeoutError (ServiceUnavailableError, retryAfterSeconds), il chiamante esce dalla coda', async () => {
    vi.useFakeTimers()
    const sem = new Semaphore({ ...OPTS, limit: 1 })
    const gate = deferred()
    const holder = sem.run(async () => { await gate.promise })
    const late = sem.run(async () => 'never')
    const lateResult = late.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    const err = await lateResult
    expect(err).toBeInstanceOf(SemaphoreTimeoutError)
    expect(err).toBeInstanceOf(ServiceUnavailableError)
    expect((err as ServiceUnavailableError).retryAfterSeconds).toBe(5)
    expect((err as Error).message).toMatch(/test-sem.*busy.*1000 ms/)
    expect(sem.waiting).toBe(0)
    // chi teneva il permesso non è stato toccato
    gate.resolve()
    await expect(holder).resolves.toBeUndefined()
    expect(sem.active).toBe(0)
  })

  it('rilascio doppio dello stesso permesso è ignorato (non regala slot)', async () => {
    const sem = new Semaphore({ ...OPTS, limit: 1 })
    const release = await sem.acquire()
    release(); release()
    expect(sem.active).toBe(0)
    const again = await sem.acquire()
    expect(sem.active).toBe(1)
    again()
  })

  it('limit non intero o < 1 → errore di configurazione', () => {
    expect(() => new Semaphore({ ...OPTS, limit: 0 })).toThrow(/limit must be an integer ≥ 1/)
    expect(() => new Semaphore({ ...OPTS, limit: 1.5 })).toThrow(/limit must be an integer ≥ 1/)
  })
})
