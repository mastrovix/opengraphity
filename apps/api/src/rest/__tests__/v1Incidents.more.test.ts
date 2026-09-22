/**
 * REST v1 incidents: reading, filters, mixed patches and comments from an API key.
 *
 * Why these behaviours matter:
 *  - every read is scoped to the API key's tenant: an integration must never see
 *    another customer's incidents, even by guessing an id;
 *  - list filters are bound as parameters (never spliced values) so a status
 *    string cannot inject Cypher;
 *  - a comment posted by an integration is an INTERNAL note unless it explicitly
 *    says otherwise (a reply to the requester is a deliberate act), is audited,
 *    and notifies the ticket's audience; a notification failure must not turn a
 *    written comment into a 500.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/ticketCustomFields.js', async (importOriginal) => ({ ...(await importOriginal<object>()), customFieldDefs: vi.fn(async () => []) }))
const setTicketCustomFields = vi.fn(async () => [])
vi.mock('../../graphql/resolvers/ticketCustomFields.js', () => ({ ticketCustomFieldResolvers: { Mutation: { setTicketCustomFields: (...a: unknown[]) => setTicketCustomFields(...(a as [])) } } }))
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: (...a: unknown[]) => logError(...a), info: vi.fn(), debug: vi.fn(), child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}))
vi.mock('../../middleware/apiKeyAuth.js', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { keyId: 'key-1', tenantId: 'tenant-1', permissions: ['*'], rateLimit: 60, name: 'Monitoring bot' } as never
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
const withSessionWrite: unknown[] = []
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>, write?: unknown) => { withSessionWrite.push(write); return fn({ close: vi.fn() }) }),
}))
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../graphql/resolvers/incident.js', () => ({ incidentResolvers: { Mutation: { updateIncident: vi.fn() } } }))
const writeTicketComment = vi.fn()
vi.mock('../../lib/ticketComments.js', () => ({ writeTicketComment: (...a: unknown[]) => writeTicketComment(...a) }))
const notifyCommentAudience = vi.fn()
vi.mock('../../graphql/resolvers/comments.js', () => ({ notifyCommentAudience: (...a: unknown[]) => notifyCommentAudience(...a) }))
const audit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createIncident } = await import('../../services/incidentService.js')
const { incidentResolvers } = await import('../../graphql/resolvers/incident.js')
const { incidentsRouter } = await import('../v1/incidents.js')
const { restErrorHandler } = await import('../errorHandler.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/incidents', incidentsRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, () => { resolve() }) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/incidents`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  withSessionWrite.length = 0
  notifyCommentAudience.mockResolvedValue(undefined)
  audit.mockResolvedValue(undefined)
})

const json = (method: string, url: string, body: unknown) => fetch(url, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const INC = { id: 'inc-1', title: 't', status: 'new', severity: 'low', created_at: 'x', updated_at: 'x' }

describe('GET /api/v1/incidents', () => {
  it('status and severity filters are bound parameters, scoped to the key\'s tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 0 })
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const res = await fetch(`${base}?status=${encodeURIComponent("new' OR 1=1")}&severity=high`)
    expect(res.status).toBe(200)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]! as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('i.status = $status AND i.severity = $severity')
    // The raw value travels as a parameter, never inside the Cypher text.
    expect(cypher).not.toContain('OR 1=1')
    expect(params).toMatchObject({ tenantId: 'tenant-1', status: "new' OR 1=1", severity: 'high' })
  })

  it('no count row → total 0, not a crash', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const body = await (await fetch(base)).json() as { data: unknown[]; meta: { total: number } }
    expect(body).toMatchObject({ data: [], meta: { total: 0 } })
  })
})

describe('GET /api/v1/incidents/:id', () => {
  it('returns the mapped incident with its custom fields, looked up inside the tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: INC })
    const res = await fetch(`${base}/inc-1`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({ id: 'inc-1', title: 't', customFields: {} })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'inc-1', tenantId: 'tenant-1' })
  })
})

describe('POST /api/v1/incidents', () => {
  it.each([
    ['not an array', 'ci-1'],
    ['an array with a non-string', ['ci-1', 7]],
  ])('affectedCIIds %s → 400 before touching the service', async (_l, affectedCIIds) => {
    const res = await json('POST', base, { title: 'Down', affectedCIIds })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/affectedCIIds/)
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('an empty body is a 400 (title required), not a crash', async () => {
    const res = await fetch(base, { method: 'POST' })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/v1/incidents/:id', () => {
  it('no patchable field → 400, nothing written', async () => {
    const res = await json('PATCH', `${base}/inc-1`, {})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/No patchable field/)
    expect(incidentResolvers.Mutation.updateIncident).not.toHaveBeenCalled()
  })

  it('fields AND customFields: both go through the UI resolvers, the answer is re-read after both', async () => {
    vi.mocked(incidentResolvers.Mutation.updateIncident).mockResolvedValueOnce({ id: 'inc-1' } as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { ...INC, title: 'new' } })
    const res = await json('PATCH', `${base}/inc-1`, { title: 'new', customFields: { outcome: 'ok' } })
    expect(res.status).toBe(200)
    expect(incidentResolvers.Mutation.updateIncident).toHaveBeenCalledWith(null, { id: 'inc-1', input: { title: 'new' } }, expect.objectContaining({ tenantId: 'tenant-1' }))
    expect(setTicketCustomFields).toHaveBeenCalled()
    expect(((await res.json()) as { data: Record<string, unknown> }).data['title']).toBe('new')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'inc-1', tenantId: 'tenant-1' })
  })

  it('customFields on an incident that vanished → 404', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await json('PATCH', `${base}/inc-1`, { customFields: { outcome: 'ok' } })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/incidents/:id/comments', () => {
  const url = () => `${base}/inc-1/comments`

  it('default: an INTERNAL note authored by the API key, audited and notified', async () => {
    writeTicketComment.mockResolvedValueOnce({ comment: { id: 'c-1' }, author: null })
    const res = await json('POST', url(), { text: '  checked the logs  ' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ data: { id: 'c-1', text: 'checked the logs', isInternal: true } })
    expect(writeTicketComment.mock.calls[0]![1]).toEqual({
      entityType: 'incident', entityId: 'inc-1', tenantId: 'tenant-1',
      text: 'checked the logs', authorId: 'key-1', authorLabel: 'Monitoring bot', isInternal: true,
    })
    // The write runs in a WRITE session.
    expect(withSessionWrite).toEqual([true])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), 'comment.added', 'Incident', 'inc-1', { commentId: 'c-1', isInternal: true, via: 'api_key' })
    expect(notifyCommentAudience).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }), 'incident', 'inc-1', 'checked the logs', true)
  })

  it('isInternal:false is an explicit public reply', async () => {
    writeTicketComment.mockResolvedValueOnce({ comment: { id: 'c-2' }, author: null })
    const res = await json('POST', url(), { text: 'fixed', isInternal: false })
    expect(((await res.json()) as { data: { isInternal: boolean } }).data.isInternal).toBe(false)
    expect((writeTicketComment.mock.calls[0]![1] as { isInternal: boolean }).isInternal).toBe(false)
  })

  it('isInternal that is not a boolean → 400 (a string "false" must not become a public reply by accident)', async () => {
    const res = await json('POST', url(), { text: 'x', isInternal: 'false' })
    expect(res.status).toBe(400)
    expect(writeTicketComment).not.toHaveBeenCalled()
  })

  it('missing text → 400', async () => {
    const res = await json('POST', url(), {})
    expect(res.status).toBe(400)
    expect(writeTicketComment).not.toHaveBeenCalled()
  })

  it('an incident not in this tenant → 404, no audit, no notification', async () => {
    writeTicketComment.mockResolvedValueOnce(null)
    const res = await json('POST', url(), { text: 'x' })
    expect(res.status).toBe(404)
    expect(audit).not.toHaveBeenCalled()
    expect(notifyCommentAudience).not.toHaveBeenCalled()
  })

  it('a failed notification is logged but the comment is still a 201', async () => {
    writeTicketComment.mockResolvedValueOnce({ comment: { id: 'c-3' }, author: null })
    notifyCommentAudience.mockRejectedValueOnce(new Error('smtp down'))
    const res = await json('POST', url(), { text: 'x' })
    expect(res.status).toBe(201)
    await vi.waitFor(() => { expect(logError).toHaveBeenCalledWith(expect.objectContaining({ incidentId: 'inc-1' }), expect.stringContaining('NOT notified')) })
  })
})
