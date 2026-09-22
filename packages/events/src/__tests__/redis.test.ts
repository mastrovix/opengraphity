import { describe, it, expect } from 'vitest'
import { getRedisConnection, getRedisOptions, describeRedisConnection } from '../redis.js'

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

/**
 * The corners of the parser that only a real deployment reaches.
 *
 * The connection string is written by whoever installs the product, once,
 * and a wrong reading of it does not surface as a clear error: BullMQ simply
 * never connects, and the workers stay quiet. Each case below is a shape a
 * hosted Redis actually hands out.
 */
describe('getRedisConnection — the deployment corners', () => {
  it('a username in the URL is carried over, percent-decoded like the password', () => {
    // Redis 6 ACLs: managed providers hand out `user:pass@` with both halves
    // URL-encoded, and an undecoded one authenticates as a user that does not exist.
    expect(getRedisConnection({ REDIS_URL: 'redis://app%2Duser:p%40ss@cache:6379' })).toEqual({
      host: 'cache', port: 6379, username: 'app-user', password: 'p@ss',
    })
  })

  it('a URL with no password falls back to REDIS_PASSWORD', () => {
    // The usual split: the URL comes from the orchestrator, the password from
    // the secret store.
    expect(getRedisConnection({ REDIS_URL: 'redis://cache:6379', REDIS_PASSWORD: 'from-the-vault' }))
      .toEqual({ host: 'cache', port: 6379, password: 'from-the-vault' })
  })

  it('a URL with no port and no database uses 6379 and no db', () => {
    expect(getRedisConnection({ REDIS_URL: 'redis://cache' })).toEqual({ host: 'cache', port: 6379 })
  })

  it('database 0 is kept: it is a choice, not an absent value', () => {
    expect(getRedisConnection({ REDIS_URL: 'redis://cache/0' })).toMatchObject({ db: 0 })
  })

  it('a URL with no host at all is refused', () => {
    expect(() => getRedisConnection({ REDIS_URL: 'redis://' })).toThrow(/has no host/)
  })

  it('a negative or fractional database index is refused', () => {
    expect(() => getRedisConnection({ REDIS_URL: 'redis://cache/-1' })).toThrow(/database index/)
    expect(() => getRedisConnection({ REDIS_URL: 'redis://cache/1.5' })).toThrow(/database index/)
  })

  it('without REDIS_URL it reads REDIS_HOST, its port and its password', () => {
    expect(getRedisConnection({ REDIS_HOST: 'cache', REDIS_PORT: '6380', REDIS_PASSWORD: 's3cret' }))
      .toEqual({ host: 'cache', port: 6380, password: 's3cret' })
    expect(getRedisConnection({ REDIS_HOST: 'cache' })).toEqual({ host: 'cache', port: 6379 })
  })

  /**
   * The localhost default is a convenience for a developer's laptop. In
   * production it is a trap: the service starts, connects to a Redis that is
   * not there (or, worse, to one that is), and the failure shows up far from
   * the missing variable.
   */
  it('no REDIS_URL and no REDIS_HOST: localhost in development, a refusal in production', () => {
    expect(getRedisConnection({})).toMatchObject({ host: 'localhost', port: 6379 })
    expect(getRedisConnection({ REDIS_PORT: '6380', REDIS_PASSWORD: 'dev' })).toMatchObject({ port: 6380, password: 'dev' })
    expect(() => getRedisConnection({ NODE_ENV: 'production' }))
      .toThrow('[redis] Neither REDIS_URL nor REDIS_HOST is set in production — refusing the localhost default')
  })

  it('an out-of-range port is refused, naming which variable it came from', () => {
    expect(() => getRedisConnection({ REDIS_HOST: 'cache', REDIS_PORT: '0' })).toThrow(/REDIS_PORT/)
    expect(() => getRedisConnection({ REDIS_HOST: 'cache', REDIS_PORT: '70000' })).toThrow(/REDIS_PORT/)
    // Nothing here for the URL form: the WHATWG parser rejects a port above
    // 65535 before `parsePort` ever sees it ("is not a valid URL"), so that
    // check is a belt on top of braces.
    expect(() => getRedisConnection({ REDIS_URL: 'redis://cache:99999' })).toThrow(/not a valid URL/)
  })

  it('getRedisOptions is still the same answer as getRedisConnection (deprecated alias)', () => {
    // Four call sites still import it; when the last one moves over, both the
    // alias and this test go.
    expect(getRedisOptions()).toEqual(getRedisConnection())
  })

  it('describeRedisConnection says rediss for TLS, and omits what is not set', () => {
    expect(describeRedisConnection({ host: 'cache', port: 6379, tls: {} })).toBe('rediss://cache:6379')
    expect(describeRedisConnection({ host: 'cache', port: 6379 })).toBe('redis://cache:6379')
  })
})
