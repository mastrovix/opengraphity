/**
 * POST /api/report/stream over a real Express app: the role gate answers a
 * plain JSON 403 BEFORE any SSE header is flushed; missing question → 400;
 * admin/operator get a text/event-stream carrying conversation/chunk/tool/done
 * events built from reportConversation + reportAI (both mocked); a failure
 * inside the conversation becomes an `error` event on the open stream.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { perms } from '../../lib/__tests__/testPermissions.js'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Ondata 6 di «Nulla cablato»: le funzioni AI sono dell'organizzazione; qui tutte accese.
vi.mock('../../lib/aiSettings.js', () => import('../../lib/__tests__/aiSettingsFake.js'))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../services/reportAI.js', () => ({ streamReportAI: vi.fn() }))
vi.mock('../../services/reportConversation.js', () => ({ runReportConversation: vi.fn(), REPORT_QUESTION_MAX_CHARS: 4000 }))
const rate = vi.hoisted(() => ({ allowed: true }))
vi.mock('../../lib/webhookRateLimit.js', () => ({
  consumeMinuteRate: vi.fn(async () => ({ allowed: rate.allowed, count: 1, limit: 10, retryAfterSeconds: 42 })),
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = typeof req.headers['x-test-role'] === 'string' ? req.headers['x-test-role'] : 'operator'
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role, permissions: perms(role) }
    next()
  },
}))

const { getSession } = await import('@opengraphity/neo4j')
const { streamReportAI } = await import('../../services/reportAI.js')
const { runReportConversation } = await import('../../services/reportConversation.js')
const { logger } = await import('../../lib/logger.js')
const { reportStreamRouter, reportStreamRateKey, REPORT_STREAM_PER_MINUTE } = await import('../report-stream.js')
const { consumeMinuteRate } = await import('../../lib/webhookRateLimit.js')

type ConvArgs = Parameters<typeof runReportConversation>[0]

const session = { close: vi.fn().mockResolvedValue(undefined) }

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', reportStreamRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/report/stream`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  rate.allowed = true
  vi.mocked(getSession).mockReturnValue(session as never)
})

const post = (body: unknown, role?: string) => fetch(base, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(role ? { 'x-test-role': role } : {}) },
  body: JSON.stringify(body),
})

/** Parse an SSE body into [event, data] pairs. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  return text.split('\n\n').filter((b) => b.trim()).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? ''
    const data  = /^data: (.*)$/m.exec(block)?.[1] ?? 'null'
    return { event, data: JSON.parse(data) as unknown }
  })
}

describe('POST /api/report/stream — gates before the stream opens', () => {
  // Review of 23 Sep 2026: the route the Reports page uses had no cap, and the model is paid from one key for all.
  it('over the per-person minute cap → 429 with Retry-After, before any stream or model call', async () => {
    rate.allowed = false
    const res = await post({ question: 'How many incidents?' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('42')
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED', limit: REPORT_STREAM_PER_MINUTE, retry_after: 42 } })
    expect(consumeMinuteRate).toHaveBeenCalledWith(reportStreamRateKey('tenant-1', 'user-1'), REPORT_STREAM_PER_MINUTE)
    expect(runReportConversation).not.toHaveBeenCalled()
  })

  it('a question over the cap → 400, nothing saved and nothing asked', async () => {
    const res = await post({ question: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'QUESTION_TOO_LONG', max: 4000 } })
    expect(runReportConversation).not.toHaveBeenCalled()
    expect(consumeMinuteRate).not.toHaveBeenCalled()
  })

  it.each(['viewer', 'approver', 'end_user'])('role %s → 403 JSON, not text/event-stream, nothing run', async (role) => {
    const res = await post({ question: 'How many incidents?' }, role)
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('content-type')).not.toMatch(/text\/event-stream/)
    expect(res.headers.get('cache-control')).not.toBe('no-cache')
    expect(await res.json()).toEqual({ error: `Role '${role}' is not authorized. Requires: report.ai` })
    expect(runReportConversation).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
  })

  it.todo('non-string question (e.g. 42) → 400 — BUG: `question?.trim is not a function` escapes as an unhandled rejection from the fire-and-forget `void handleReportStream` and the request never gets a response (src/rest/report-stream.ts:28, :11)')

  it.each([{}, { question: '   ' }])('missing/blank question %j → 400 JSON', async (body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(await res.json()).toEqual({ error: 'question is required' })
    expect(runReportConversation).not.toHaveBeenCalled()
  })
})

describe('POST /api/report/stream — SSE for admin/operator', () => {
  it.each(['admin', 'operator'])('role %s → 200 text/event-stream with conversation, chunk, tool and done events', async (role) => {
    vi.mocked(runReportConversation).mockImplementation(async (args: ConvArgs) => {
      args.onConversationCreated?.('conv-1')
      const content = await args.ask([], args.question)
      return { conversationId: 'conv-1', message: { id: 'msg-2', role: 'assistant', content, createdAt: '2026-09-08T10:00:00.000Z' } }
    })
    vi.mocked(streamReportAI).mockImplementation(async (_tenantId, _userId, _permissions, _history, _q, onChunk, onTool) => {
      onTool('Querying incidents by severity')
      onChunk('There are ')
      onChunk('12 incidents.')
      return 'There are 12 incidents.'
    })

    const res = await post({ question: 'How many incidents?', conversationId: null }, role)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-accel-buffering')).toBe('no')

    const events = parseSse(await res.text())
    expect(events).toEqual([
      { event: 'conversation', data: { conversationId: 'conv-1' } },
      { event: 'tool',  data: { description: 'Querying incidents by severity' } },
      { event: 'chunk', data: { text: 'There are ' } },
      { event: 'chunk', data: { text: '12 incidents.' } },
      { event: 'done',  data: { message: { id: 'msg-2', role: 'assistant', content: 'There are 12 incidents.', createdAt: '2026-09-08T10:00:00.000Z' }, conversationId: 'conv-1' } },
    ])

    expect(runReportConversation).toHaveBeenCalledWith(expect.objectContaining({
      session, tenantId: 'tenant-1', userId: 'user-1', question: 'How many incidents?', conversationId: null,
    }))
    // With the asker's permissions: the model reads only what their role reads (review of 23 Sep 2026).
    expect(streamReportAI).toHaveBeenCalledWith('tenant-1', expect.any(String), expect.any(Set), [], 'How many incidents?', expect.any(Function), expect.any(Function), expect.any(AbortSignal))
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(session.close).toHaveBeenCalled()
  })

  it('the person goes away mid-answer: the analysis is told to stop, and no error is sent or logged', async () => {
    let seen: AbortSignal | undefined
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    vi.mocked(runReportConversation).mockImplementation(async (a: ConvArgs) => {
      await a.ask([], a.question)
      return { conversationId: 'c', message: { id: 'm', role: 'assistant', content: '', createdAt: '' } } as never
    })
    vi.mocked(streamReportAI).mockImplementation(async (...args: unknown[]) => {
      seen = args[7] as AbortSignal
      ;(args[5] as (t: string) => void)('first words')
      await held
      throw new Error('aborted')
    })
    const ctrl = new AbortController()
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'long one' }), signal: ctrl.signal })
    const reader = res.body!.getReader()
    await reader.read()           // the first chunk arrived: the analysis is running
    ctrl.abort()
    await vi.waitFor(() => expect(seen?.aborted).toBe(true))
    release()
    await vi.waitFor(() => expect(session.close).toHaveBeenCalled())
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('existing conversationId is forwarded unchanged', async () => {
    const message = { id: 'msg-5', role: 'assistant', content: 'ok', createdAt: '2026-09-08T10:00:00.000Z' }
    vi.mocked(runReportConversation).mockResolvedValue({ conversationId: 'conv-9', message })
    const res = await post({ question: 'again?', conversationId: 'conv-9' })
    expect(res.status).toBe(200)
    expect(runReportConversation).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-9' }))
    expect(parseSse(await res.text())).toEqual([{ event: 'done', data: { message, conversationId: 'conv-9' } }])
  })

  it('failure inside the conversation → `error` event on the already-open stream, session closed, logged', async () => {
    vi.mocked(runReportConversation).mockRejectedValue(new Error('model quota exceeded'))
    const res = await post({ question: 'boom' })
    expect(res.status).toBe(200) // headers were already flushed: the error travels in-band
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(parseSse(await res.text())).toEqual([{ event: 'error', data: { message: 'model quota exceeded' } }])
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'report-stream error')
    expect(session.close).toHaveBeenCalled()
  })
})
