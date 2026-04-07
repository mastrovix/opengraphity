/**
 * API Key authentication middleware for REST API v1.
 * Reads X-API-Key header, validates against Neo4j ApiKey nodes.
 */
import { createHash, timingSafeEqual } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'

export interface ApiKeyContext {
  keyId:       string
  tenantId:    string
  permissions: string[]
  rateLimit:   number
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyContext
    }
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['x-api-key'] as string | undefined
  if (!key) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing X-API-Key header' } })
    return
  }

  const keyHash = hashKey(key)
  const now = new Date().toISOString()

  // 1. Read-only: find and validate the key
  const readSession = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(readSession, `
      MATCH (k:ApiKey {key_hash: $keyHash, enabled: true})
      WHERE k.expires_at IS NULL OR k.expires_at > $now
      RETURN properties(k) AS props
    `, { keyHash, now })

    if (!row) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } })
      return
    }

    const p = row.props
    const permissions = Array.isArray(p['permissions']) ? p['permissions'] as string[] : []

    req.apiKey = {
      keyId:       p['id']        as string,
      tenantId:    p['tenant_id'] as string,
      permissions,
      rateLimit:   Number(p['rate_limit'] ?? 60),
    }

    // 2. Fire-and-forget write: update usage stats (non-blocking)
    const writeSession = getSession(undefined, 'WRITE')
    runQueryOne(writeSession, `
      MATCH (k:ApiKey {key_hash: $keyHash})
      SET k.last_used_at = $now, k.request_count = coalesce(k.request_count, 0) + 1
      RETURN k.id AS id
    `, { keyHash, now })
      .catch((err: unknown) => logger.error({ err }, '[apiKeyAuth] Failed to update usage stats'))
      .finally(() => writeSession.close().catch(() => { /* ignore */ }))

    next()
  } catch (err) {
    logger.error({ err }, '[apiKeyAuth] Error validating API key')
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Authentication error' } })
  } finally {
    await readSession.close()
  }
}

/**
 * In-memory per-key rate limiter.
 * Resets every minute. No persistence — resets on server restart.
 */
const buckets = new Map<string, { count: number; resetAt: number }>()

setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) { if (v.resetAt <= now) buckets.delete(k) }
}, 60_000)

export function apiRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.apiKey
  if (!ctx) { next(); return }

  const now = Date.now()
  let bucket = buckets.get(ctx.keyId)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60_000 }
    buckets.set(ctx.keyId, bucket)
  }

  bucket.count++
  if (bucket.count > ctx.rateLimit) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Rate limit exceeded (${ctx.rateLimit}/min)`, retry_after: retryAfter } })
    return
  }

  next()
}

/**
 * Permission check middleware factory.
 * Usage: router.get('/incidents', requirePermission('incidents:read'), handler)
 */
export function requirePermission(...scopes: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = req.apiKey
    if (!ctx) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } }); return }
    const missing = scopes.filter(s => !ctx.permissions.includes(s))
    if (missing.length > 0) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: `Missing permissions: ${missing.join(', ')}` } })
      return
    }
    next()
  }
}
