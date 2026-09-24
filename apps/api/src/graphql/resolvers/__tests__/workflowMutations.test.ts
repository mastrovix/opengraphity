import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

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

/**
 * IL VOCABOLARIO DELLE AZIONI È QUELLO VERO (20 set 2026).
 *
 * Qui c'era una copia scritta a mano, e si era già staccata dalla realtà:
 * elencava `schedule_job` e `cancel_job`, che il motore non ha, e non aveva
 * `create_task`, che il motore ha. Un test che valida contro un vocabolario
 * finto può passare mentre la produzione rifiuta, e viceversa. Il pacchetto
 * si mocka lo stesso — importarlo per intero apre Redis — ma la lista si
 * prende da `packages/workflow/src/types.ts`, che non porta dipendenze.
 */
const { WORKFLOW_ACTION_TYPES: TIPI_VERI, isWorkflowActionType: eUnTipoVero } =
  await import('../../../../../../packages/workflow/src/types.js')

vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: {
    createInstance: vi.fn().mockResolvedValue({ id: 'wi-1' }),
    transition:     vi.fn().mockResolvedValue({ success: true }),
    registerCondition: vi.fn(),
  },
  WORKFLOW_ACTION_TYPES: TIPI_VERI,
  isWorkflowActionType: eUnTipoVero,
}))

// Il pacchetto delle notifiche non si importa per intero (apre Redis): qui
// servono solo le due funzioni di instradamento, con la tabella vera dei
// canali dei passi (revisione totale · G-8).
vi.mock('@opengraphity/notifications', () => ({
  sseManager: { sendToUser: vi.fn() },
  WORKFLOW_STEP_NOTIFY_EVENT: 'workflow.step.entered',
  routableChannels: () => ['in_app', 'email'],
  unroutableChannels: (_t: string, channels: readonly string[]) => channels.filter((c) => c !== 'in_app' && c !== 'email'),
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

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'user@test.io', role: 'operator', permissions: perms('operator') }

const makeRecord = (map: Record<string, unknown>) => ({
  get: (key: string) => (key in map ? map[key] : null),
})

/** Configura le prime due executeRead per il caso "istanza valida del tenant". */
function primeValidInstance() {
  mockSession.executeRead
    // pre-fetch guard: WorkflowInstance {id, tenant_id} trovata
    .mockResolvedValueOnce({
      records: [makeRecord({ entityData: { id: 'inc-1', title: 'Incident 1' }, assigned_to: null, assigned_team: null, entityType: 'incident' })],
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
    expect(result).toEqual({ success: true, error: null, errorKey: null, errorParams: null, instance: { id: 'wi-1' }, actionErrors: null })
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

  /**
   * UN COMPITO SI CREA SOLO ENTRANDO in un passo (rimedio, 20 set 2026). Il
   * motore esegue le azioni di uscita con l'istanza già spostata sul passo
   * NUOVO: un compito creato uscendo da A nascerebbe timbrato «passo B»,
   * quindi non bloccherebbe l'uscita da A — che è il senso della guardia —
   * e bloccherebbe quella da B. Il rifiuto arriva qui, nel disegnatore.
   */
  it('assertStepActions: `create_task` si accetta in ingresso e si rifiuta in uscita', () => {
    const azione = JSON.stringify([{ type: 'create_task', params: { title_template: 'X' } }])
    expect(() => assertStepActions(azione, 'enter_actions', 'enter')).not.toThrow()
    const err = (() => { try { assertStepActions(azione, 'exit_actions dello step "assigned"', 'exit') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toContain('entering a step, not leaving one')
    expect((err as GraphQLError).message).toContain('exit_actions dello step "assigned"[0]')
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
    const err = (() => { try { assertStepActions(at('squadra'), 'enter_actions dello step "triage"') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('enter_actions dello step "triage"[0]')
    expect((err as GraphQLError).message).toMatch(/target "squadra" is not a valid recipient/)
    expect((err as GraphQLError).message).toContain('role:<role>')
    // la forma di un ruolo si controlla qui; che il ruolo esista lo controlla la mutation (assertRolesExist)
    expect(() => assertStepActions(at('role:Manager!'), 'enter_actions')).toThrow(/not a valid recipient/)
    // i bersagli veri passano, e un notify_rule senza target non viene validato
    expect(() => assertStepActions(at('team_owner'), 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(at('role:operator'), 'enter_actions')).not.toThrow()
    expect(() => assertStepActions(JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k' } }]), 'enter_actions')).not.toThrow()
  })

  /**
   * Revisione totale · G-8: la scheda «Notifiche» del passo offriva
   * in_app/slack/teams/email, ma il dispatcher per `workflow.step.entered`
   * instrada solo in_app ed email e LANCIA sugli altri. Un passo con Slack
   * spuntato si salvava e generava un job fallito a ogni ingresso nel passo —
   * visibile solo in Admin → Code — senza nessuna notifica.
   */
  it('assertStepActions: i canali di notify_rule sono quelli consegnabili all\'ingresso in un passo (G-8)', () => {
    const at = (channels: string[]) => JSON.stringify([{ type: 'notify_rule', params: { title_key: 'k', channels, target: 'all' } }])
    const err = (() => { try { assertStepActions(at(['in_app', 'slack']), 'enter_actions dello step "escalated"') } catch (e) { return e } })()
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('enter_actions dello step "escalated"[0]')
    expect((err as GraphQLError).message).toMatch(/channels \[slack\] cannot be delivered/)
    expect((err as GraphQLError).message).toContain('in_app, email')
    expect(() => assertStepActions(at(['teams']), 'enter_actions')).toThrow(/\[teams\]/)
    expect(() => assertStepActions(at(['in_app', 'email']), 'enter_actions')).not.toThrow()
  })

  it('assertStepActions: JSON non valido e non-lista sono rifiutati', () => {
    expect(() => assertStepActions('{non json', 'enter_actions')).toThrow(/is not valid JSON/)
    expect(() => assertStepActions('{"type":"notify"}', 'enter_actions')).toThrow(/must be a list of actions/)
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

describe('executeWorkflowTransition — la frase di un rifiuto', () => {
  it('la chiave e i parametri del motore arrivano al client insieme al messaggio', async () => {
    const { transitionErrorFields } = await import('../../../lib/transitionError.js')
    expect(transitionErrorFields({ error: 'Transition to "closed" is not valid from the current step', errorI18n: { key: 'errors.workflow.transitionNotValid', params: { step: 'closed' } } }))
      .toEqual({
        error: 'Transition to "closed" is not valid from the current step',
        errorKey: 'errors.workflow.transitionNotValid',
        errorParams: [{ name: 'step', value: 'closed' }],
      })
    expect(transitionErrorFields({ error: 'boom' })).toEqual({ error: 'boom', errorKey: null, errorParams: null })
  })
})
