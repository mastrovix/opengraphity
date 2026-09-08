import { describe, it, expect } from 'vitest'
import { getRedisConnection, describeRedisConnection } from '../redis.js'

describe('getRedisConnection — one parser for every Redis client (D-14, G-07)', () => {
  it('parses REDIS_URL with host, port, password, db', () => {
    expect(getRedisConnection({ REDIS_URL: 'redis://:s3cret@cache.internal:6380/2' })).toEqual({
      host: 'cache.internal', port: 6380, password: 's3cret', db: 2,
    })
  })

  it('rediss:// enables TLS', () => {
    expect(getRedisConnection({ REDIS_URL: 'rediss://cache:6379' })).toEqual({ host: 'cache', port: 6379, tls: {} })
  })

  it('REDIS_PASSWORD complements a URL without password; the URL password wins when both exist', () => {
    expect(getRedisConnection({ REDIS_URL: 'redis://redis:6379', REDIS_PASSWORD: 'pw' })).toEqual({ host: 'redis', port: 6379, password: 'pw' })
    expect(getRedisConnection({ REDIS_URL: 'redis://:url-pw@redis:6379', REDIS_PASSWORD: 'env-pw' }).password).toBe('url-pw')
  })

  it('URL-encoded password is decoded', () => {
    expect(getRedisConnection({ REDIS_URL: 'redis://:p%40ss@redis' }).password).toBe('p@ss')
  })

  it('REDIS_HOST/PORT/PASSWORD form', () => {
    expect(getRedisConnection({ REDIS_HOST: 'redis', REDIS_PORT: '6390', REDIS_PASSWORD: 'pw' })).toEqual({ host: 'redis', port: 6390, password: 'pw' })
  })

  it('outside production falls back to localhost:6379 (with REDIS_PASSWORD if given)', () => {
    expect(getRedisConnection({})).toEqual({ host: 'localhost', port: 6379 })
    expect(getRedisConnection({ NODE_ENV: 'development', REDIS_PASSWORD: 'pw' })).toEqual({ host: 'localhost', port: 6379, password: 'pw' })
  })

  it('in production THROWS when neither REDIS_URL nor REDIS_HOST is set (no silent localhost)', () => {
    expect(() => getRedisConnection({ NODE_ENV: 'production' })).toThrow(/Neither REDIS_URL nor REDIS_HOST/)
    expect(() => getRedisConnection({ NODE_ENV: 'production', REDIS_PASSWORD: 'pw' })).toThrow(/production/)
  })

  it('THROWS on a malformed URL, unsupported scheme or invalid port', () => {
    expect(() => getRedisConnection({ REDIS_URL: 'not a url' })).toThrow(/not a valid URL/)
    expect(() => getRedisConnection({ REDIS_URL: 'http://redis:6379' })).toThrow(/redis:\/\/ or rediss:\/\//)
    expect(() => getRedisConnection({ REDIS_HOST: 'redis', REDIS_PORT: 'abc' })).toThrow(/valid TCP port/)
    expect(() => getRedisConnection({ REDIS_URL: 'redis://redis/x' })).toThrow(/database index/)
  })

  it('returns a fresh object each call (callers spread ioredis options into it)', () => {
    const env = { REDIS_HOST: 'r' }
    const a = getRedisConnection(env)
    const b = getRedisConnection(env)
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it('describeRedisConnection never exposes the password', () => {
    const s = describeRedisConnection({ host: 'redis', port: 6379, password: 'topsecret', db: 1 })
    expect(s).toBe('redis://redis:6379/1 (auth)')
    expect(s).not.toContain('topsecret')
  })
})
