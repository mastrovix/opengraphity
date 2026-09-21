/**
 * lib/webhookRateLimit.ts — bucket per (tenant, webhook, minuto) su Redis con
 * INCR+EXPIRE atomici (Lua), Retry-After = secondi alla fine del minuto,
 * limite per sorgente con l'unico default ammesso (100) quando la proprietà
 * manca, validazione 1..10000, Redis giù → errore propagato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redis = { eval: vi.fn() }
vi.mock('../bullmq.js', () => ({ getSharedRedis: () => redis }))

const {
  consumeWebhookRate, rateLimitOf, validateRateLimitPerMinute, webhookRateKey, secondsToWindowEnd,
  DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE, WEBHOOK_RATE_LUA, WEBHOOK_RATE_KEY_TTL_SECONDS,
} = await import('../webhookRateLimit.js')

// 2026-09-09T10:15:20Z → minuto epoch 29814735, mancano 40 s alla fine
const AT = Date.parse('2026-09-09T10:15:20.000Z')

beforeEach(() => { vi.clearAllMocks() })

describe('consumeWebhookRate', () => {
  it('chiama lo script Lua (INCR + EXPIRE) sulla chiave tenant/webhook/minuto con il TTL; entro il limite → allowed', async () => {
    redis.eval.mockResolvedValueOnce(1)
    const d = await consumeWebhookRate('t1', 'hook-1', 100, AT)
    expect(redis.eval).toHaveBeenCalledWith(WEBHOOK_RATE_LUA, 1, `og:webhook:rate:t1:hook-1:${Math.floor(AT / 60_000)}`, WEBHOOK_RATE_KEY_TTL_SECONDS)
    expect(WEBHOOK_RATE_LUA).toMatch(/INCR.*EXPIRE/s)
    expect(d).toEqual({ allowed: true, count: 1, limit: 100, retryAfterSeconds: 40 })
  })

  it('oltre il limite → allowed false con Retry-After ai secondi mancanti al minuto (mai < 1)', async () => {
    redis.eval.mockResolvedValueOnce(101)
    expect(await consumeWebhookRate('t1', 'hook-1', 100, AT)).toMatchObject({ allowed: false, count: 101, retryAfterSeconds: 40 })
    redis.eval.mockResolvedValueOnce(6)
    expect(await consumeWebhookRate('t1', 'hook-1', 5, AT + 39_900)).toMatchObject({ allowed: false, retryAfterSeconds: 1 })
  })

  it('Redis irraggiungibile → l\'errore propaga (mai "limite disattivato")', async () => {
    redis.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(consumeWebhookRate('t1', 'hook-1', 100, AT)).rejects.toThrow('ECONNREFUSED')
  })

  it('risposta inattesa dallo script → errore', async () => {
    redis.eval.mockResolvedValueOnce(null)
    await expect(consumeWebhookRate('t1', 'hook-1', 100, AT)).rejects.toThrow(/unexpected INCR reply/)
  })
})

describe('chiave e finestra', () => {
  it('la chiave cambia a ogni minuto e isola tenant e webhook', () => {
    expect(webhookRateKey('t1', 'h', AT)).not.toBe(webhookRateKey('t1', 'h', AT + 60_000))
    expect(webhookRateKey('t1', 'h', AT)).toBe(webhookRateKey('t1', 'h', AT + 39_000))
    expect(webhookRateKey('t1', 'h', AT)).not.toBe(webhookRateKey('t2', 'h', AT))
  })

  it('secondsToWindowEnd: fine minuto esatta → 60, ultimo istante → 1', () => {
    expect(secondsToWindowEnd(Date.parse('2026-09-09T10:15:00.000Z'))).toBe(60)
    expect(secondsToWindowEnd(Date.parse('2026-09-09T10:15:59.999Z'))).toBe(1)
  })
})

describe('rateLimitOf / validateRateLimitPerMinute', () => {
  it('proprietà assente o null → default 100 (unico default ammesso); presente → il suo valore', () => {
    expect(DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE).toBe(100)
    expect(rateLimitOf({})).toBe(100)
    expect(rateLimitOf({ rate_limit_per_minute: null })).toBe(100)
    expect(rateLimitOf({ rate_limit_per_minute: 2500 })).toBe(2500)
  })

  it.each([0, 10_001, 1.5, '100', -1])('valore non valido %s → ValidationError che cita l\'intervallo', (v) => {
    expect(() => validateRateLimitPerMinute(v, 'rateLimitPerMinute')).toThrow(/rateLimitPerMinute must be an integer in 1\.\.10000/)
    expect(() => rateLimitOf({ rate_limit_per_minute: v })).toThrow(/rate_limit_per_minute must be an integer in 1\.\.10000/)
  })

  it('estremi 1 e 10000 accettati', () => {
    expect(validateRateLimitPerMinute(1, 'x')).toBe(1)
    expect(validateRateLimitPerMinute(10_000, 'x')).toBe(10_000)
  })
})
