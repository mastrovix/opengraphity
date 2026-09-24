/**
 * Revisione delle otto ondate · B·N-1 — **il varco delle approvazioni cadeva
 * insieme al ramo `if`**.
 *
 * Il gate era `if (currentPurpose === 'approval' && targetPurpose !== 'approval')`,
 * con `requirePermission('approval.override')` (prima `requireRole('admin')`) e il controllo dei requisiti **dentro** quel ramo.
 * Il disegnatore offre «nessuno» nella tendina dello scopo — per scelta
 * documentata, un passo senza scopo è legittimo — quindi due clic mettevano lo
 * scopo del passo di approvazione a `null` e il ramo non si apriva più: il
 * pannello Approvazioni restava vuoto (i requisiti non venivano nemmeno creati)
 * e la transizione passava. Verificato dal vivo nella revisione: un utente di
 * ruolo `operator` ha portato una change dal passo di approvazione a quello
 * programmato **senza approvazioni e senza errore**.
 *
 * La difesa non può stare sulla forma del workflow, che il cliente cambia: sta
 * sulla regola di dominio. Entrare nella finestra — `scheduled` o
 * `implementation` — è l'atto di mandare in produzione, e una change non
 * pre-approvata che entra lì deve avere le sue approvazioni soddisfatte, da
 * qualunque passo arrivi e qualunque scopo abbia quel passo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

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
// The pipeline of the transitions (wave 7 · B1) is real here: the gate is one of its
// guards, and this is the change's own button reaching it. The ticket as the pipeline reads it:
vi.mock('@opengraphity/neo4j', () => ({
  runQueryOne: vi.fn(async () => ({
    entityType: 'change', entityId: 'chg-1', currentStep: 'cab_acme',
    props: { id: 'chg-1', change_type: 'normal', title: 'Aggiornamento firmware' }, assignedTo: null, assignedTeam: null, refusalNoted: null,
  })),
  runQuery: vi.fn(async () => []),
  getSession: vi.fn(() => session),
}))
vi.mock('../../../../lib/stepMetadataPreflight.js', () => ({ preflightStepMetadata: vi.fn(async () => {}) }))
vi.mock('../../../../lib/onEnterFields.js', () => ({ applyOnEnterFields: vi.fn(async () => {}) }))
vi.mock('../queries.js', () => ({ change: vi.fn(async () => ({ id: 'chg-1' })) }))
vi.mock('../autoTransitions.js', () => ({
  evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined),
  revertProblemAfterChangeDetached: vi.fn().mockResolvedValue(undefined),
}))
const assertAllApprovalsSatisfied = vi.fn<() => Promise<void>>(async () => {})
vi.mock('../approvalCreation.js', () => ({
  assertAllApprovalsSatisfied: () => assertAllApprovalsSatisfied(),
}))
vi.mock('../helpers.js', () => ({
  afterEnterStep: vi.fn().mockResolvedValue(undefined),
  writeAudit:     vi.fn().mockResolvedValue(undefined),
  getNextTaskCodes: vi.fn(),
  assertCIHasOwnerAndSupport: vi.fn(),
  assertInitialStep: vi.fn(),
  getCIName: vi.fn(),
  loadChangeWorkflow: vi.fn(async () => ({
    instanceId: 'wi-1', currentStep: 'cab_acme',
    props: { id: 'chg-1', change_type: 'normal', title: 'Aggiornamento firmware' },
  })),
}))
vi.mock('../../../../services/changeCreationService.js', () => ({ createChangeRFC: vi.fn() }))

/** Lo scopo di ogni passo, come lo vedrebbe il tenant: il test lo ridefinisce. */
let purposeByStep: Record<string, string | null> = {}
vi.mock('../../../../lib/workflowHelpers.js', () => ({
  getStepPurpose: vi.fn(async (_s: unknown, _t: string, _e: string, step: string) => purposeByStep[step] ?? null),
  // Revisione totale · B-11: il varco guarda anche se il passo di arrivo è
  // terminale (un passo di annullamento è un'uscita, non un ingresso nella
  // finestra di rilascio). Qui nessun passo è terminale.
  getStepRow: vi.fn(async (_s: unknown, _t: string, _e: string, step: string) => ({ name: step, purpose: purposeByStep[step] ?? null, isTerminal: false, category: 'active' })),
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: string, _e: string, purposes: readonly string[]) =>
    Object.entries(purposeByStep).filter(([, p]) => p != null && purposes.includes(p)).map(([name]) => name)),
}))
vi.mock('../../../../lib/workflowTargets.js', () => ({ stepNamesByPurposeOrdered: vi.fn(async () => []) }))
const requirePermission = vi.fn()
vi.mock('../../../../lib/permissions.js', () => ({
  requirePermission: (...a: unknown[]) => requirePermission(...a),
  hasPermission: (ctx: { permissions: ReadonlySet<string> }, p: string) => ctx.permissions.has(p),
}))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))
vi.mock('../../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn(async () => {}),
  validateStepRequirements: vi.fn(async () => {}),
  propsToFieldValues: (p: Record<string, unknown>) => ({ ...p }),
}))
let preApproved: readonly string[] = ['standard']
vi.mock('../../../../lib/changePolicy.js', () => ({
  isPreApprovedChangeType: vi.fn(async (_t: string, type: string | null | undefined) =>
    typeof type === 'string' && preApproved.includes(type)),
}))

