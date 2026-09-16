/**
 * API Key authentication middleware for REST API v1.
 * Reads X-API-Key header, validates against Neo4j ApiKey nodes.
 */
import { createHash } from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { consumeMinuteRate } from '../lib/webhookRateLimit.js'
import { API_KEY_RATE_LIMIT_MAX, API_KEY_RATE_LIMIT_MIN } from '../lib/apiKeyInput.js'

export interface ApiKeyContext {
  keyId:       string
  tenantId:    string
  permissions: string[]
  rateLimit:   number
  /**
   * Il nome dato alla chiave in Integrazioni: è l'AUTORE di ciò che
   * l'integrazione scrive (revisione totale · D-12 — un commento via REST
   * appariva senza autore, perché `author_id` era l'id della chiave e
   * `lib/commentAuthor.ts` non lo risolve).
   */
  name:        string
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
      // tenant-ok: lookup pre-auth, il tenant è derivato dalla chiave stessa
      MATCH (k:ApiKey {key_hash: $keyHash, enabled: true})
      WHERE k.expires_at IS NULL OR k.expires_at > $now
      RETURN properties(k) AS props
    `, { keyHash, now })

    if (!row) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } })
      return
    }

    const p = row.props
    const rateLimit = Number(p['rate_limit'])
    if (!Number.isInteger(rateLimit) || rateLimit < API_KEY_RATE_LIMIT_MIN || rateLimit > API_KEY_RATE_LIMIT_MAX) {
      // Nessun limite inventato (era `?? 60`): una chiave senza limite valido è mal configurata.
      logger.error({ keyId: p['id'], tenantId: p['tenant_id'], rateLimit: p['rate_limit'] }, '[apiKeyAuth] API key has no valid rate_limit — request refused')
      res.status(500).json({ error: { code: 'API_KEY_MISCONFIGURED', message: 'This API key has no valid request limit: set it again in Integrations' } })
      return
    }
    const rawPerms = p['permissions']
    const permissions: string[] = Array.isArray(rawPerms)
      ? rawPerms as string[]
      : typeof rawPerms === 'string' ? (JSON.parse(rawPerms) as string[]) : []

    req.apiKey = {
      keyId:       p['id']        as string,
      tenantId:    p['tenant_id'] as string,
      permissions,
      rateLimit,
      name:        typeof p['name'] === 'string' && p['name'] ? p['name'] : 'API key',
    }

    // 2. Fire-and-forget write: update usage stats (non-blocking)
    const writeSession = getSession(undefined, 'WRITE')
    runQueryOne(writeSession, `
      // tenant-ok: aggiornamento statistiche della chiave appena autenticata
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

/** La chiave Redis del minuto di una chiave API (stessa finestra del webhook in ingresso). */
export function apiKeyRateKey(tenantId: string, keyId: string, atMs: number): string {
  return `og:apikey:rate:${tenantId}:${keyId}:${Math.floor(atMs / 60_000)}`
}

/**
 * Limite di richieste al minuto per chiave, condiviso fra le repliche (Redis).
 * Prima era una mappa in memoria: con N repliche il limite era N volte più alto
 * e si azzerava a ogni riavvio (revisione totale · D-21). Redis irraggiungibile
 * → 500, mai «limite disattivato».
 */
export function apiRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ctx = req.apiKey
  if (!ctx) { next(); return }
  const now = Date.now()
  consumeMinuteRate(apiKeyRateKey(ctx.tenantId, ctx.keyId, now), ctx.rateLimit, now)
    .then((decision) => {
      if (decision.allowed) { next(); return }
      res.set('Retry-After', String(decision.retryAfterSeconds))
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Rate limit exceeded (${ctx.rateLimit}/min)`, retry_after: decision.retryAfterSeconds } })
    })
    .catch(next)
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
