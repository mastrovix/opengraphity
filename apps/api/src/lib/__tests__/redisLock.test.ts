/**
 * lib/redisLock.ts — withRedisLock con Redis mockato: SET NX EX con token,
 * rilascio guardato dal token (Lua GET+DEL) anche se `run` fallisce, attesa
 * con polling e `shortcut` che risponde senza entrare, RedisLockTimeoutError
 * oltre l'attesa, rilascio fallito solo loggato, Redis giù → errore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const redis = { set: vi.fn(), eval: vi.fn() }
vi.mock('../bullmq.js', () => ({ getSharedRedis: () => redis }))
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
const metrics = { redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() } }
vi.mock('../../middleware/metrics.js', () => metrics)

const { withRedisLock, lockFamily, RedisLockTimeoutError, RELEASE_LOCK_LUA } = await import('../redisLock.js')
const { logger } = await import('../logger.js')

const OPTS = { ttlSeconds: 30, waitMs: 1_000, pollMs: 100 }

beforeEach(() => {
  vi.clearAllMocks()
  redis.set.mockResolvedValue('OK')
  redis.eval.mockResolvedValue(1)
})
afterEach(() => { vi.useRealTimers() })

describe('lockFamily (etichetta `lock` delle metriche)', () => {
  it('è la famiglia della chiave, mai tenant e id; una chiave senza prefisso og: resta com\'è', () => {
    expect(lockFamily('og:events:group:t1:ci:4d0c9e')).toBe('events:group')
    expect(lockFamily('og:events:storm-open:t1:src-9')).toBe('events:storm-open')
    expect(lockFamily('og:services:incident:t1:map-2')).toBe('services:incident')
    expect(lockFamily('k')).toBe('k')
    expect(lockFamily('a:b:c')).toBe('a:b:c')
  })
})

describe('metriche dei lock (revisione 2 · D7.2)', () => {
  it('la durata della sezione critica viene osservata in redis_lock_hold_seconds{lock}, anche se run fallisce', async () => {
    await withRedisLock('og:events:group:t1:ci:x', OPTS, async () => 1)
    expect(metrics.redisLockHoldSeconds.observe).toHaveBeenCalledWith({ lock: 'events:group' }, expect.any(Number))
    await expect(withRedisLock('og:services:incident:t1:m', OPTS, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(metrics.redisLockHoldSeconds.observe).toHaveBeenCalledWith({ lock: 'services:incident' }, expect.any(Number))
    expect(metrics.redisLockTimeoutsTotal.inc).not.toHaveBeenCalled()
  })

  it('attesa scaduta → redis_lock_timeouts_total{lock} +1 e nessuna durata osservata (mai entrati)', async () => {
    vi.useFakeTimers()
    redis.set.mockResolvedValue(null)
    const pending = withRedisLock('og:events:storm-open:t1:s', OPTS, async () => 1).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(OPTS.waitMs + OPTS.pollMs)
    expect(await pending).toBeInstanceOf(RedisLockTimeoutError)
    expect(metrics.redisLockTimeoutsTotal.inc).toHaveBeenCalledWith({ lock: 'events:storm-open' })
    expect(metrics.redisLockHoldSeconds.observe).not.toHaveBeenCalled()
  })

  it('sezione critica oltre il TTL → warn esplicito (la gara che il lock evita torna possibile)', async () => {
    const spy = vi.spyOn(performance, 'now')
    spy.mockReturnValueOnce(0).mockReturnValueOnce(31_000)
    await withRedisLock('og:events:group:t1:ci:y', OPTS, async () => 'slow')
    spy.mockRestore()
    expect(logger.child({}).warn).toHaveBeenCalledWith(expect.objectContaining({ key: 'og:events:group:t1:ci:y', ttlSeconds: 30 }), expect.stringMatching(/outlived the lock TTL/))
  })
})

describe('withRedisLock', () => {
  it('prende il lock con SET NX EX e un token, esegue run, rilascia con il proprio token', async () => {
    await expect(withRedisLock('k', OPTS, async () => 42)).resolves.toBe(42)
    expect(redis.set).toHaveBeenCalledTimes(1)
    const [key, token, ex, ttl, nx] = redis.set.mock.calls[0]!
    expect([key, ex, ttl, nx]).toEqual(['k', 'EX', 30, 'NX'])
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(redis.eval).toHaveBeenCalledWith(RELEASE_LOCK_LUA, 1, 'k', token)
    expect(RELEASE_LOCK_LUA).toMatch(/GET.*DEL/s)
  })

  it('run fallisce → l\'errore propaga e il lock viene comunque rilasciato; rilascio fallito → solo log.error', async () => {
    await expect(withRedisLock('k', OPTS, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(redis.eval).toHaveBeenCalledTimes(1)

    redis.eval.mockRejectedValueOnce(new Error('ECONNRESET'))
    await expect(withRedisLock('k', OPTS, async () => 'ok')).resolves.toBe('ok')
    expect(logger.child({}).error).toHaveBeenCalledWith(expect.objectContaining({ key: 'k' }), expect.stringMatching(/release failed.*30 s/))
  })

  it('lock occupato: interroga shortcut a ogni giro e risponde senza entrare quando non è null; altrimenti riprova finché il lock si libera', async () => {
    redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('OK')
    const shortcut = vi.fn().mockResolvedValue(null)
    const run = vi.fn().mockResolvedValue('entered')
    await expect(withRedisLock('k', { ...OPTS, pollMs: 1 }, run, shortcut)).resolves.toBe('entered')
    expect(shortcut).toHaveBeenCalledTimes(2)
    expect(redis.set).toHaveBeenCalledTimes(3)

    vi.clearAllMocks()
    redis.set.mockResolvedValue(null)
    const answered = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('found')
    await expect(withRedisLock('k', { ...OPTS, pollMs: 1 }, run, answered)).resolves.toBe('found')
    expect(run).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()   // mai preso, niente da rilasciare
  })

  it('lock occupato oltre waitMs → RedisLockTimeoutError con chiave, attesa e dettaglio; nessun run', async () => {
    vi.useFakeTimers()
    redis.set.mockResolvedValue(null)
    const run = vi.fn()
    const pending = withRedisLock('k', OPTS, run, undefined, 'no incident appeared').then(() => null, (e: unknown) => e as Error)
    await vi.advanceTimersByTimeAsync(OPTS.waitMs + OPTS.pollMs)
    const err = await pending
    expect(err).toBeInstanceOf(RedisLockTimeoutError)
    expect(err!.message).toBe('Lock k still held by another job after 1000 ms and no incident appeared — will retry')
    expect((err as InstanceType<typeof RedisLockTimeoutError>).key).toBe('k')
    expect(run).not.toHaveBeenCalled()
    expect(redis.set.mock.calls.length).toBeGreaterThanOrEqual(OPTS.waitMs / OPTS.pollMs)
  })

  it('Redis giù → errore propagato (nessun fallback)', async () => {
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(withRedisLock('k', OPTS, async () => 1)).rejects.toThrow('ECONNREFUSED')
  })
})
