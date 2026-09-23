import { Router, type Request, type Response } from 'express'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { consumeMinuteRate } from '../lib/webhookRateLimit.js'
import { registraErroreDelBrowser } from '../lib/serverLogSink.js'

const VALID_LEVELS = ['error', 'warn', 'info'] as const
type LogLevel = (typeof VALID_LEVELS)[number]

/**
 * QUANTO puo essere grande una riga di log del browser
 * (revisione totale · M-24).
 *
 * Non c'era nessun limite oltre a quello del parser JSON di express (512 kB),
 * quindi un client — o una pagina con un errore in un ciclo — poteva riempire
 * Neo4j di `LogEntry` da mezzo mega. Questi tetti sono generosi per quello che
 * il log serve a fare (un messaggio, uno stack, qualche campo di contesto) e
 * quello che sfora si TAGLIA con un segno visibile, invece di far fallire la
 * richiesta: un log che non si scrive perche e troppo lungo e un difetto che
 * si perde, ed e il momento in cui serviva di piu.
 */
const MAX_MESSAGE_CHARS = 4_000
const MAX_STACK_CHARS   = 8_000
const MAX_URL_CHARS     = 2_000
const MAX_DATA_CHARS    = 8_000
/** L'ora dichiarata dal client si conserva, ma non governa niente: basta lo spazio di una data ISO. */
const MAX_TIMESTAMP_CHARS = 40
/** Il segno del taglio: chi legge il log vede che manca un pezzo. */
const TRUNCATED = '… [troncato]'

function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max - TRUNCATED.length) + TRUNCATED
}

interface ClientLogBody {
  level:      string
  message:    string
  data?:      Record<string, unknown>
  url?:       string
  stack?:     string
  timestamp?: string
}

const router: ExpressRouter = Router()

router.post(
  '/logs/client',
  authMiddleware,
  asyncHandler(handleClientLog),
)
router.use(restErrorHandler)

/**
 * IL FRENO (20 set 2026, sera tardi).
 *
 * Questa rotta la chiama CHIUNQUE abbia un account, ed è sempre stata senza
 * limiti: bastava un ciclo per riempire il grafo. Finché nessuno leggeva
 * quelle righe il danno era solo spazio; da stasera le legge un analista, e
 * un archivio che si può riempire a piacere è un archivio che si può
 * avvelenare.
 *
 * Sessanta al minuto per persona: una pagina che va in crisi ne manda una
 * manciata (il canale delle notifiche che cade e si riconnette ne produce
 * una ogni pochi minuti), e chi ne manda una al secondo non sta segnalando
 * un problema.
 */
const LOG_AL_MINUTO_PER_PERSONA = 60

async function handleClientLog(req: Request, res: Response): Promise<void> {
  const body = req.body as ClientLogBody
  // authMiddleware always sets req.user before we get here; a missing user is
  // a wiring bug, never a reason to file the entry under a made-up tenant.
  const user = req.user
  if (!user) throw new Error('client-logs reached without authMiddleware — req.user missing')

  /*
   * Il freno DOPO l'autenticazione: solo il traffico legittimo consuma il
   * secchiello, com'è già per i webhook in ingresso (A-20).
   */
  const ora = Date.now()
  const rate = await consumeMinuteRate(
    `og:clientlog:rate:${user.tenantId}:${user.userId}:${String(Math.floor(ora / 60_000))}`,
    LOG_AL_MINUTO_PER_PERSONA, ora,
  )
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds))
    res.status(429).json({ error: `too many client log entries: ${String(rate.limit)} per minute` })
    return
  }

  if (!VALID_LEVELS.includes(body.level as LogLevel)) {
    res.status(400).json({ error: `level must be one of: ${VALID_LEVELS.join(', ')}` })
    return
  }
  // M-24: un messaggio che non e una stringa non diventa «[object Object]» in
  // un campo di Neo4j — e un client che sbaglia, e glielo si dice.
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    res.status(400).json({ error: 'message must be a non-empty string' })
    return
  }

  /*
   * L'ORA LA DECIDE IL SERVER (20 set 2026, rimedio a).
   *
   * Prima era `body.timestamp ?? now`, senza nessuna validazione, e quel
   * valore finiva in `created_at`, nel `day` dell'archivio di piattaforma e
   * quindi nelle soglie che aprono gli incident e nella finestra della
   * purga. Tre conseguenze, tutte alla portata di qualunque utente
   * autenticato di qualunque cliente: venti POST con lo stesso messaggio
   * aprivano un incident `critical` sulla piattaforma col titolo scelto da
   * chi li mandava; `day: "9999-01-01"` rendeva una riga immortale (sempre
   * dentro la finestra, mai dentro la retention); tre date diverse
   * facevano scattare la soglia «cronico» senza che fosse successo niente.
   *
   * Adesso l'orologio del server è l'unica ora che conta. Quella del client
   * si conserva accanto, perché un browser con l'ora sbagliata è a sua
   * volta un'informazione diagnostica — ma non governa più niente.
   */
  const timestamp = new Date().toISOString()

  // M-24: i tetti si applicano qui, una volta, prima di scrivere.
  const data = JSON.stringify({
    ...(body.data ?? {}),
    ...(body.url   ? { url:   cut(body.url, MAX_URL_CHARS) }     : {}),
    ...(body.stack ? { stack: cut(body.stack, MAX_STACK_CHARS) } : {}),
    ...(typeof body.timestamp === 'string' && body.timestamp !== ''
      ? { clientTimestamp: cut(body.timestamp, MAX_TIMESTAMP_CHARS) }
      : {}),
    userId: user.userId,
  })

  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) =>
      tx.run(
        `CREATE (l:LogEntry {
          id:         randomUUID(),
          tenant_id:  $tenantId,
          timestamp:  $timestamp,
          level:      $level,
          module:     'frontend',
          message:    $message,
          data:       $data,
          created_at: $timestamp
        })`,
        {
          tenantId:  user.tenantId,
          timestamp,
          level:     body.level,
          message:   cut(body.message, MAX_MESSAGE_CHARS),
          data:      cut(data, MAX_DATA_CHARS),
        },
      ),
    )
    /*
     * E la stessa riga, SCRUBBATA, entra nella diagnostica di piattaforma:
     * lì diventa un template senza tenant, e da lì la vedono il connettore
     * degli eventi e l'Autoanalisi. Prima di stasera 1.230 errori di browser
     * non li leggeva nessun analista — e dentro c'era «SSE notification
     * channel down», 1.074 volte, che nessuna pagina diceva.
     */
    // The reporter (tenant and person) only caps how often one person counts: it is not stored.
    registraErroreDelBrowser(body.message, body.level, timestamp, body.stack, `${user.tenantId}/${user.userId}`)
    res.status(204).end()
  } finally {
    await session.close()
  }
}

export { router as clientLogRouter }
