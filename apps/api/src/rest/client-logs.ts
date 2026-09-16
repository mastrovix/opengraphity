import { Router, type Request, type Response } from 'express'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'

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

async function handleClientLog(req: Request, res: Response): Promise<void> {
  const body = req.body as ClientLogBody
  // authMiddleware always sets req.user before we get here; a missing user is
  // a wiring bug, never a reason to file the entry under a made-up tenant.
  const user = req.user
  if (!user) throw new Error('client-logs reached without authMiddleware — req.user missing')

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

  // M-24: i tetti si applicano qui, una volta, prima di scrivere.
  const data = JSON.stringify({
    ...(body.data ?? {}),
    ...(body.url   ? { url:   cut(body.url, MAX_URL_CHARS) }     : {}),
    ...(body.stack ? { stack: cut(body.stack, MAX_STACK_CHARS) } : {}),
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
          timestamp: body.timestamp ?? new Date().toISOString(),
          level:     body.level,
          message:   cut(body.message, MAX_MESSAGE_CHARS),
          data:      cut(data, MAX_DATA_CHARS),
        },
      ),
    )
    res.status(204).end()
  } finally {
    await session.close()
  }
}

export { router as clientLogRouter }
