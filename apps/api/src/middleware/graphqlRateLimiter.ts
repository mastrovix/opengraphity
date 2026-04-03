import type { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger.js'

// Bucket entry
interface Bucket { count: number; resetAt: number }

// Limits per operation name (requests per minute, per tenant)
const MUTATION_LIMITS: Record<string, number> = {
  // Heavy — max 5/min per tenant
  triggerSync:             5,
  runAnomalyScanner:       5,
  createSyncSource:        5,
  deleteSyncSource:        5,
  // Moderate — max 30/min per tenant
  createIncident:          30,
  createChange:            30,
  createProblem:           30,
  executeChangeTransition: 30,
}

const store = new Map<string, Bucket>()

function checkLimit(
  tenantId: string,
  operationName: string,
): { allowed: boolean; retryAfterSeconds: number } {
  const limit = MUTATION_LIMITS[operationName]
  if (!limit) return { allowed: true, retryAfterSeconds: 0 }

  const key = `${tenantId}:${operationName}`
  const now = Date.now()
  const windowMs = 60_000

  let bucket = store.get(key)
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs }
    store.set(key, bucket)
  }

  bucket.count++

  if (bucket.count > limit) {
    const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000)
    return { allowed: false, retryAfterSeconds }
  }

  return { allowed: true, retryAfterSeconds: 0 }
}

// Periodic cleanup to avoid memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of store.entries()) {
    if (now > bucket.resetAt) store.delete(key)
  }
}, 60_000).unref()

export function graphqlRateLimiterMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Only apply to GraphQL POST requests
  if (req.method !== 'POST' || !req.path.startsWith('/graphql')) {
    next()
    return
  }

  // Extract operationName — it can come from the JSON body or query string
  const body = req.body as { operationName?: string; query?: string } | undefined
  const operationName = body?.operationName ?? null

  if (!operationName || !MUTATION_LIMITS[operationName]) {
    next()
    return
  }

  // tenantId is not yet in context at middleware level — extract from JWT sub-claim or x-tenant header.
  // We parse the token superficially (no verification, just read claims) for the tenant_id.
  // This is safe because rate limiting is best-effort — we don't rely on it for security.
  const auth = req.headers['authorization'] ?? ''
  const rawToken = auth.startsWith('Bearer ') ? auth.slice(7) : ''

  let tenantId = (req.headers['x-tenant-id'] as string | undefined) ?? 'unknown'
  if (rawToken) {
    try {
      const parts = rawToken.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1]!, 'base64url').toString(),
        ) as Record<string, unknown>
        tenantId = (payload['tenant_id'] ?? payload['sub'] ?? 'unknown') as string
      }
    } catch {
      // ignore — use 'unknown'
    }
  }

  const { allowed, retryAfterSeconds } = checkLimit(tenantId, operationName)

  if (!allowed) {
    logger.warn({ tenantId, operationName }, 'GraphQL rate limit exceeded')
    res.status(429).json({
      errors: [
        {
          message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
          extensions: { code: 'RATE_LIMITED', retryAfterSeconds },
        },
      ],
    })
    return
  }

  next()
}
