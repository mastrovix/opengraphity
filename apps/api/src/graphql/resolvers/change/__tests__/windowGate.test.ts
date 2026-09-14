/**
 * IL COMPORTAMENTO del varco della finestra di rilascio (terza revisione · C1).
 *
 * Il test che c'era (`changeApprovalWindowGate.test.ts`) mockava `requireRole`
 * a `vi.fn()` e `assertAllApprovalsSatisfied` a `async () => {}`: verificava
 * che fossero *chiamati*, mai che facessero qualcosa. Quindi non poteva
 * scoprire né che a un `operator` sulla strada felice serviva il ruolo admin,
 * né che il cammino automatico non aveva il varco affatto.
 *
 * Qui `requireRole` è quello VERO — è una funzione pura, non c'è ragione di
 * mockarla — e si assertisce l'ESITO della regola di dominio, che è un valore,
 * non la lista delle chiamate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getStepPurpose        = vi.fn<(s: unknown, t: string, e: string, step: string) => Promise<string | null>>()
const getStepNamesByPurpose = vi.fn<() => Promise<string[]>>()
const isPreApprovedChangeType = vi.fn<() => Promise<boolean>>()
const assertAllApprovalsSatisfied = vi.fn<() => Promise<void>>()
const areAllApprovalsSatisfied    = vi.fn<() => Promise<boolean>>()
const inc = vi.fn()
const areAllAssessmentsComplete = vi.fn<() => Promise<boolean>>()

vi.mock('../../../../lib/workflowHelpers.js', () => ({ getStepPurpose, getStepNamesByPurpose }))
vi.mock('../../../../lib/changePolicy.js',    () => ({ isPreApprovedChangeType }))
vi.mock('../approvalCreation.js',             () => ({ assertAllApprovalsSatisfied, areAllApprovalsSatisfied }))
vi.mock('../../../../middleware/metrics.js',  () => ({ changeWindowGateBlockedTotal: { inc } }))
vi.mock('../../../../lib/changeAssessments.js', () => ({ areAllAssessmentsComplete }))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}))

const { changeGateOutcome, assertChangeWindowGate, automaticTransitionAllowed } = await import('../windowGate.js')

const session = {} as never
const input = (currentStep: string, toStep: string, changeType = 'normal') => ({
  tenantId: 'c-two', changeId: 'chg-1', changeType, currentStep, toStep,
})
/** Gli scopi dei passi come li vedrebbe il workflow factory. */
const PURPOSES: Record<string, string | null> = {
  assessment: 'assessment', approval: 'approval', scheduled: 'scheduled',
  deployment: 'implementation', review: 'review', senzaScopo: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  getStepPurpose.mockImplementation((_s, _t, _e, step) => Promise.resolve(PURPOSES[step] ?? null))
  getStepNamesByPurpose.mockResolvedValue(['approval'])
  isPreApprovedChangeType.mockResolvedValue(false)
  areAllApprovalsSatisfied.mockResolvedValue(false)
  assertAllApprovalsSatisfied.mockResolvedValue(undefined)
  areAllAssessmentsComplete.mockResolvedValue(true)
})

