import { Router, type Request, type Response } from 'express'
import { type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'

const VALID_LEVELS = ['error', 'warn', 'info'] as const
type LogLevel = (typeof VALID_LEVELS)[number]

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
  (req: Request, res: Response) => void handleClientLog(req, res),
)

async function handleClientLog(req: Request, res: Response): Promise<void> {
  const body = req.body as ClientLogBody

  if (!VALID_LEVELS.includes(body.level as LogLevel)) {
    res.status(400).json({ error: `level must be one of: ${VALID_LEVELS.join(', ')}` })
    return
  }

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
          tenantId:  req.user?.tenantId ?? 'system',
          timestamp: body.timestamp ?? new Date().toISOString(),
          level:     body.level,
          message:   body.message,
          data:      JSON.stringify({
            ...(body.data ?? {}),
            ...(body.url   ? { url:   body.url }   : {}),
            ...(body.stack ? { stack: body.stack } : {}),
            userId: req.user?.userId,
          }),
        },
      ),
    )
    res.status(204).end()
  } finally {
    await session.close()
  }
}

export { router as clientLogRouter }
