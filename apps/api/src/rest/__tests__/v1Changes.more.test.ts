/**
 * REST v1 changes — the edges v1Changes.test.ts leaves open.
 *
 * Why these matter to an integration calling the public API:
 *  - POST: when the change is created but cannot be read back, the caller
 *    must get an error, not a 201 with an empty body it would store as the
 *    new change. The audit entry is already written (the change exists), so
 *    the error is a 500 for someone to look at, not a validation 400.
 *  - transition: a change that disappears between the transition and the
 *    reload (deleted meanwhile) is a 404, not a 200 with `data: undefined`.
 *  - status: `deployApproved` is what a pipeline gates a deploy on. When a
 *    tenant has more than one step with purpose `implementation`, the
 *    EARLIEST one (lowest step order) is the release gate; a step without an
 *    order sorts last instead of being picked by array position. And a
 *    current step without an order cannot be compared: the answer is the safe
 *    `false`, never "approved".
 * Neo4j, services and audit are mocked as in v1Changes.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/ticketCustomFields.js', async (importOriginal) => ({ ...(await importOriginal<object>()), customFieldDefs: vi.fn(async () => []) }))
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/apiKeyAuth.js', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { keyId: 'key-1', tenantId: 'tenant-1', permissions: ['*'], rateLimit: 60 }
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ close: vi.fn() })),
}))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn() }))
vi.mock('../../services/changeCreationService.js', () => ({ createChangeRFC: vi.fn() }))
// The change's own transition, as a service (wave 7 · C1): the REST route no longer calls a resolver.
vi.mock('../../services/change/changeTransition.js', () => ({ transitionChange: vi.fn() }))

const { runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../lib/audit.js')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
const { createChangeRFC } = await import('../../services/changeCreationService.js')
const { transitionChange } = await import('../../services/change/changeTransition.js')
const { changesRouter } = await import('../v1/changes.js')
const { restErrorHandler } = await import('../errorHandler.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/changes', changesRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/changes`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

const postJson = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('POST /api/v1/changes — created but not readable back', () => {
  it('is a 500, never a 201 with an empty change', async () => {
    vi.mocked(createChangeRFC).mockResolvedValueOnce({ id: 'chg-9', code: 'CHG0009' } as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await postJson('', { title: 't', why: 'w', what: 'x', changeOwner: 'u', changeType: 'normal', affectedCIIds: ['ci-1'] })
    expect(res.status).toBe(500)
    // The change does exist at this point, so its creation stays audited.
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'change_created', 'change', 'chg-9', expect.anything())
  })
})

describe('POST /api/v1/changes/:id/transition — change gone before the reload', () => {
  it('answers 404 instead of 200 with no data', async () => {
    vi.mocked(transitionChange).mockResolvedValueOnce({} as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await postJson('/chg-1/transition', { toStep: 'planning' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/changes/:id/status — which step is the release gate', () => {
  const step = (name: string, purpose: string | null, stepOrder: number | undefined) =>
    ({ name, isInitial: false, isTerminal: false, isOpen: true, category: 'active', purpose, stepOrder })

  it.each([
    // Two implementation steps: the earlier one (order 3) is the gate, whatever the array order.
    ['canary', true],
    ['assessment', false],
  ])('phase %s with two implementation steps → deployApproved %s', async (phase, expected) => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ code: 'CHG0001', approvalStatus: 'approved', phase })
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([
      step('assessment', 'assessment', 1),
      step('full-rollout', 'implementation', 6),
      step('unordered-rollout', 'implementation', undefined),
      step('canary', 'implementation', 3),
    ])
    const res = await fetch(`${base}/chg-1/status`)
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { deployApproved: boolean } }).data.deployApproved).toBe(expected)
  })

  it('an implementation step without an order sorts after the ordered ones, both ways round', async () => {
    // The unordered step first in the array: it must not become the gate.
    vi.mocked(runQueryOne).mockResolvedValueOnce({ code: 'CHG0001', approvalStatus: 'approved', phase: 'rollout' })
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([
      step('legacy-rollout', 'implementation', undefined),
      step('rollout', 'implementation', 4),
    ])
    const res = await fetch(`${base}/chg-1/status`)
    expect((await res.json() as { data: { deployApproved: boolean } }).data.deployApproved).toBe(true)
  })

  it('a current step without an order cannot be compared: deployApproved stays false', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ code: 'CHG0001', approvalStatus: 'approved', phase: 'custom' })
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce([
      step('custom', null, undefined),
      step('deployment', 'implementation', 4),
    ])
    const res = await fetch(`${base}/chg-1/status`)
    expect(await res.json()).toEqual({ data: { code: 'CHG0001', phase: 'custom', approvalStatus: 'approved', deployApproved: false } })
  })
})
