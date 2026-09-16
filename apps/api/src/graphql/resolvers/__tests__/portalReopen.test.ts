/**
 * A-08 / A-19 — portal resolvers:
 *  - reopenTicket goes through workflowEngine.transition (never `SET i.status`),
 *    picking a transition the workflow actually offers from the current step;
 *  - no transition back to an open step → ValidationError;
 *  - (createTicket: the priority checks moved with the creation into incidentService — portalCreateTicket.test.ts);
 *  - mapTicket fails loud on a node missing severity/category.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const mockSession = {
  executeRead:  vi.fn(),
  executeWrite: vi.fn(),
  close:        vi.fn().mockResolvedValue(undefined),
}

// I testi che il prodotto scrive nei ticket si risolvono nella lingua del cliente (lib/systemText.ts).
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))
// Verifica «Cosa resta cablato», ondata 1: le severità offerte nel portale.
vi.mock('../../../lib/portalSeverityOptions.js', () => import('../../../lib/__tests__/portalSeverityOptionsFake.js'))
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries: vi.fn(async () => ({ values: ['low', 'medium', 'high', 'critical'], labels: {}, colors: {} })) }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance:          vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:              vi.fn(),
    getAvailableTransitions: vi.fn(),
  },
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getWorkflowSteps:   vi.fn(),
  getInitialStepName: vi.fn().mockResolvedValue('new'),
}))

const { portalResolvers } = await import('../portal.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { getWorkflowSteps } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'end_user', permissions: perms('end_user') }
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

const STEPS = [
  { name: 'new',         isInitial: true,  isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 1 },
  { name: 'in_progress', isInitial: false, isTerminal: false, isOpen: true,  category: 'active',   stepOrder: 2 },
  { name: 'resolved',    isInitial: false, isTerminal: false, isOpen: false, category: 'resolved', stepOrder: 3 },
  { name: 'closed',      isInitial: false, isTerminal: true,  isOpen: false, category: 'closed',   stepOrder: 4 },
]

const ticketProps = { id: 'inc-1', number: 'INC00000001', title: 'T', status: 'in_progress', severity: 'high', category: 'hardware', created_by: 'user-1', created_at: 'a', updated_at: 'b' }

describe('reopenTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockReset()
    vi.mocked(getWorkflowSteps).mockResolvedValue(STEPS)
    mockSession.executeRead
      .mockResolvedValueOnce({ records: [rec({ createdBy: 'user-1', status: 'resolved', instanceId: 'wi-1', labels: ['Incident'] })] })
      .mockResolvedValueOnce({ records: [rec({ props: ticketProps, labels: ['Incident'] })] })
  })

  it('transitions via the engine to an open step the workflow allows (prefers non-initial active)', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([
      { toStep: 'closed',      label: 'Chiudi',  requiresInput: false, inputField: null, condition: null },
      { toStep: 'new',         label: 'Riapri',  requiresInput: false, inputField: null, condition: null },
      { toStep: 'in_progress', label: 'Riapri',  requiresInput: false, inputField: null, condition: null },
    ])
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: true } as never)

    const result = await portalResolvers.Mutation.reopenTicket(null, { ticketId: 'inc-1' }, ctx)

    expect(workflowEngine.transition).toHaveBeenCalledWith(
      mockSession,
      expect.objectContaining({ instanceId: 'wi-1', toStepName: 'in_progress', triggerType: 'manual', triggeredBy: 'user-1', tenantId: 'tenant-1' }),
      expect.objectContaining({ userId: 'user-1' }),
    )
    // The status is synced by the engine — the resolver never writes it itself.
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 'inc-1', status: 'in_progress', type: 'incident' })
  })

  it('no manual transition back to an open step → ValidationError, no write', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([
      { toStep: 'closed', label: 'Chiudi', requiresInput: false, inputField: null, condition: null },
    ])

    const err = await portalResolvers.Mutation.reopenTicket(null, { ticketId: 'inc-1' }, ctx).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toMatch(/no transition from "resolved"/)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('engine failure (concurrent transition) surfaces as ValidationError with the engine message', async () => {
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValueOnce([
      { toStep: 'in_progress', label: 'Riapri', requiresInput: false, inputField: null, condition: null },
    ])
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: false, error: 'Concurrent transition' } as never)

    await expect(portalResolvers.Mutation.reopenTicket(null, { ticketId: 'inc-1' }, ctx)).rejects.toThrow(/Concurrent transition/)
  })

  it('ticket without workflow instance → ValidationError (never a bare status write)', async () => {
    mockSession.executeRead.mockReset()
    mockSession.executeRead.mockResolvedValueOnce({ records: [rec({ createdBy: 'user-1', status: 'resolved', instanceId: null, labels: ['Incident'] })] })

    await expect(portalResolvers.Mutation.reopenTicket(null, { ticketId: 'inc-1' }, ctx)).rejects.toThrow(/no workflow instance/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('not resolved → CONFLICT', async () => {
    mockSession.executeRead.mockReset()
    mockSession.executeRead.mockResolvedValueOnce({ records: [rec({ createdBy: 'user-1', status: 'in_progress', instanceId: 'wi-1', labels: ['Incident'] })] })
    const err = await portalResolvers.Mutation.reopenTicket(null, { ticketId: 'inc-1' }, ctx).then(() => null, (e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('CONFLICT')
  })
})

describe('mapTicket — no invented defaults (A-19)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockSession.executeRead.mockReset() })

  // Category is optional (an incident opened from an alarm has none): null,
  // never an invented "other" (giro nel browser del 14 set 2026).
  it('a node without category reports null, not "other"', async () => {
    mockSession.executeRead.mockResolvedValue({ records: [] })
    mockSession.executeRead.mockResolvedValueOnce({
      records: [rec({ props: { ...ticketProps, category: undefined }, assignedTeam: null, labels: ['Incident'] })],
    })
    await expect(portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)).resolves.toMatchObject({ category: null })
  })

  it('a node without severity still fails loud instead of reporting "medium"', async () => {
    mockSession.executeRead.mockResolvedValueOnce({
      records: [rec({ props: { ...ticketProps, severity: undefined }, assignedTeam: null, labels: ['Incident'] })],
    })
    await expect(portalResolvers.Query.myTicket(null, { id: 'inc-1' }, ctx)).rejects.toThrow(/missing required property 'severity'/)
  })
})
