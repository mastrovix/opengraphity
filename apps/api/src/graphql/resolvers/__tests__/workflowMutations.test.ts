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

const WORKFLOW_ACTION_TYPES_MOCK = [
  'sla_start', 'sla_stop', 'sla_pause', 'sla_resume', 'notify', 'publish_event',
  'schedule_job', 'cancel_job', 'notify_rule', 'create_entity', 'assign_to',
  'update_field', 'call_webhook', 'create_approval_request',
] as const

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
    registerCondition: vi.fn(),
  },
  WORKFLOW_ACTION_TYPES: WORKFLOW_ACTION_TYPES_MOCK,
  isWorkflowActionType: (t: unknown) => typeof t === 'string' && (WORKFLOW_ACTION_TYPES_MOCK as readonly string[]).includes(t),
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
  logger:         { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  workflowLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../lib/audit.js', () => ({
  audit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { executeWorkflowTransition, updateWorkflowStep, assertStepActions } = await import('../workflowMutations.js')
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
        tenantId:    'tenant-1',
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

// ── B0-5: il vocabolario delle azioni è imposto anche in SCRITTURA ───────────
// Dal vivo un passo di «Incident — Security» ha un `create_notification` (il
// vocabolario delle AUTOMAZIONI) che il motore non conosce: la transizione
// passava e l'azione non avveniva. Il motore ora la ferma; qui si chiude la
// porta da cui quel dato è entrato.

describe('azioni dei passi: vocabolario imposto alla scrittura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSession.executeRead.mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockResolvedValue({ records: [] })
  })

  it('assertStepActions: accetta le azioni del vocabolario e il campo non mandato', () => {
    expect(() => assertStepActions(null, 'enter_actions')).not.toThrow()
    expect(() => assertStepActions('[]', 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(JSON.stringify([{ type: 'publish_event', params: { event: 'x.y' } }]), 'enter_actions')).not.toThrow()
  })

  it('assertStepActions: `create_notification` è rifiutato con il vocabolario nel messaggio', () => {
    const err = (() => { try { assertStepActions(JSON.stringify([{ type: 'create_notification', params: {} }]), 'enter_actions dello step "security_review"') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('enter_actions dello step "security_review"[0]')
    expect((err as GraphQLError).message).toContain('"create_notification"')
    expect((err as GraphQLError).message).toContain('publish_event')
  })

  /**
   * Il `target` di un `notify_rule` viene risolto davvero dal dispatcher
   * (A0-1): un bersaglio che non esiste non è più ignorato, fa fallire il job
   * di notifica a ogni ingresso nel passo. Il pannello del designer offriva
   * `role:manager`, un ruolo che l'autenticazione non conosce (D-13).
   */
  it('assertStepActions: il target di notify_rule è validato col vocabolario dei destinatari', () => {
    const at = (target: string) => JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k', channels: ['in_app'], target } }])
    const err = (() => { try { assertStepActions(at('role:manager'), 'enter_actions dello step "triage"') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('enter_actions dello step "triage"[0]')
    expect((err as GraphQLError).message).toMatch(/target "role:manager" non è un destinatario valido/)
    expect((err as GraphQLError).message).toContain('role:admin')
    // i bersagli veri passano, e un notify_rule senza target non viene validato
    expect(() => assertStepActions(at('team_owner'), 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(at('role:operator'), 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k' } }]), 'enter_actions')).not.toThrow()
  })

  it('assertStepActions: JSON non valido e non-lista sono rifiutati', () => {
    expect(() => assertStepActions('{non json', 'enter_actions')).toThrow(/non è JSON valido/)
    expect(() => assertStepActions('{"type":"notify"}', 'enter_actions')).toThrow(/deve essere una lista di azioni/)
  })

  it('updateWorkflowStep: azione ignota → nessuna scrittura', async () => {
    await expect(updateWorkflowStep(null, {
      definitionId: 'def-1', stepName: 'security_review', label: 'Security Review',
      enterActions: JSON.stringify([{ type: 'create_notification', params: { channel: 'in_app' } }]),
    }, ctx)).rejects.toThrow(/create_notification/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('updateWorkflowStep: azioni valide → la scrittura avviene', async () => {
    mockSession.executeWrite.mockResolvedValueOnce({ records: [makeRecord({ s: { properties: { id: 's-1', name: 'security_review', label: 'Security Review', type: 'standard', enter_actions: '[]' } } })] })
    await updateWorkflowStep(null, {
      definitionId: 'def-1', stepName: 'security_review', label: 'Security Review',
      enterActions: JSON.stringify([{ type: 'publish_event', params: { event: 'incident.security_review' } }]),
    }, ctx)
    expect(mockSession.executeWrite).toHaveBeenCalledOnce()
  })
})
