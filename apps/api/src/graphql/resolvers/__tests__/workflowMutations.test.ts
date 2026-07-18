import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

// ── Session mock usato da withSession ─────────────────────────────────────────

const mockSession = {
  executeRead:  vi.fn().mockResolvedValue({ records: [] }),
  executeWrite: vi.fn().mockResolvedValue({ records: [] }),
  close:        vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/events', () => ({
  publish:         vi.fn().mockResolvedValue(undefined),
  getRedisOptions: vi.fn(() => ({})),
}))

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
  },
}))

vi.mock('@opengraphity/notifications', () => ({
  sseManager: { sendToUser: vi.fn() },
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(
    async (fn: (s: unknown) => Promise<unknown>, _write?: boolean) => fn(mockSession),
  ),
  getSession: vi.fn(),
}))

vi.mock('../../../services/incidentService.js', () => ({
  publishIncidentTransition: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/logger.js', () => ({
  logger:         { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../lib/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { executeWorkflowTransition } = await import('../workflowMutations.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { validateRequiredFields } = await import('../../../lib/validateRequiredFields.js')

// ── Test context ──────────────────────────────────────────────────────────────

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator' }

const makeRecord = (map: Record<string, unknown>) => ({
  get: (key: string) => (key in map ? map[key] : null),
})

/** Configura le prime due executeRead per il caso "istanza valida del tenant". */
function primeValidInstance() {
  mockSession.executeRead
    // pre-fetch guard: WorkflowInstance {id, tenant_id} trovata
    .mockResolvedValueOnce({
      records: [makeRecord({ entityData: { id: 'inc-1', title: 'Incident 1' }, assigned_to: null, assigned_team: null })],
    })
    // lookup entity_type per validateRequiredFields
    .mockResolvedValueOnce({ records: [makeRecord({ et: 'incident' })] })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeWorkflowTransition — tenant isolation guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockResolvedValue({ records: [] })
  })

  it('istanza di un altro tenant (0 record) → lancia e NON chiama workflowEngine.transition', async () => {
    // Il pre-fetch matcha WorkflowInstance {id, tenant_id}: 0 record = istanza
    // inesistente o appartenente a un altro tenant.
    mockSession.executeRead.mockResolvedValueOnce({ records: [] })

    await expect(
      executeWorkflowTransition(null, { instanceId: 'wi-other-tenant', toStep: 'assigned' }, ctx),
    ).rejects.toThrow('Workflow instance not found: wi-other-tenant')

    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(validateRequiredFields).not.toHaveBeenCalled()
  })

  it('il guard lancia GraphQLError con code NOT_FOUND', async () => {
    mockSession.executeRead.mockResolvedValueOnce({ records: [] })

    const error = await executeWorkflowTransition(null, { instanceId: 'wi-x', toStep: 'assigned' }, ctx)
      .then(() => null, (e: unknown) => e)

    expect(error).toBeInstanceOf(GraphQLError)
    expect((error as GraphQLError).extensions['code']).toBe('NOT_FOUND')
  })

  it('istanza valida → workflowEngine.transition chiamato con i parametri corretti', async () => {
    primeValidInstance()
    vi.mocked(workflowEngine.transition).mockResolvedValueOnce({ success: true, instance: { id: 'wi-1' } } as never)

    const result = await executeWorkflowTransition(
      null,
      { instanceId: 'wi-1', toStep: 'assigned', notes: 'presa in carico' },
      ctx,
    )

    expect(workflowEngine.transition).toHaveBeenCalledOnce()
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      mockSession,
      {
        instanceId:  'wi-1',
        toStepName:  'assigned',
        triggeredBy: 'user-1',
        triggerType: 'manual',
        notes:       'presa in carico',
      },
      expect.any(Object),
    )
    expect(result).toEqual({ success: true, error: null, instance: { id: 'wi-1' }, actionErrors: null })
  })

  it('istanza valida → valida i required fields con il tenant del contesto', async () => {
    primeValidInstance()

    await executeWorkflowTransition(null, { instanceId: 'wi-1', toStep: 'resolved' }, ctx)

    expect(validateRequiredFields).toHaveBeenCalledOnce()
    expect(validateRequiredFields).toHaveBeenCalledWith(
      mockSession,
      expect.objectContaining({
        entityType: 'incident',
        tenantId:   'tenant-1',
        toStep:     'resolved',
      }),
    )
  })
})
