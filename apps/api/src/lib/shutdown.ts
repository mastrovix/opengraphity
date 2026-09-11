/**
 * Spegnimento ordinato dei processi API e worker (revisione 2 · D1.2): una
 * sola sequenza, senza `process.exit` sparsi, testabile con finti.
 *
 * Ordine e regole:
 *  1. HTTP (solo l'API): `close()` smette di accettare connessioni, ma non
 *     chiude quelle keep-alive né gli stream SSE (che non finiscono mai da
 *     soli): si chiudono subito le connessioni inattive e, passata
 *     `httpGraceMs`, tutte le altre; la promessa di `close()` viene ATTESA
 *     davvero — prima era un callback ignorato e i worker si chiudevano sotto
 *     le richieste in volo.
 *  2. Worker BullMQ e consumer di dominio, tutti insieme, entro
 *     `workersTimeoutMs`: `close()` di BullMQ aspetta i job attivi.
 *  3. Se i worker NON si sono fermati in tempo: NON si chiudono code, client
 *     Redis dei lock e driver Neo4j sotto i job ancora in volo (prima
 *     succedeva: rilascio del lock fallito, scritture Neo4j fallite, poi
 *     `process.exit(0)` come se nulla fosse). Si esce con `EXIT_WORKERS_TIMED_OUT`
 *     e un log esplicito: il container viene ricreato dall'orchestratore e i
 *     job interrotti ripartono come stalled (idempotenti per costruzione).
 *  4. Altrimenti si chiudono le risorse condivise (code singleton, scheduler
 *     SLA, connessione degli eventi, driver) e si esce con 0. Una risorsa che
 *     non si chiude è un errore visibile: `EXIT_RESOURCES_FAILED`.
 */
import type { Logger } from 'pino'

export const EXIT_OK = 0
export const EXIT_RESOURCES_FAILED = 1
export const EXIT_WORKERS_TIMED_OUT = 2

/** Il sottoinsieme di `http.Server` che serve qui (Node ≥ 18.2 per closeIdle/AllConnections). */
export interface ClosableHttpServer {
  close(callback?: (err?: Error) => void): unknown
  closeIdleConnections(): void
  closeAllConnections(): void
}

export interface Closable {
  readonly name: string
  close(): Promise<unknown>
}

export interface ShutdownPlan {
  signal: string
  /** Assente nel processo worker. */
  httpServer?: ClosableHttpServer | null
  /** Worker BullMQ e consumer di dominio, chiusi insieme. */
  workers: readonly Closable[]
  /** Risorse condivise, chiuse SOLO se i worker si sono fermati in tempo, nell'ordine dato. */
  resources: readonly Closable[]
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  exit: (code: number) => never
  workersTimeoutMs?: number
  httpGraceMs?: number
}

export const DEFAULT_WORKERS_TIMEOUT_MS = 30_000
export const DEFAULT_HTTP_GRACE_MS = 5_000

/** `close()` come promessa; le connessioni inattive vanno via subito, le altre dopo la grazia. */
export async function closeHttpServer(server: ClosableHttpServer, graceMs: number, log: ShutdownPlan['log']): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()))
  })
  server.closeIdleConnections()
  const grace = setTimeout(() => {
    log.warn({ graceMs }, 'HTTP connections still open after the grace period (keep-alive/SSE): closing them')
    server.closeAllConnections()
  }, graceMs)
  try {
    await closed
  } finally {
    clearTimeout(grace)
  }
}

async function closeWithin(closables: readonly Closable[], timeoutMs: number, log: ShutdownPlan['log']): Promise<{ timedOut: boolean; failed: string[] }> {
  const failed: string[] = []
  const all = Promise.all(closables.map(async (c) => {
    try {
      await c.close()
    } catch (err) {
      failed.push(c.name)
      log.error({ err, closable: c.name }, 'Close failed during shutdown')
    }
  }))
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    all.then(() => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs) }),
  ])
  if (timer) clearTimeout(timer)
  return { timedOut, failed }
}

/** Esegue la sequenza e termina il processo con `plan.exit` (non ritorna mai). */
export async function runGracefulShutdown(plan: ShutdownPlan): Promise<never> {
  const { log } = plan
  const workersTimeoutMs = plan.workersTimeoutMs ?? DEFAULT_WORKERS_TIMEOUT_MS
  const httpGraceMs = plan.httpGraceMs ?? DEFAULT_HTTP_GRACE_MS
  log.info({ signal: plan.signal }, 'Received signal — shutting down gracefully')

  if (plan.httpServer) {
    try {
      await closeHttpServer(plan.httpServer, httpGraceMs, log)
      log.info('HTTP server closed')
    } catch (err) {
      log.error({ err }, 'HTTP server close failed — continuing with the workers')
    }
  }

  const { timedOut, failed } = await closeWithin(plan.workers, workersTimeoutMs, log)
  if (timedOut) {
    log.error({ workersTimeoutMs, workers: plan.workers.map((w) => w.name) },
      'Workers did not stop within the timeout: leaving queues, Redis and Neo4j OPEN under the in-flight jobs and exiting with a non-zero code (the container is recreated; interrupted jobs resume as stalled)')
    return plan.exit(EXIT_WORKERS_TIMED_OUT)
  }
  log.info({ workers: plan.workers.length, failed }, 'Workers and consumers closed')

  let resourcesFailed = false
  for (const r of plan.resources) {
    try {
      await r.close()
      log.info({ resource: r.name }, 'Resource closed')
    } catch (err) {
      resourcesFailed = true
      log.error({ err, resource: r.name }, 'Resource close failed')
    }
  }
  if (resourcesFailed) {
    log.error('Graceful shutdown completed with errors')
    return plan.exit(EXIT_RESOURCES_FAILED)
  }
  log.info('Graceful shutdown completed')
  return plan.exit(EXIT_OK)
}
