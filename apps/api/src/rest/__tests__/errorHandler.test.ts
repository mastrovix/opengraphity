/**
 * A-21: one REST error middleware maps lib/errors.js types to HTTP statuses;
 * page/limit are validated integers (arrays/NaN → 400, never a Cypher error).
 */
import { describe, it, expect, vi } from 'vitest'
import type { Request, Response } from 'express'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { httpStatusForError, restErrorHandler, asyncHandler } from '../errorHandler.js'
import { parsePagination, apiKeyOf, optionalString, requiredString } from '../apiContext.js'
import { NotFoundError, ValidationError, ForbiddenError, ServiceUnavailableError } from '../../lib/errors.js'
import { GraphQLError } from 'graphql'

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, headersSent: false, headers: {} as Record<string, string> } as {
    statusCode: number; body: unknown; headersSent: boolean; headers: Record<string, string>
    status: (n: number) => typeof res; json: (b: unknown) => typeof res; setHeader: (k: string, v: string) => typeof res
  }
  res.status    = (n: number) => { res.statusCode = n; return res }
  res.json      = (b: unknown) => { res.body = b; res.headersSent = true; return res }
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; return res }
  return res
}

const req = { method: 'GET', originalUrl: '/api/v1/x' } as Request

describe('httpStatusForError', () => {
  it.each([
    [new NotFoundError('Incident', 'i-1'), 404, 'NOT_FOUND'],
    [new ValidationError('bad'),           400, 'VALIDATION_ERROR'],
    [new ForbiddenError(),                 403, 'FORBIDDEN'],
    [new GraphQLError('x', { extensions: { code: 'CONFLICT' } }),     400, 'TRANSITION_NOT_AVAILABLE'],
    [new GraphQLError('x', { extensions: { code: 'UNAUTHORIZED' } }), 401, 'UNAUTHORIZED'],
    [new ServiceUnavailableError('busy', 5),                            503, 'SERVICE_UNAVAILABLE'],
  ])('%s → %i %s', (err, status, code) => {
    expect(httpStatusForError(err)).toEqual({ status, code })
  })

  it('untyped errors are not mapped', () => {
    expect(httpStatusForError(new Error('boom'))).toBeNull()
    expect(httpStatusForError(new GraphQLError('x', { extensions: { code: 'INTERNAL_SERVER_ERROR' } }))).toBeNull()
  })
})

describe('restErrorHandler', () => {
  it('typed error → mapped status with its message', () => {
    const res = fakeRes()
    restErrorHandler(new NotFoundError('Change', 'c-9'), req, res as unknown as Response, vi.fn())
    expect(res.statusCode).toBe(404)
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Change c-9 not found' } })
  })

  it('unknown error → 500 with a GENERIC message (internals stay in the log)', () => {
    const res = fakeRes()
    restErrorHandler(new Error('Neo4j: connection refused at bolt://internal:7687'), req, res as unknown as Response, vi.fn())
    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
  })

  it('ServiceUnavailableError → 503 con header Retry-After (capacità esaurita, il client ritenta)', () => {
    const res = fakeRes()
    restErrorHandler(new ServiceUnavailableError('all slots busy', 5), req, res as unknown as Response, vi.fn())
    expect(res.statusCode).toBe(503)
    expect(res.headers['Retry-After']).toBe('5')
    expect(res.body).toEqual({ error: { code: 'SERVICE_UNAVAILABLE', message: 'all slots busy' } })
    // gli altri errori tipizzati non portano Retry-After
    const res2 = fakeRes()
    restErrorHandler(new ValidationError('bad'), req, res2 as unknown as Response, vi.fn())
    expect(res2.headers).toEqual({})
  })

  it('body-parser style 4xx error keeps its status', () => {
    const res = fakeRes()
    restErrorHandler(Object.assign(new Error('Unexpected token'), { status: 400, type: 'entity.parse.failed' }), req, res as unknown as Response, vi.fn())
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
  })

  it('does not write when headers were already sent', () => {
    const res = fakeRes(); res.headersSent = true
    restErrorHandler(new Error('late'), req, res as unknown as Response, vi.fn())
    expect(res.statusCode).toBe(0)
  })
})

describe('asyncHandler', () => {
  it('forwards a rejection to next()', async () => {
    const err = new ValidationError('nope')
    const next = vi.fn()
    asyncHandler(async () => { throw err })(req, fakeRes() as unknown as Response, next)
    await new Promise((r) => setImmediate(r))
    expect(next).toHaveBeenCalledWith(err)
  })
})

describe('parsePagination', () => {
  it('defaults', () => {
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, offset: 0 })
  })
  it('parses and computes offset', () => {
    expect(parsePagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, offset: 20 })
  })
  it.each([
    [{ page: ['1'] },  /page/],       // ?page[]=1
    [{ page: '0' },    /page/],
    [{ page: 'abc' },  /page/],
    [{ page: '1.5' },  /page/],
    [{ limit: '101' }, /limit/],
    [{ limit: '-1' },  /limit/],
    [{ limit: { a: '1' } }, /limit/],
  ])('rejects %j with a ValidationError', (query, re) => {
    expect(() => parsePagination(query as never)).toThrow(ValidationError)
    expect(() => parsePagination(query as never)).toThrow(re)
  })
})

describe('request helpers', () => {
  it('apiKeyOf fails loud when the route was mounted without apiKeyAuth', () => {
    expect(() => apiKeyOf({} as Request)).toThrow(/apiKeyAuth/)
  })
  it('optionalString rejects arrays', () => {
    expect(() => optionalString({ status: ['a'] } as never, 'status')).toThrow(ValidationError)
    expect(optionalString({}, 'status')).toBeUndefined()
  })
  it('requiredString rejects blank/non-string', () => {
    expect(() => requiredString({ title: '  ' }, 'title')).toThrow(/title is required/)
    expect(() => requiredString({ title: 3 }, 'title')).toThrow(ValidationError)
    expect(requiredString({ title: 'x' }, 'title')).toBe('x')
  })
})
