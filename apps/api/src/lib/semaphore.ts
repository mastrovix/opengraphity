/**
 * Semaforo in memoria (per processo) per limitare la concorrenza di risorse
 * costose eseguite dentro una richiesta HTTP — oggi gli isolate V8 del
 * transform script del webhook in ingresso (B3): senza tetto, 100 richieste al
 * minuto per sorgente × un isolate da 8 MB / 5 s ciascuna possono saturare la
 * replica.
 *
 * Semantica:
 *  - `limit` esecuzioni contemporanee; chi arriva oltre entra in una coda FIFO
 *    in memoria e ATTENDE — mai scartato in silenzio.
 *  - Se l'attesa supera `waitMs` il chiamante riceve `SemaphoreTimeoutError`
 *    (una `ServiceUnavailableError`, → 503 + `Retry-After` su REST): il mittente
 *    ritenta, la richiesta non viene persa senza avviso.
 *  - Il permesso va rilasciato SEMPRE (`run` lo fa nel `finally`); un rilascio
 *    doppio è ignorato, così un bug del chiamante non regala permessi extra.
 *
 * È per replica: con N repliche il tetto effettivo è N × limit, il che è
 * corretto (ogni replica protegge la propria CPU/memoria).
 */
import { ServiceUnavailableError } from './errors.js'

/** Attesa in coda oltre `waitMs`: la risorsa è satura, ritentare più tardi. */
export class SemaphoreTimeoutError extends ServiceUnavailableError {
  constructor(name: string, waitMs: number, retryAfterSeconds: number) {
    super(`${name}: all ${name} slots busy for more than ${waitMs} ms — retry later`, retryAfterSeconds)
    this.name = 'SemaphoreTimeoutError'
  }
}

export interface SemaphoreOptions {
  /** Nome della risorsa, solo per i messaggi d'errore. */
  name: string
  /** Esecuzioni contemporanee ammesse (intero ≥ 1). */
  limit: number
  /** Attesa massima in coda prima di `SemaphoreTimeoutError`. */
  waitMs: number
  /** Valore suggerito per `Retry-After` quando l'attesa scade. */
  retryAfterSeconds: number
}

interface Waiter {
  resolve: (release: () => void) => void
  reject:  (err: Error) => void
  timer:   NodeJS.Timeout
}

export class Semaphore {
  readonly name: string
  readonly limit: number
  readonly waitMs: number
  readonly retryAfterSeconds: number
  private activeCount = 0
  private readonly queue: Waiter[] = []

  constructor(opts: SemaphoreOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error(`Semaphore ${opts.name}: limit must be an integer ≥ 1 (got ${String(opts.limit)})`)
    if (!Number.isFinite(opts.waitMs) || opts.waitMs < 0) throw new Error(`Semaphore ${opts.name}: waitMs must be ≥ 0 (got ${String(opts.waitMs)})`)
    this.name = opts.name
    this.limit = opts.limit
    this.waitMs = opts.waitMs
    this.retryAfterSeconds = opts.retryAfterSeconds
  }

  /** Permessi in uso. */
  get active(): number { return this.activeCount }
  /** Chiamanti in coda. */
  get waiting(): number { return this.queue.length }

  /**
   * Ottiene un permesso (subito o dopo l'attesa in coda) e restituisce la
   * funzione di rilascio. Preferire `run`, che rilascia nel `finally`.
   */
  acquire(): Promise<() => void> {
    if (this.activeCount < this.limit) {
      this.activeCount++
      return Promise.resolve(this.makeRelease())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(waiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new SemaphoreTimeoutError(this.name, this.waitMs, this.retryAfterSeconds))
        }, this.waitMs),
      }
      this.queue.push(waiter)
    })
  }

  /** Esegue `fn` sotto un permesso; il permesso torna libero anche se `fn` fallisce. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) {
        // Il permesso passa direttamente al primo in coda: activeCount non cambia.
        clearTimeout(next.timer)
        next.resolve(this.makeRelease())
        return
      }
      this.activeCount--
    }
  }
}
