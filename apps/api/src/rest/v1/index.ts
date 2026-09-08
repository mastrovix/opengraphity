/**
 * REST API v1 — main router.
 * Mounts API key auth, rate limiter, all entity sub-routers and the single
 * error middleware (rest/errorHandler.ts) that maps thrown lib/errors.js
 * types to HTTP statuses.
 */
import { Router, type Router as ExpressRouter } from 'express'
import { apiKeyAuth, apiRateLimiter } from '../../middleware/apiKeyAuth.js'
import { incidentsRouter } from './incidents.js'
import { changesRouter } from './changes.js'
import { problemsRouter } from './problems.js'
import { ciRouter } from './ci.js'
import { kbRouter } from './kb.js'
import { importRouter } from './import.js'
import { asyncHandler, restErrorHandler } from '../errorHandler.js'

const router: ExpressRouter = Router()

// All v1 routes require API key auth
router.use(asyncHandler(apiKeyAuth))
router.use(apiRateLimiter)

// Mount entity routers
router.use('/incidents', incidentsRouter)
router.use('/changes',   changesRouter)
router.use('/problems',  problemsRouter)
router.use('/ci',        ciRouter)
router.use('/kb',        kbRouter)
router.use('/import',    importRouter)

// Single error middleware: NotFound → 404, Validation → 400, Forbidden → 403,
// anything else → 500 (generic message, full error logged).
router.use(restErrorHandler)

export { router as v1Router }
