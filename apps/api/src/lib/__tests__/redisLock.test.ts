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

const { withRedisLock, RedisLockTimeoutError, RELEASE_LOCK_LUA } = await import('../redisLock.js')
const { logger } = await import('../logger.js')

const OPTS = { ttlSeconds: 30, waitMs: 1_000, pollMs: 100 }

beforeEach(() => {
  vi.clearAllMocks()
  redis.set.mockResolvedValue('OK')
  redis.eval.mockResolvedValue(1)
})
afterEach(() => { vi.useRealTimers() })

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
