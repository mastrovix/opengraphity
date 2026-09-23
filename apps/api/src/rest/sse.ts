import { Router, type Router as ExpressRouter } from 'express'
import { sseManager } from '@opengraphity/notifications'
import { authMiddleware } from '../middleware/auth.js'

const router: ExpressRouter = Router()

const KEEPALIVE_INTERVAL_MS = 30_000

/**
 * The stream carries the tenant's broadcasts (`target: 'all'`: every incident
 * created, resolved, escalated, with its title): it is the workspace's, like
 * the GraphQL inbox (`myNotifications`, workspace.use). Until 23 Sep 2026 any
 * valid token opened it, a portal end user's included.
 */
const STREAM_PERMISSION = 'workspace.use'

router.get('/sse', authMiddleware, (req, res) => {
  if (!req.user!.permissions.has(STREAM_PERMISSION)) {
    res.status(403).json({ error: `Forbidden: ${STREAM_PERMISSION} is required` })
    return
  }

  // SSE response headers
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering
  res.flushHeaders()

  const { tenantId, userId } = req.user!

  // Register client — sseManager writes directly to res via the write() interface
  const clientId = sseManager.connect(tenantId, userId, {
    write: (data: string) => res.write(data),
  })

  // Send initial connection confirmation
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)

  // Keepalive ping every 30s (SSE comment syntax)
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n')
  }, KEEPALIVE_INTERVAL_MS)

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepalive)
    sseManager.disconnect(clientId)
  })
})

export { router as sseRouter }