describe('changeGateOutcome — la regola di dominio, senza attori', () => {
  it('assessment → approval: nessun varco in gioco', async () => {
    await expect(changeGateOutcome(session, input('assessment', 'approval'))).resolves.toEqual({ kind: 'open' })
  })

  it('una change pre-approvata entra nella finestra senza varco', async () => {
    isPreApprovedChangeType.mockResolvedValue(true)
    await expect(changeGateOutcome(session, input('assessment', 'scheduled', 'standard')))
      .resolves.toEqual({ kind: 'open' })
  })

  it.each([['scheduled'], ['deployment']])(
    'entrare in "%s" senza essere pre-approvata chiede le approvazioni', async (to) => {
      await expect(changeGateOutcome(session, input('assessment', to))).resolves.toEqual({ kind: 'needs_approvals' })
    })

  it('entrare nella finestra da un passo SENZA SCOPO chiede comunque le approvazioni', async () => {
    // È il difetto B·N-1: mettere lo scopo del passo di approvazione a
    // «nessuno» spegneva il varco lato partenza. Lato arrivo deve reggere.
    await expect(changeGateOutcome(session, input('senzaScopo', 'scheduled'))).resolves.toEqual({ kind: 'needs_approvals' })
  })

  it('se il cliente non ha NESSUN passo di approvazione lo dice, invece di rifiutare muto', async () => {
    getStepNamesByPurpose.mockResolvedValue([])
    await expect(changeGateOutcome(session, input('assessment', 'scheduled'))).resolves.toEqual({ kind: 'no_approval_step' })
  })

  it('uscire dall\'approvazione verso l\'analisi deve passare dal rigetto', async () => {
    await expect(changeGateOutcome(session, input('approval', 'assessment'))).resolves.toEqual({ kind: 'use_reject_mutation' })
  })

  it('uscire dall\'approvazione in avanti chiede le approvazioni', async () => {
    await expect(changeGateOutcome(session, input('approval', 'scheduled'))).resolves.toEqual({ kind: 'needs_approvals' })
  })

  it('i tipi pre-approvati si leggono SOLO quando un varco è in gioco', async () => {
    await changeGateOutcome(session, input('assessment', 'approval'))
    expect(isPreApprovedChangeType).not.toHaveBeenCalled()
    await changeGateOutcome(session, input('assessment', 'scheduled'))
    expect(isPreApprovedChangeType).toHaveBeenCalledTimes(1)
  })
})

describe('il cammino MANUALE: lancia, e il ruolo è quello vero', () => {
  const ctx = (role: string) => ({ tenantId: 'c-two', userId: 'u1', role }) as never

  it('un operator non entra nella finestra: ForbiddenError da requireRole VERO', async () => {
    await expect(assertChangeWindowGate(session, ctx('operator'), input('assessment', 'scheduled')))
      .rejects.toThrow(/not authorized/i)
    // E si è fermato PRIMA di guardare le approvazioni: il ruolo è la prima porta.
    expect(assertAllApprovalsSatisfied).not.toHaveBeenCalled()
  })

  it('un admin passa il ruolo e arriva al controllo dei requisiti', async () => {
    await assertChangeWindowGate(session, ctx('admin'), input('assessment', 'scheduled'))
    expect(assertAllApprovalsSatisfied).toHaveBeenCalledWith(session, 'chg-1', 'c-two')
  })

  it('e se i requisiti non sono soddisfatti, l\'errore del controllo arriva a chi ha premuto', async () => {
    assertAllApprovalsSatisfied.mockRejectedValue(new Error('Approval incomplete: 2 requirement(s) still pending'))
    await expect(assertChangeWindowGate(session, ctx('admin'), input('assessment', 'scheduled')))
      .rejects.toThrow(/Approval incomplete/)
  })

  it('senza nessun passo di approvazione il messaggio nomina LE DUE uscite', async () => {
    getStepNamesByPurpose.mockResolvedValue([])
    const err = await assertChangeWindowGate(session, ctx('admin'), input('assessment', 'scheduled'))
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/workflow designer/)
    expect(err!.message).toMatch(/pre-approved types/)
    expect(err!.message).toContain('"normal"')
  })

  it('nessun varco in gioco: non chiede né ruolo né requisiti', async () => {
    await assertChangeWindowGate(session, ctx('operator'), input('assessment', 'approval'))
    expect(assertAllApprovalsSatisfied).not.toHaveBeenCalled()
  })
})