const { executeChangeTransition } = await import('../changeMutations.js')
const { workflowEngine } = await import('@opengraphity/workflow')

const admin    = { tenantId: 't1', userId: 'u-1', userEmail: 'adm@test.io', role: 'admin' as const, permissions: perms('admin') }
const operator = { ...admin, role: 'operator' as const, permissions: perms('operator') }

beforeEach(() => {
  vi.clearAllMocks()
  assertAllApprovalsSatisfied.mockImplementation(async () => {})
  preApproved = ['standard']
  // Il workflow del cliente: ha rinominato i passi (l'ondata 4 lo regge), ha
  // DUE livelli di approvazione e ha TOLTO lo scopo a quello da cui la change
  // esce — è la forma in cui il buco si vedeva meglio: un passo di approvazione
  // esiste ancora, quindi non è «configurazione assente», ed è proprio il caso
  // in cui il varco vecchio non scattava.
  purposeByStep = {
    valutazione:     'assessment',
    appr_tecnica:    'approval',
    cab_acme:        null,
    in_calendario:   'scheduled',
    rilascio:        'implementation',
    chiusa:          null,
  }
})

describe('il varco vale anche quando il passo di partenza non ha scopo', () => {
  it('operator porta la change da un passo SENZA scopo alla finestra programmata → rifiutato', async () => {
    assertAllApprovalsSatisfied.mockImplementation(async () => {
      throw new Error('Requisiti di approvazione non ancora creati: la change non può essere approvata')
    })
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, operator))
      .rejects.toThrow(/Requisiti di approvazione non ancora creati/)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('…e il ruolo admin è richiesto, come sul varco di prima', async () => {
    await executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, operator)
      .catch(() => null)
    // The gate sees the person's role and permissions (its refusal names the role).
    expect(requirePermission).toHaveBeenCalledWith({ role: 'operator', permissions: operator.permissions }, 'approval.override')
  })

  it('vale anche entrando nella finestra APERTA (implementation), non solo in quella programmata', async () => {
    assertAllApprovalsSatisfied.mockImplementation(async () => { throw new Error('Approval incomplete: 2 requirement(s) still pending') })
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'rilascio' }, admin))
      .rejects.toThrow(/Approval incomplete/)
  })

  it('approvazioni soddisfatte → la transizione passa', async () => {
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, admin)).resolves.toBeDefined()
    expect(assertAllApprovalsSatisfied).toHaveBeenCalled()
    expect(workflowEngine.transition).toHaveBeenCalled()
  })

  it('una change PRE-APPROVATA non passa dal varco (e non serve essere admin)', async () => {
    preApproved = ['standard', 'normal']
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, operator)).resolves.toBeDefined()
    expect(assertAllApprovalsSatisfied).not.toHaveBeenCalled()
    expect(requirePermission).not.toHaveBeenCalled()
  })

  it('un passo che NON è finestra non è gattato: il varco è sulla regola, non su tutti i passi', async () => {
    purposeByStep['note'] = null
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'note' }, operator)).resolves.toBeDefined()
    expect(assertAllApprovalsSatisfied).not.toHaveBeenCalled()
  })

})

describe('nessun passo di approvazione: il rifiuto nomina le uscite, non è un vicolo cieco', () => {
  // È il caso della revisione portato all'estremo: il cliente ha tolto lo scopo
  // all'UNICO passo di approvazione. Adesso la change non entra in finestra —
  // ma il messaggio deve dire le due strade per uscirne, entrambe raggiungibili
  // dall'interfaccia, altrimenti il fail-loud diventa un muro.
  beforeEach(() => { purposeByStep = { cab_acme: null, in_calendario: 'scheduled' } })

  it('il messaggio nomina lo scopo da assegnare E i tipi pre-approvati', async () => {
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, admin))
      .rejects.toThrow(/no step declares the «Approval» purpose.*workflow designer.*pre-approved/s)
  })

  it('se il cliente pre-approva quel tipo di change, la transizione passa', async () => {
    preApproved = ['standard', 'normal']
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, admin)).resolves.toBeDefined()
  })
})

describe('il varco di prima (uscire dal passo di scopo approval) resta', () => {
  beforeEach(() => { purposeByStep = { cab_acme: 'approval', in_calendario: 'scheduled', valutazione: 'assessment' } })

  it('uscendo dal passo di approvazione i requisiti si controllano una volta sola', async () => {
    await executeChangeTransition(null, { changeId: 'chg-1', toStep: 'in_calendario' }, admin)
    expect(assertAllApprovalsSatisfied).toHaveBeenCalledTimes(1)
  })

  it('verso il passo di valutazione si rimanda a «Rigetta»', async () => {
    await expect(executeChangeTransition(null, { changeId: 'chg-1', toStep: 'valutazione' }, admin))
      .rejects.toThrow(/To reject, use "Reject"/)
  })
})
