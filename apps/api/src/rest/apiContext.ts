/**
 * Request-scoped helpers for the REST API v1 (API-key authenticated).
 *
 *  - `apiCtx(req)`: GraphQL-shaped context so resolvers/services/audit can be
 *    reused verbatim from REST. The API key has no user role; REST clients act
 *    as operators (they can read/write tickets but never administer the tenant).
 *  - `apiKeyOf(req)`: the authenticated key, or a loud failure if a route was
 *    mounted without `apiKeyAuth` — never a silently empty tenant.
 *  - `parsePagination(query)`: `page`/`limit` as validated integers. Arrays
 *    (`?page[]=1`), floats, NaN and out-of-range values are a 400, not a NaN
 *    that later surfaces as a Cypher error.
 */
import type { Request } from 'express'
import type { GraphQLContext } from '../context.js'
import type { ApiKeyContext } from '../middleware/apiKeyAuth.js'
import { ValidationError } from '../lib/errors.js'

export const MAX_PAGE_LIMIT = 100
export const DEFAULT_PAGE_LIMIT = 20

export function apiKeyOf(req: Request): ApiKeyContext {
  if (!req.apiKey) throw new Error('REST route reached without apiKeyAuth — check the router mounting')
  return req.apiKey
}

export function apiCtx(req: Request): GraphQLContext {
  const key = apiKeyOf(req)
  return {
    tenantId:  key.tenantId,
    userId:    key.keyId,
    userEmail: `api-key:${key.keyId}`,
    role:      'operator',
  }
}

export interface Pagination { page: number; limit: number; offset: number }

function intParam(raw: unknown, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ValidationError(`${name} must be a positive integer`)
  }
  const n = Number(raw)
  if (n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}`)
  return n
}

export function parsePagination(query: Request['query']): Pagination {
  const page  = intParam(query['page'],  'page',  1, 1, Number.MAX_SAFE_INTEGER)
  const limit = intParam(query['limit'], 'limit', DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT)
  return { page, limit, offset: (page - 1) * limit }
}

/** Optional string query param; arrays/objects are rejected (400). */
export function optionalString(query: Request['query'], name: string): string | undefined {
  const raw = query[name]
  if (raw === undefined || raw === '') return undefined
  if (typeof raw !== 'string') throw new ValidationError(`${name} must be a string`)
  return raw
}

/** Required non-empty string body field (400 when missing). */
export function requiredString(body: Record<string, unknown>, name: string): string {
  const v = body[name]
  if (typeof v !== 'string' || v.trim() === '') throw new ValidationError(`${name} is required`)
  return v
}

/** Optional string body field — present but non-string is a 400. */
export function optionalBodyString(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`)
  return v
}
