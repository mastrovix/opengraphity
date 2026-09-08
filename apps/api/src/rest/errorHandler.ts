/**
 * REST error handling — one place that turns thrown errors into HTTP replies.
 *
 * Routes are written as plain async functions wrapped in `asyncHandler`: they
 * `throw` the typed errors from lib/errors.js (NotFoundError → 404,
 * ValidationError → 400, ForbiddenError → 403) and never touch `res.status`
 * for failures. Anything else is a 500 with a generic message: the full error
 * (stack included) goes to the log, never to the client.
 *
 * The mapping is the same one GraphQL clients see via `extensions.code`, so a
 * service/resolver reused from REST (incidentService, executeChangeTransition,
 * updateIncident…) reports failures identically on both surfaces.
 */
import type { Request, Response, NextFunction, RequestHandler, ErrorRequestHandler } from 'express'
import { GraphQLError } from 'graphql'
import { logger } from '../lib/logger.js'

export interface RestErrorBody {
  error: { code: string; message: string }
}

/** HTTP status + public code for a GraphQL-typed error; null when not typed. */
export function httpStatusForError(err: unknown): { status: number; code: string } | null {
  if (!(err instanceof GraphQLError)) return null
  const code = err.extensions['code'] as string | undefined
  switch (code) {
    case 'BAD_USER_INPUT': return { status: 400, code: 'VALIDATION_ERROR' }
    case 'NOT_FOUND':      return { status: 404, code: 'NOT_FOUND' }
    case 'FORBIDDEN':      return { status: 403, code: 'FORBIDDEN' }
    case 'UNAUTHORIZED':   return { status: 401, code: 'UNAUTHORIZED' }
    // Workflow guard rejections / unavailable transitions: the client sent a
    // request the current state does not allow. Kept at 400 with the
    // historical code so existing REST clients keep matching on it.
    case 'CONFLICT':       return { status: 400, code: 'TRANSITION_NOT_AVAILABLE' }
    default:               return null
  }
}

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<void>

/** Wrap an async route so a rejection reaches the error middleware. */
export function asyncHandler(fn: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

/** Express error middleware — mount LAST on the REST router. */
export const restErrorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const mapped = httpStatusForError(err)
  const message = err instanceof Error ? err.message : String(err)

  if (mapped) {
    logger.warn({ code: mapped.code, status: mapped.status, message, method: req.method, url: req.originalUrl }, '[rest] request rejected')
    if (!res.headersSent) {
      res.status(mapped.status).json({ error: { code: mapped.code, message } } satisfies RestErrorBody)
    }
    return
  }

  // express.json() body parse failures carry a `status`/`type` — still a client error.
  const bodyParse = err as { status?: number; type?: string }
  if (typeof bodyParse.status === 'number' && bodyParse.status >= 400 && bodyParse.status < 500) {
    logger.warn({ status: bodyParse.status, type: bodyParse.type, message, method: req.method, url: req.originalUrl }, '[rest] malformed request')
    if (!res.headersSent) {
      res.status(bodyParse.status).json({ error: { code: 'BAD_REQUEST', message } } satisfies RestErrorBody)
    }
    return
  }

  logger.error({ err, method: req.method, url: req.originalUrl }, '[rest] unhandled error')
  if (!res.headersSent) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } satisfies RestErrorBody)
  }
}
