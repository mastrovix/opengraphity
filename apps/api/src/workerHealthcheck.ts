/**
 * The liveness probe of the `worker` and `events-worker` containers (same
 * image as the API, no HTTP endpoint): `node worker-healthcheck.mjs`, which
 * the Dockerfile writes as an import of this file. Exit 0 only when this
 * container's process is alive and, with tenants, a worker of
 * HEALTHCHECK_QUEUE is connected (lib/workerLiveness.ts).
 */
import { hostname } from 'node:os'
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'
import { ALIVE_KEY_PREFIX, livenessVerdict } from './lib/workerLiveness.js'

const base = process.env['HEALTHCHECK_QUEUE'] || 'embeddings'
// The probe's line goes to the container's health log: stderr, no logger (nothing else runs here).
const say = (line: string) => { process.stderr.write(`worker healthcheck: ${line}\n`) }
const timer = setTimeout(() => { say('timeout'); process.exit(1) }, 4000)
const redis = new Redis({ ...getRedisConnection(), lazyConnect: true, maxRetriesPerRequest: 1 })
redis.on('error', () => {})

let ok = false
try {
  await redis.connect()
  const alive = await redis.get(`${ALIVE_KEY_PREFIX}${hostname()}`)
  const clients = String(await redis.client('LIST'))
  const verdict = livenessVerdict(alive, clients, base)
  ok = verdict.ok
  if (!ok) say(verdict.reason)
} catch (err) {
  say(err instanceof Error ? err.message : String(err))
}
redis.disconnect()
clearTimeout(timer)
process.exit(ok ? 0 : 1)
