/**
 * GET /api/sse (rest/sse.ts): the live channel that pushes notifications to
 * the browser.
 *
 * What a user loses if this regresses:
 *  - the route must sit behind authMiddleware, and the client must be
 *    registered under the tenant and user of the TOKEN — registering under
 *    anything else would deliver one organization's notifications to another;
 *  - the SSE headers (no cache, no nginx buffering) — without them the proxy
 *    holds the events and the bell stays silent until the buffer fills;
 *  - the keepalive every 30s, or idle proxies cut the connection;
 *  - on disconnect the keepalive stops and the client is unregistered, or
 *    every closed tab leaks a timer and a dead writer that the manager keeps
 *    writing to.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Request, Response, NextFunction } from 'express'

const connect = vi.fn((..._a: unknown[]) => 'client-1')
const disconnect = vi.fn()
vi.mock('@opengraphity/notifications', () => ({
  sseManager: {
    connect: (...a: unknown[]) => connect(...a),
    disconnect: (...a: unknown[]) => disconnect(...a),
  },
}))

// A sentinel auth middleware: the test checks it is the one wired in front of the handler.
const authMiddleware = vi.fn((_req: Request, _res: Response, next: NextFunction) => next())
vi.mock('../../middleware/auth.js', () => ({ authMiddleware }))

const { sseRouter } = await import('../sse.js')

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> } }

function sseRoute() {
  const layer = (sseRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === '/sse')
  return layer!.route!
}

function fakeReqRes() {
  const req = Object.assign(new EventEmitter(), { user: { tenantId: 'tenant-a', userId: 'user-1' } })
  const written: string[] = []
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
    flushHeaders: vi.fn(),
    write: vi.fn((data: string) => { written.push(data); return true }),
  }
  return { req, res, written, headers }
}

function open() {
  const ctx = fakeReqRes()
  const handler = sseRoute().stack.at(-1)!.handle
  handler(ctx.req as unknown as Request, ctx.res as unknown as Response, vi.fn())
  return ctx
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

describe('GET /sse', () => {
  it('is a GET route guarded by authMiddleware', () => {
    const route = sseRoute()
    expect(route.methods['get']).toBe(true)
    expect(route.stack[0]!.handle).toBe(authMiddleware)
  })

  it('sends SSE headers (no buffering) and flushes them before any event', () => {
    const { res, headers } = open()
    expect(headers).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    expect(res.flushHeaders.mock.invocationCallOrder[0]!).toBeLessThan(res.write.mock.invocationCallOrder[0]!)
  })

  it('registers the client under the tenant and user of the token and confirms the connection', () => {
    const { written } = open()
    expect(connect).toHaveBeenCalledWith('tenant-a', 'user-1', expect.objectContaining({ write: expect.any(Function) }))
    expect(written[0]).toBe(`data: ${JSON.stringify({ type: 'connected', clientId: 'client-1' })}\n\n`)
  })

  it('the writer handed to the manager writes to THIS response', () => {
    const { written } = open()
    const writer = connect.mock.calls[0]![2] as { write: (d: string) => void }
    writer.write('data: {"type":"notification"}\n\n')
    expect(written.at(-1)).toBe('data: {"type":"notification"}\n\n')
  })

  it('pings every 30 seconds with an SSE comment', () => {
    const { written } = open()
    vi.advanceTimersByTime(29_999)
    expect(written).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(written.at(-1)).toBe(': keepalive\n\n')
    vi.advanceTimersByTime(60_000)
    expect(written.filter((w) => w === ': keepalive\n\n')).toHaveLength(3)
  })

  it('on close: unregisters the client and stops the keepalive', () => {
    const { req, written } = open()
    req.emit('close')
    expect(disconnect).toHaveBeenCalledWith('client-1')
    const before = written.length
    vi.advanceTimersByTime(120_000)
    // No write after the tab went away: the timer is gone.
    expect(written).toHaveLength(before)
  })
})