describe('i cammini AUTOMATICI: rifiutano, non lanciano', () => {
  it('IL DIFETTO C1: assessment → scheduled automatico senza approvazioni viene RIFIUTATO', async () => {
    // Prima di questa ondata: `true`, e la change entrava nella finestra di
    // rilascio con zero approvazioni, con il log a `info`.
    await expect(automaticTransitionAllowed(session, input('assessment', 'scheduled'), 'auto_transition'))
      .resolves.toBe(false)
    expect(inc).toHaveBeenCalledWith({ path: 'auto_transition', reason: 'needs_approvals' })
  })

  it('e non lancia: l\'operatore che ha chiuso l\'assessment task non deve vedere un errore', async () => {
    // Lanciare qui sarebbe un vicolo cieco nuovo: l'azione dell'operatore è
    // legittima, la configurazione sbagliata non è sua.
    await expect(automaticTransitionAllowed(session, input('assessment', 'scheduled'), 'auto_transition'))
      .resolves.toBe(false)
  })

  it('l\'auto-advance LEGITTIMO continua a funzionare: approvazioni complete → passa', async () => {
    areAllApprovalsSatisfied.mockResolvedValue(true)
    await expect(automaticTransitionAllowed(session, input('approval', 'scheduled'), 'auto_transition'))
      .resolves.toBe(true)
    expect(inc).not.toHaveBeenCalled()
  })

  it('una pre-approvata avanza da sola, come prima', async () => {
    isPreApprovedChangeType.mockResolvedValue(true)
    await expect(automaticTransitionAllowed(session, input('assessment', 'scheduled', 'standard'), 'timer_job'))
      .resolves.toBe(true)
  })

  it('una transizione che non tocca la finestra passa senza leggere niente', async () => {
    await expect(automaticTransitionAllowed(session, input('assessment', 'approval'), 'auto_transition'))
      .resolves.toBe(true)
    expect(areAllApprovalsSatisfied).not.toHaveBeenCalled()
  })

  it('se i requisiti non si possono LEGGERE, rifiuta invece di lanciare', async () => {
    // `areAllApprovalsSatisfied` lancia NOT_FOUND quando la change non esiste
    // piu (cancellata mentre il cammino automatico era in volo). Questa
    // funzione promette di rispondere si o no: trovato eseguendo la verifica
    // dal vivo con un changeId inesistente.
    areAllApprovalsSatisfied.mockRejectedValue(new Error('Change chg-1 non trovata'))
    await expect(automaticTransitionAllowed(session, input('assessment', 'scheduled'), 'auto_transition'))
      .resolves.toBe(false)
    expect(inc).toHaveBeenCalledWith({ path: 'auto_transition', reason: 'needs_approvals' })
  })

  it('senza passo di approvazione rifiuta, e il contatore dice perché', async () => {
    getStepNamesByPurpose.mockResolvedValue([])
    await expect(automaticTransitionAllowed(session, input('assessment', 'deployment'), 'rule_action'))
      .resolves.toBe(false)
    expect(inc).toHaveBeenCalledWith({ path: 'rule_action', reason: 'no_approval_step' })
  })

  it('la variante che LANCIA (azioni delle regole) porta il perché nel messaggio', async () => {
    const { assertAutomaticTransitionAllowed } = await import('../windowGate.js')
    const err = await assertAutomaticTransitionAllowed(session, input('assessment', 'scheduled'), 'rule_action')
      .then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/would enter the release window/)
    expect(err!.message).toMatch(/remove this action from the rule/)
  })
})

/**
 * Giro del 14 set 2026: CHG00000003 (standard) è uscita dall'analisi con il
 * piano di deploy vuoto, da un arco `assessment → scheduled` automatico senza
 * condizione. Dopo l'analisi il piano non si modifica più: la change restava
 * ferma per sempre.
 */
describe('uscire dall\'analisi chiede valutazioni e piano completi, per ogni tipo', () => {
  it.each([['normal', false], ['standard', true]])('tipo %s (pre-approvato: %s) con piano aperto → needs_assessments', async (tipo, preApprovato) => {
    isPreApprovedChangeType.mockResolvedValue(preApprovato)
    areAllAssessmentsComplete.mockResolvedValue(false)
    await expect(changeGateOutcome(session, input('assessment', 'scheduled', tipo))).resolves.toEqual({ kind: 'needs_assessments' })
    await expect(changeGateOutcome(session, input('assessment', 'approval', tipo))).resolves.toEqual({ kind: 'needs_assessments' })
  })

  it('il cammino automatico rifiuta, quello manuale lancia con la sua chiave', async () => {
    isPreApprovedChangeType.mockResolvedValue(true)
    areAllAssessmentsComplete.mockResolvedValue(false)
    await expect(automaticTransitionAllowed(session, input('assessment', 'scheduled', 'standard'), 'auto_transition')).resolves.toBe(false)
    await expect(assertChangeWindowGate(session, { role: 'admin' } as never, input('assessment', 'scheduled', 'standard')))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.change.assessmentsIncomplete' } } })
  })

  it('con tutto completato la pre-approvata esce libera', async () => {
    isPreApprovedChangeType.mockResolvedValue(true)
    await expect(changeGateOutcome(session, input('assessment', 'scheduled', 'standard'))).resolves.toEqual({ kind: 'open' })
  })
})
