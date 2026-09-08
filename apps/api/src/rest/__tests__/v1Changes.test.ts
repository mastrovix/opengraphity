/**
 * REST v1 changes router over a real Express app: tenant-scoped pagination,
 * 404 on unknown ids, POST delegating to changeCreationService with the
 * API-key context, transitions reusing executeChangeTransition (CONFLICT →
 * 400 TRANSITION_NOT_AVAILABLE), /status deployApproved from step order,
 * /tasks type mapping. Neo4j, services and audit are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ close: vi.fn() })),
}))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn() }))
vi.mock('../../services/changeCreationService.js', () => ({ createChangeRFC: vi.fn() }))
vi.mock('../../graphql/resolvers/change/changeMutations.js', () => ({ executeChangeTransition: vi.fn() }))

const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../lib/audit.js')
const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
const { createChangeRFC } = await import('../../services/changeCreationService.js')
const { executeChangeTransition } = await import('../../graphql/resolvers/change/changeMutations.js')
const { changesRouter } = await import('../v1/changes.js')
const { restErrorHandler } = await import('../errorHandler.js')
const { NotFoundError, ValidationError } = await import('../../lib/errors.js')
const { GraphQLError } = await import('graphql')

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

const changeRow = {
  props: { id: 'chg-1', code: 'CHG0001', title: 'Upgrade DB', why: 'EOL', what: 'pg16', aggregate_risk_score: 7, approval_route: 'cab', approval_status: 'pending', created_at: 'c', updated_at: 'u' },
  phase: 'assessment',
  requester: { id: 'u-req', name: 'Req', email: 'req@x' },
  changeOwner: { id: 'u-own', name: 'Own', email: null },
}

const postJson = (path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('GET /api/v1/changes', () => {
  it('paginates with integer offset/limit and the key tenant; phase filter is a parameter', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 3 })
    vi.mocked(runQuery).mockResolvedValueOnce([changeRow])
    const res = await fetch(`${base}?page=2&limit=5&phase=assessment`)
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<Record<string, unknown>>; meta: unknown }
    expect(body.meta).toEqual({ page: 2, limit: 5, total: 3 })
    expect(body.data[0]).toMatchObject({
      id: 'chg-1', code: 'CHG0001', phase: 'assessment', aggregateRiskScore: 7,
      requester: { id: 'u-req', name: 'Req', email: 'req@x' }, changeOwner: { id: 'u-own', name: 'Own', email: null },
    })
    const [, countCypher, countParams] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(countCypher).toMatch(/wi\.current_step = \$phase/)
    expect(countParams).toEqual({ tenantId: 'tenant-1', phase: 'assessment', offset: 5, limit: 5 })
    const [, listCypher, listParams] = vi.mocked(runQuery).mock.calls[0]!
    expect(listCypher).toMatch(/SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)/)
    expect(listCypher).toMatch(/coalesce\(c\.deleted, false\) = false/)
    expect(listParams).toEqual({ tenantId: 'tenant-1', phase: 'assessment', offset: 5, limit: 5 })
  })

  it('without phase the filter clause is absent and phase param is null', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 0 })
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0 } })
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).not.toMatch(/current_step = \$phase/)
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toMatchObject({ phase: null, offset: 0, limit: 20 })
  })

  it.each(['?limit=0', '?limit=101', '?page=abc', '?page[]=1', '?phase[]=x'])('%s → 400, no query', async (qs) => {
    const res = await fetch(`${base}${qs}`)
    expect(res.status).toBe(400)
    expect((await err(res)).code).toBe('VALIDATION_ERROR')
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/changes/:id', () => {
  it('unknown id → 404 NOT_FOUND', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/chg-404`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'NOT_FOUND', message: 'Change chg-404 not found' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'chg-404', tenantId: 'tenant-1' })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('found → change + affectedCIs with per-CI task summary', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(changeRow)
    vi.mocked(runQuery).mockResolvedValueOnce([{
      ciId: 'ci-1', ciName: 'db-01', riskScore: 4,
      ownerTask: { id: 't1', code: 'AT-1', status: 'done' }, supportTask: null,
      deployPlan: { id: 't2', code: 'DP-1', status: 'open' }, validation: { id: 't3', code: 'VT-1', status: 'done', result: 'pass' },
      deployment: null, review: null,
    }])
    const res = await fetch(`${base}/chg-1`)
    expect(res.status).toBe(200)
    const { data } = await res.json() as { data: { affectedCIs: unknown[]; code: string } }
    expect(data.code).toBe('CHG0001')
    expect(data.affectedCIs).toEqual([{
      ciId: 'ci-1', ciName: 'db-01', riskScore: 4,
      tasks: {
        functional: { code: 'AT-1', status: 'done' }, technical: null,
        planning: { code: 'DP-1', status: 'open' }, validation: { code: 'VT-1', status: 'done', result: 'pass' },
        deployment: null, review: null,
      },
    }])
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ changeId: 'chg-1', tenantId: 'tenant-1', ownerRole: 'owner', supportRole: 'support' })
  })
})

describe('POST /api/v1/changes', () => {
  const valid = { title: 'Upgrade DB', why: 'EOL', what: 'pg16', changeOwner: 'u-own', affectedCIIds: ['ci-1'] }

  it.each([
    [{ ...valid, title: undefined }, /title is required/],
    [{ ...valid, why: '' }, /why is required/],
    [{ ...valid, what: 1 }, /what is required/],
    [{ ...valid, changeOwner: undefined }, /changeOwner is required/],
    [{ ...valid, affectedCIIds: [] }, /affectedCIIds must be a non-empty array/],
    [{ ...valid, affectedCIIds: ['ci-1', 2] }, /affectedCIIds must be a non-empty array/],
    [{ ...valid, affectedCIIds: 'ci-1' }, /affectedCIIds must be a non-empty array/],
  ])('invalid body %j → 400 before the service', async (body, msg) => {
    const res = await postJson('', body)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(msg)
    expect(createChangeRFC).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('delegates to createChangeRFC with the API-key ctx, audits, returns 201 with the reloaded change', async () => {
    vi.mocked(createChangeRFC).mockResolvedValueOnce({ id: 'chg-1', code: 'CHG0001' } as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce(changeRow)
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const res = await postJson('', valid)
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ data: { id: 'chg-1', code: 'CHG0001', affectedCIs: [] } })
    expect(createChangeRFC).toHaveBeenCalledWith(valid, { tenantId: 'tenant-1', userId: 'key-1' })
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'key-1', role: 'operator' }),
      'change_created', 'change', 'chg-1', { code: 'CHG0001', title: 'Upgrade DB', affectedCIIds: ['ci-1'] },
    )
  })

  it('service ValidationError (unknown CI) → 400 with the message, no audit', async () => {
    vi.mocked(createChangeRFC).mockRejectedValueOnce(new ValidationError('CI ci-1 not found in tenant'))
    const res = await postJson('', valid)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/CI ci-1 not found/)
    expect(audit).not.toHaveBeenCalled()
  })

  it('unexpected service error → 500 generic', async () => {
    vi.mocked(createChangeRFC).mockRejectedValueOnce(new Error('bolt refused'))
    const res = await postJson('', valid)
    expect(res.status).toBe(500)
    expect(await err(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })
})

describe('POST /api/v1/changes/:id/transition', () => {
  it('missing toStep → 400, resolver untouched', async () => {
    const res = await postJson('/chg-1/transition', { notes: 'x' })
    expect(res.status).toBe(400)
    expect(executeChangeTransition).not.toHaveBeenCalled()
  })

  it('reuses executeChangeTransition with the operator ctx, audits, returns the reloaded change', async () => {
    vi.mocked(executeChangeTransition).mockResolvedValueOnce({} as never)
    vi.mocked(runQueryOne).mockResolvedValueOnce({ ...changeRow, phase: 'planning' })
    const res = await postJson('/chg-1/transition', { toStep: ' planning ', notes: 'all assessed' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { id: 'chg-1', phase: 'planning' } })
    expect(executeChangeTransition).toHaveBeenCalledWith(
      null,
      { changeId: 'chg-1', toStep: 'planning', notes: 'all assessed' },
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'key-1', role: 'operator', userEmail: 'api-key:key-1' }),
    )
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'change_transition', 'change', 'chg-1', { toStep: 'planning', notes: 'all assessed' })
  })

  it('workflow guard rejection (CONFLICT) → 400 TRANSITION_NOT_AVAILABLE, no audit', async () => {
    vi.mocked(executeChangeTransition).mockRejectedValueOnce(new GraphQLError('Assessment tasks still open', { extensions: { code: 'CONFLICT' } }))
    const res = await postJson('/chg-1/transition', { toStep: 'planning' })
    expect(res.status).toBe(400)
    expect(await err(res)).toEqual({ code: 'TRANSITION_NOT_AVAILABLE', message: 'Assessment tasks still open' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('unknown change from the resolver → 404', async () => {
    vi.mocked(executeChangeTransition).mockRejectedValueOnce(new NotFoundError('Change', 'chg-404'))
    const res = await postJson('/chg-404/transition', { toStep: 'planning' })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/changes/:id/status', () => {
  const steps = [
    { name: 'draft',      isInitial: true,  isTerminal: false, isOpen: true, category: 'draft',      stepOrder: 0 },
    { name: 'assessment', isInitial: false, isTerminal: false, isOpen: true, category: 'assessment', stepOrder: 1 },
    { name: 'deployment', isInitial: false, isTerminal: false, isOpen: true, category: 'deployment', stepOrder: 4 },
    { name: 'review',     isInitial: false, isTerminal: false, isOpen: true, category: 'review',     stepOrder: 5 },
  ]

  it('unknown id → 404', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/chg-404/status`)
    expect(res.status).toBe(404)
    expect(getWorkflowSteps).not.toHaveBeenCalled()
  })

  it.each([
    ['assessment', false],
    ['deployment', true],
    ['review', true],
  ])('phase %s → deployApproved %s (from WorkflowStep order, tenant-scoped)', async (phase, expected) => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ code: 'CHG0001', approvalStatus: 'approved', phase })
    vi.mocked(getWorkflowSteps).mockResolvedValueOnce(steps)
    const res = await fetch(`${base}/chg-1/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { code: 'CHG0001', phase, approvalStatus: 'approved', deployApproved: expected } })
    expect(getWorkflowSteps).toHaveBeenCalledWith(expect.anything(), 'tenant-1', 'change')
  })

  it('legacy change without workflow → phase null, deployApproved false, no step lookup', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ code: null, approvalStatus: null, phase: null })
    const res = await fetch(`${base}/chg-old/status`)
    expect(await res.json()).toEqual({ data: { code: null, phase: null, approvalStatus: null, deployApproved: false } })
    expect(getWorkflowSteps).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/changes/:id/tasks', () => {
  it('unknown id → 404 before any task query', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/chg-404/tasks`)
    expect(res.status).toBe(404)
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('collects the five task sources with functional/technical split and completion fields', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ id: 'chg-1' })
    vi.mocked(runQuery)
      .mockResolvedValueOnce([
        { props: { id: 'a1', code: 'AT-1', status: 'done', responder_role: 'owner', completed_at: 't1' }, ciId: 'ci-1', ciName: 'db-01', team: { id: 'team-1', name: 'DBA' }, completedBy: { id: 'u-1', name: 'Ann', email: 'a@x' } },
        { props: { id: 'a2', code: 'AT-2', status: 'open', responder_role: 'support' }, ciId: 'ci-1', ciName: 'db-01', team: null, completedBy: null },
      ])
      .mockResolvedValueOnce([{ props: { id: 'd1', code: 'DP-1', status: 'open' }, ciId: null, ciName: null, team: null, completedBy: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ props: { id: 'r1', code: 'RV-1', status: 'done', reviewed_at: 't9' }, ciId: 'ci-1', ciName: 'db-01', team: null, completedBy: null }])

    const res = await fetch(`${base}/chg-1/tasks`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [
      { id: 'a1', code: 'AT-1', type: 'functional', status: 'done', ci: { id: 'ci-1', name: 'db-01' }, assignedTeam: { id: 'team-1', name: 'DBA' }, completedBy: { id: 'u-1', name: 'Ann', email: 'a@x' }, completedAt: 't1' },
      { id: 'a2', code: 'AT-2', type: 'technical', status: 'open', ci: { id: 'ci-1', name: 'db-01' }, assignedTeam: null, completedBy: null, completedAt: null },
      { id: 'd1', code: 'DP-1', type: 'planning', status: 'open', ci: null, assignedTeam: null, completedBy: null, completedAt: null },
      { id: 'r1', code: 'RV-1', type: 'review', status: 'done', ci: { id: 'ci-1', name: 'db-01' }, assignedTeam: null, completedBy: null, completedAt: 't9' },
    ] })
    expect(runQuery).toHaveBeenCalledTimes(5)
    for (const call of vi.mocked(runQuery).mock.calls) {
      expect(call[2]).toEqual({ id: 'chg-1', tenantId: 'tenant-1' })
    }
    expect(vi.mocked(runQuery).mock.calls.map((c) => /\[:(HAS_\w+)\]/.exec(c[1])?.[1])).toEqual([
      'HAS_ASSESSMENT', 'HAS_DEPLOY_PLAN', 'HAS_VALIDATION', 'HAS_DEPLOYMENT', 'HAS_REVIEW',
    ])
  })
})
