/**
 * Single source of the Redis connection options (G-07, A-24, C-27, D-14).
 *
 * Every BullMQ Queue/Worker and every plain ioredis client in the platform
 * (events publisher/consumer, SLA scheduler, API queues, health check, …)
 * reads its connection from here — one parser, one set of rules:
 *
 *   - `REDIS_URL` (preferred): `redis://[user[:password]@]host[:port][/db]`
 *     or `rediss://…` (TLS). A password embedded in the URL wins.
 *   - `REDIS_HOST` / `REDIS_PORT` as the non-URL form.
 *   - `REDIS_PASSWORD` applies to both forms when the URL carries none, so the
 *     compose file can keep the URL readable and the secret separate.
 *
 * Fail-fast: in production neither form may be missing (no localhost default),
 * and a malformed URL/port throws at the first connection attempt instead of
 * silently pointing half of the system at a different instance.
 */

export interface RedisConnectionOptions {
  host: string
  port: number
  password?: string
  username?: string
  db?: number
  /** Present (empty object) when the URL scheme is `rediss://`. */
  tls?: Record<string, never>
}

/** @deprecated Use RedisConnectionOptions. Kept for the callers not yet migrated. */
export type RedisOptions = RedisConnectionOptions

const DEV_DEFAULT: RedisConnectionOptions = { host: 'localhost', port: 6379 }

type Env = Readonly<Record<string, string | undefined>>

function parsePort(raw: string, source: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`[redis] ${source} is not a valid TCP port: "${raw}"`)
  }
  return port
}

function fromUrl(raw: string, env: Env): RedisConnectionOptions {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`[redis] REDIS_URL is not a valid URL: "${raw}"`)
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`[redis] REDIS_URL must use redis:// or rediss:// (got ${url.protocol}//)`)
  }
  if (!url.hostname) throw new Error(`[redis] REDIS_URL has no host: "${raw}"`)

  const opts: RedisConnectionOptions = {
    host: url.hostname,
    port: url.port ? parsePort(url.port, 'REDIS_URL port') : 6379,
  }
  const password = url.password ? decodeURIComponent(url.password) : env['REDIS_PASSWORD']
  if (password) opts.password = password
  if (url.username) opts.username = decodeURIComponent(url.username)
  const dbPath = url.pathname.replace(/^\//, '')
  if (dbPath) {
    const db = Number(dbPath)
    if (!Number.isInteger(db) || db < 0) throw new Error(`[redis] REDIS_URL database index is not a number: "${dbPath}"`)
    opts.db = db
  }
  if (url.protocol === 'rediss:') opts.tls = {}
  return opts
}

function fromHostPort(env: Env): RedisConnectionOptions {
  const host = env['REDIS_HOST']
  const rawPort = env['REDIS_PORT']
  if (!host) {
    if (env['NODE_ENV'] === 'production') {
      throw new Error('[redis] Neither REDIS_URL nor REDIS_HOST is set in production — refusing the localhost default')
    }
    const opts: RedisConnectionOptions = { ...DEV_DEFAULT }
    if (rawPort) opts.port = parsePort(rawPort, 'REDIS_PORT')
    if (env['REDIS_PASSWORD']) opts.password = env['REDIS_PASSWORD']
    return opts
  }
  const opts: RedisConnectionOptions = {
    host,
    port: rawPort ? parsePort(rawPort, 'REDIS_PORT') : 6379,
  }
  if (env['REDIS_PASSWORD']) opts.password = env['REDIS_PASSWORD']
  return opts
}

/**
 * Connection options for BullMQ (`{ connection: getRedisConnection() }`) and
 * ioredis (`new Redis({ ...getRedisConnection(), lazyConnect: true })`).
 * Pure: reads `env` on every call (cheap) so tests can stub the environment.
 * Returns a fresh object — callers may spread extra ioredis options into it.
 */
export function getRedisConnection(env: Env = process.env): RedisConnectionOptions {
  const url = env['REDIS_URL']
  return url ? fromUrl(url, env) : fromHostPort(env)
}

/**
 * @deprecated Alias of getRedisConnection() for the call sites not yet
 * migrated (resolvers/queueStats, resolvers/monitoring, resolvers/notificationRules,
 * workflow/engine). New code imports getRedisConnection.
 */
export function getRedisOptions(): RedisConnectionOptions {
  return getRedisConnection()
}

/** Host:port for log lines — never the password. */
export function describeRedisConnection(opts: RedisConnectionOptions = getRedisConnection()): string {
  return `${opts.tls ? 'rediss' : 'redis'}://${opts.host}:${opts.port}${opts.db !== undefined ? `/${opts.db}` : ''}${opts.password ? ' (auth)' : ''}`
}
