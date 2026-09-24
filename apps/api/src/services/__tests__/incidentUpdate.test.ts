/**
 * incidentService.updateIncident — the fields of an incident, from the page
 * and from the REST API (wave 7 · C1: it was the resolver, which the REST API
 * called; these tests came with it from incident.more.test.ts).
 *
 * Why these matter to a user:
 *  - the update is scoped to the caller's tenant: an id of another customer
 *    is "not found", never an edit;
 *  - required fields are checked on the RESULTING state, so a partial edit
 *    does not fail on the fields it did not touch;
 *  - the description can be emptied, and `status` never moves here — it is
 *    the workflow's;
 *  - `ticket.updated` carries old → new, and nothing is published when the
 *    incident vanished between the read and the write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSession = { close: vi.fn() }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn(), getAvailableTransitions: vi.fn() } }))
vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  getSession: vi.fn(),
}))
vi.mock('../../lib/priority.js', () => ({ resolvePriorityPatch: vi.fn(), resolveNewTicketPriority: vi.fn() }))
vi.mock('../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
  propsToFieldValues: (p: Record<string, unknown>) => ({ ...p }),
}))
vi.mock('../../lib/ticketUpdated.js', () => ({ publishTicketUpdated: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/mappers.js', () => ({ mapIncident: vi.fn((p: Record<string, unknown>) => ({ ...p })) }))
vi.mock('../../lib/publishEvent.js', () => import('../../lib/__tests__/publishEventFake.js'))
vi.mock('../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn(async () => undefined) }))
vi.mock('../ticketTransition.js', () => ({ transitionTicket: vi.fn(), refusalError: vi.fn() }))
vi.mock('../../lib/logger.js', () => {
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => logger }
  return { logger }
})

const { updateIncident } = await import('../incidentService.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { validateRequiredFields } = await import('../../lib/validateRequiredFields.js')
const { resolvePriorityPatch } = await import('../../lib/priority.js')
const { publishTicketUpdated } = await import('../../lib/ticketUpdated.js')

const ctx = { tenantId: 't1', userId: 'u1' }
const CURRENT = { id: 'i1', title: 'Old', description: 'text', impact: 'low', urgency: 'low', severity: 'low', category: 'db' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockReset()
  vi.mocked(runQueryOne).mockReset()
})

describe('updateIncident', () => {
  it('unknown incident in the tenant → NotFound before any validation', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(updateIncident('x', { title: 'n' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'x', tenantId: 't1' })
    expect(validateRequiredFields).not.toHaveBeenCalled()
  })

  it('validates the MERGED state, recomputes priority from the current impact/urgency and publishes old → new', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: CURRENT } as never)
    vi.mocked(resolvePriorityPatch).mockResolvedValueOnce({ severity: 'high', impact: 'high', urgency: 'low' } as never)
    const updated = { ...CURRENT, impact: 'high', severity: 'high' }
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: updated }] as never)

    const out = await updateIncident('i1', { impact: 'high' }, ctx)

    // A partial edit keeps untouched required fields (category) in the check.
    expect(validateRequiredFields).toHaveBeenCalledWith(mockSession, {
      entityType: 'incident', tenantId: 't1', fieldValues: expect.objectContaining({ category: 'db', impact: 'high' }),
    })
    expect(resolvePriorityPatch).toHaveBeenCalledWith('t1', { impact: 'low', urgency: 'low' }, { priority: undefined, impact: 'high', urgency: undefined })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (i:Incident {id: $id, tenant_id: $tenantId})')
    // Status only moves through the workflow, never through this update.
    expect(cypher).not.toMatch(/status\s*:/)
    expect(params).toMatchObject({ id: 'i1', tenantId: 't1', title: null, description: null, descriptionGiven: false, severity: 'high', impact: 'high', urgency: 'low' })
    expect(publishTicketUpdated).toHaveBeenCalledWith(ctx, 'incident', 'i1', CURRENT, updated)
    expect(out).toMatchObject({ id: 'i1', title: 'Old' })
  })

  it('a description present in the input (even null) is written, so it can be cleared', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: CURRENT } as never)
    vi.mocked(resolvePriorityPatch).mockResolvedValueOnce({ severity: null, impact: null, urgency: null } as never)
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { ...CURRENT, description: null } }] as never)
    await updateIncident('i1', { description: undefined, title: 'New' }, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ descriptionGiven: true, description: null, title: 'New' })
  })

  it('incident deleted between read and write → NotFound, nothing published', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: CURRENT } as never)
    vi.mocked(resolvePriorityPatch).mockResolvedValueOnce({ severity: null, impact: null, urgency: null } as never)
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(updateIncident('i1', { title: 'n' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(publishTicketUpdated).not.toHaveBeenCalled()
  })
})
