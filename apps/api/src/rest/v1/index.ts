/**
 * REST API v1 — main router.
 * Mounts API key auth, rate limiter, and all entity sub-routers.
 * Includes global error handler to prevent crashes.
 */
import { Router, type Request, type Response, type NextFunction, type Router as ExpressRouter } from 'express'
import { apiKeyAuth, apiRateLimiter } from '../../middleware/apiKeyAuth.js'
import { incidentsRouter } from './incidents.js'
import { changesRouter } from './changes.js'
import { problemsRouter } from './problems.js'
import { ciRouter } from './ci.js'
import { kbRouter } from './kb.js'
import { logger } from '../../lib/logger.js'

const router: ExpressRouter = Router()

// Wrap async middleware so unhandled rejections become Express errors
function asyncWrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}

// All v1 routes require API key auth
router.use(asyncWrap(apiKeyAuth))
router.use(apiRateLimiter)

// Mount entity routers
router.use('/incidents', incidentsRouter)
router.use('/changes',   changesRouter)
router.use('/problems',  problemsRouter)
router.use('/ci',        ciRouter)
router.use('/kb',        kbRouter)

// Global error handler for v1 routes — catches unhandled errors and returns JSON
router.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: err.message, stack: err.stack?.slice(0, 500), url: req.url, method: req.method }, '[api-v1] Unhandled error')
  if (!res.headersSent) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' } })
  }
})

export { router as v1Router }
