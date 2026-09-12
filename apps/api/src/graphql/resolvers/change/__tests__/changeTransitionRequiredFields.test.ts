/**
 * Personalizzazioni, ondata 8 — A8-4 (B-21): `executeChangeTransition` valuta
 * le regole di obbligatorietà del passo di arrivo.
 *
 * Le `FieldRequirementRule` con `workflow_step` erano valutate **solo** da
 * `executeWorkflowTransition`, la mutation generica che le change non usano:
 * una regola «la data di rilascio è obbligatoria entrando in programmata»
 * valeva per un bottone e non per quello delle change, e chi l'aveva
 * configurata non aveva modo di accorgersene.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const session = {
  executeRead:  vi.fn(async (fn: (tx: { run: () => Promise<{ records: unknown[] }> }) => unknown) => fn({ run: async () => ({ records: [] }) })),
  executeWrite: vi.fn(async (fn: (tx: { run: () => Promise<unknown> }) => unknown) => fn({ run: async () => ({ records: [] }) })),
  close: vi.fn().mockResolvedValue(undefined),
}

vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)),
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
  getSession:  vi.fn(() => session),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { transition: vi.fn(async () => ({ success: true })), getAvailableTransitions: vi.fn(async () => []) },
}))
vi.mock('../queries.js', () => ({ change: vi.fn(async () => ({ id: 'chg-1' })) }))
vi.mock('../autoTransitions.js', () => ({
  evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined),
  revertProblemAfterChangeDetached: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../approvalCreation.js', () => ({ assertAllApprovalsSatisfied: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../helpers.js', () => ({
  afterEnterStep: vi.fn().mockResolvedValue(undefined),
  writeAudit:     vi.fn().mockResolvedValue(undefined),
  getNextTaskCodes: vi.fn(),
  assertCIHasOwnerAndSupport: vi.fn(),
  assertInitialStep: vi.fn(),
  getCIName: vi.fn(),
  loadChangeWorkflow: vi.fn(async () => ({
    instanceId: 'wi-1', currentStep: 'valutazione',
    props: { id: 'chg-1', change_type: 'normal', title: 'Aggiornamento firmware', planned_start: null },
  })),
}))
vi.mock('../../../../services/changeCreationService.js', () => ({ createChangeRFC: vi.fn() }))
vi.mock('../../../../lib/workflowHelpers.js', () => ({ getStepPurpose: vi.fn(async () => 'assessment') }))
vi.mock('../../../../lib/workflowTargets.js', () => ({ stepNamesByPurposeOrdered: vi.fn(async () => []) }))
vi.mock('../../../../lib/requireRole.js', () => ({ requireRole: vi.fn() }))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
const validateRequiredFields = vi.fn<(s: unknown, o: Record<string, unknown>) => Promise<void>>(async () => {})
vi.mock('../../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: (s: unknown, o: Record<string, unknown>) => validateRequiredFields(s, o),
  propsToFieldValues: (p: Record<string, unknown>) => ({ ...p }),
}))

const { executeChangeTransition } = await import('../changeMutations.js')
const { workflowEngine } = await import('@opengraphity/workflow')

const ctx = { tenantId: 't1', userId: 'u-1', userEmail: 'op@test.io', role: 'admin' as const }

beforeEach(() => { vi.clearAllMocks(); validateRequiredFields.mockImplementation(async () => {}) })

describe('executeChangeTransition — campi obbligatori del passo di arrivo', () => {
  it('valuta le regole per il passo di ARRIVO, con i valori della change e le note', async () => {
    await executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario', notes: 'finestra notturna' }, ctx)
    expect(validateRequiredFields).toHaveBeenCalledWith(session, expect.objectContaining({
      entityType: 'change',
      tenantId:   't1',
      toStep:     'in_calendario',
    }))
    const opts = validateRequiredFields.mock.calls[0]![1] as { fieldValues: Record<string, unknown> }
    expect(opts.fieldValues['title']).toBe('Aggiornamento firmware')
    expect(opts.fieldValues['resolution_notes']).toBe('finestra notturna')
  })

  it('campo obbligatorio mancante → la transizione NON avviene', async () => {
    validateRequiredFields.mockRejectedValueOnce(new GraphQLError('Il campo "planned_start" è obbligatorio per lo step "in_calendario"', { extensions: { code: 'VALIDATION_ERROR' } }))
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, ctx))
      .rejects.toThrow(/planned_start/)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })
})
