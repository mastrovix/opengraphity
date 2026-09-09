/**
 * Lock distribuito su Redis (`getSharedRedis`) per le sezioni critiche
 * dell'Event Management: avvio della tempesta per (tenant, sorgente) e
 * raggruppamento "trova incident → apri/aggancia/riapri" per (tenant, gruppo).
 *
 * Semantica:
 *  - `SET key <token> EX ttl NX`: chi ottiene il lock esegue `run`; il rilascio
 *    è guardato dal token (GET+DEL atomici in Lua), così un lock scaduto e
 *    ripreso da un altro non viene cancellato da chi lo aveva perso.
 *  - Chi trova il lock occupato attende (polling ogni `pollMs`, fino a
 *    `waitMs`). A ogni giro, se è dato `shortcut`, lo interroga: un valore non
 *    null risponde senza mai entrare (es. "l'incident del gruppo è comparso,
 *    mi aggancio"). Oltre l'attesa → `RedisLockTimeoutError`: il job BullMQ
 *    ritenta con backoff e al retry la sezione critica dell'altro è finita.
 *  - Il lock viene rilasciato anche se `run` fallisce; un rilascio fallito è
 *    loggato (scade da solo dopo `ttlSeconds`), mai nascosto.
 *
 * Niente fallback silenziosi: Redis irraggiungibile → errore propagato.
 */
import { randomUUID } from 'node:crypto'
import { getSharedRedis } from './bullmq.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'redis-lock' })

export interface RedisLockOptions {
  /** Scadenza automatica del lock: deve superare la durata massima della sezione critica. */
  ttlSeconds: number
  /** Attesa massima di chi trova il lock occupato prima di arrendersi. */
  waitMs:     number
  /** Intervallo di polling di chi attende. */
  pollMs:     number
}

/** Lock ancora occupato dopo `waitMs`: il chiamante (job) deve ritentare. */
export class RedisLockTimeoutError extends Error {
  readonly key: string
  constructor(key: string, waitMs: number, detail: string) {
    super(`Lock ${key} still held by another job after ${waitMs} ms${detail ? ` and ${detail}` : ''} — will retry`)
    this.name = 'RedisLockTimeoutError'
    this.key = key
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** DEL solo se il valore è ancora il token di chi rilascia (GET+DEL atomici). */
export const RELEASE_LOCK_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`

async function tryAcquire(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
  return (await getSharedRedis().set(key, owner, 'EX', ttlSeconds, 'NX')) === 'OK'
}

/**
 * Esegue `run` sotto il lock `key`. `shortcut` (opzionale) viene interrogato a
 * ogni giro di attesa: un valore non null è la risposta di chi non deve
 * entrare. `timeoutDetail` completa il messaggio dell'errore di attesa
 * (es. "no storm incident appeared").
 */
export async function withRedisLock<T>(
  key: string,
  opts: RedisLockOptions,
  run: () => Promise<T>,
  shortcut?: () => Promise<T | null>,
  timeoutDetail = '',
): Promise<T> {
  const owner = randomUUID()
  const deadline = Date.now() + opts.waitMs
  while (!(await tryAcquire(key, owner, opts.ttlSeconds))) {
    if (shortcut) {
      const out = await shortcut()
      if (out !== null) return out
    }
    if (Date.now() >= deadline) throw new RedisLockTimeoutError(key, opts.waitMs, timeoutDetail)
    await sleep(opts.pollMs)
  }
  try {
    return await run()
  } finally {
    try {
      await getSharedRedis().eval(RELEASE_LOCK_LUA, 1, key, owner)
    } catch (err) {
      log.error({ err, key }, `Lock release failed (expires on its own in ${opts.ttlSeconds} s)`)
    }
  }
}
