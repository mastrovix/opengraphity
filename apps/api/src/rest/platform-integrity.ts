/**
 * THE GRAPH'S INTEGRITY, SEEN BY WHOEVER RUNS THE PLATFORM (wave 7 · A3).
 *
 * One check for now: no edge joins two different tenants
 * (lib/crossTenantEdges.ts). It reads every relationship of the database, so
 * it runs when asked, not on page load.
 *
 * REST and not GraphQL, like the rest of the console (rest/platform-tenants.ts):
 * the GraphQL schema is bound to a tenant, and this page has none.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { platformAuthMiddleware } from '../auth/platformAuth.js'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { crossTenantEdges } from '../lib/crossTenantEdges.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'platform-integrity' })

const router: ExpressRouter = Router()

router.use('/platform/integrity', platformAuthMiddleware)

router.get('/platform/integrity/cross-tenant-edges', asyncHandler(async (_req: Request, res: Response) => {
  const session = getSession(undefined, 'READ')
  try {
    const started = Date.now()
    const result = await crossTenantEdges(session)
    const durationMs = Date.now() - started
    // Not a routine line: an edge between tenants means a query somewhere wrote across them.
    if (result.total > 0) log.error({ total: result.total, groups: result.groups.slice(0, 10) }, 'Edges between different tenants found')
    res.json({ ...result, checkedAt: new Date().toISOString(), durationMs })
  } finally {
    await session.close()
  }
}))

router.use('/platform/integrity', restErrorHandler)

export { router as platformIntegrityRouter }
