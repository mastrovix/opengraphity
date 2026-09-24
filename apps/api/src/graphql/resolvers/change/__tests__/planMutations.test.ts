/**
 * IL PIANO DI RILASCIO: scrittura e chiusura (22 set 2026).
 *
 * ## Perché non c'erano
 * `change/planMutations.ts` stava all'11%. `planWindows.test.ts` copre la
 * libreria delle finestre; questo file — dove il piano si SALVA — no. È il
 * posto in cui nasce l'inviluppo (`window_start`/`window_end`), e il commento
 * accanto dice perché quel pezzo è delicato:
 *
 *   «Si scrivono QUI e solo qui, nella stessa istruzione dei passi, perché
 *    questa è l'unica funzione del prodotto che scrive passi veri. Un inviluppo
 *    scritto altrove sarebbe la seconda verità che questo commento serve a
 *    impedire.»
 *
 * L'inviluppo è un INDICE, non una verità: la verità resta il JSON dei passi.
 * Serve perché «dammi i piani che toccano questa settimana» non si può chiedere
 * a un JSON, e senza il calendario leggerebbe i piani di tutto il tenant a ogni
 * apertura di pagina.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const txRun = vi.fn()
const runQueryOne = vi.fn()
vi.mock('../../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withSession: (fn: (s: unknown) => unknown) => fn({
    executeWrite: (w: (tx: unknown) => unknown) => w({ run: txRun }),
    executeRead: (w: (tx: unknown) => unknown) => w({ run: txRun }),
  }),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const assertUserInCITeam = vi.fn()
const writeAudit = vi.fn()
const getCIName = vi.fn(async () => 'VM-01')
const computeAggregateRisk = vi.fn()
vi.mock('../../../../services/change/helpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertUserInCITeam: (...a: unknown[]) => assertUserInCITeam(...a),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
  getCIName: (...a: unknown[]) => getCIName(...a),
  computeAggregateRisk: (...a: unknown[]) => computeAggregateRisk(...a),
}))

const evaluateAutoTransitions = vi.fn()
vi.mock('../../../../services/change/autoTransitions.js', () => ({ evaluateAutoTransitions: (...a: unknown[]) => evaluateAutoTransitions(...a) }))

const getInitialStepName = vi.fn()
vi.mock('../../../../lib/workflowHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInitialStepName: (...a: unknown[]) => getInitialStepName(...a),
}))

const { saveDeployPlan, completeDeployPlanTask, validateWindow } = await import('../planMutations.js')
const { TASK_STATUS } = await import('../../../../lib/taskStatus.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: new Set() } as never

const finestra = (start: string, end: string) => ({ start, end })
const passo = (titolo = 'Passo uno') => ({
  title: titolo,
  validationWindow: finestra('2026-10-01T08:00:00Z', '2026-10-01T10:00:00Z'),
  releaseWindow:    finestra('2026-10-02T22:00:00Z', '2026-10-03T02:00:00Z'),
})

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txRun.mockResolvedValue({ records: [] })
  runQueryOne.mockResolvedValue({ ciId: 'ci1', changeId: 'c1', status: TASK_STATUS.PENDING, currentStep: 'assessment', steps: null, props: { id: 'dp1' } })
  getInitialStepName.mockResolvedValue('assessment')
  assertUserInCITeam.mockResolvedValue(undefined)
  writeAudit.mockResolvedValue(undefined)
  computeAggregateRisk.mockResolvedValue(undefined)
  evaluateAutoTransitions.mockResolvedValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('validateWindow — una data senza fuso non è una data', () => {
  it('serve inizio e fine', () => {
    for (const w of [null, { start: '', end: 'x' }, { start: 'x', end: '' }] as never[]) {
      expect(() => validateWindow('F', w)).toThrow(/start and end are required/)
    }
  })

  it('l\'offset è obbligatorio: senza, si leggerebbe nel fuso del SERVER, non del cliente', () => {
    expect(() => validateWindow('F', finestra('2026-10-01T08:00:00', '2026-10-01T10:00:00'))).toThrow()
    expect(() => validateWindow('F', finestra('2026-10-01T08:00:00Z', '2026-10-01T10:00:00Z'))).not.toThrow()
    expect(() => validateWindow('F', finestra('2026-10-01T08:00:00+02:00', '2026-10-01T10:00:00+02:00'))).not.toThrow()
  })

  it('la fine dopo l\'inizio, e mai uguale', () => {
    expect(() => validateWindow('F', finestra('2026-10-01T10:00:00Z', '2026-10-01T08:00:00Z'))).toThrow(/end must come after/)
    expect(() => validateWindow('F', finestra('2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'))).toThrow(/end must come after/)
  })
})

describe('saveDeployPlan — le porte', () => {
  it('un task che non esiste è NOT_FOUND', async () => {
    runQueryOne.mockResolvedValue(null)
    expect((await esito(() => saveDeployPlan(null, { taskId: 'x', steps: [passo()] }, ctx))).code).toBe('NOT_FOUND')
  })

  it('un piano già chiuso non si riscrive', async () => {
    runQueryOne.mockResolvedValue({ ciId: 'ci1', changeId: 'c1', status: TASK_STATUS.COMPLETED, currentStep: 'assessment' })
    const r = await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [passo()] }, ctx))
    expect(r.code).toBe('CONFLICT')
    expect(r.message).toContain('already completed')
  })

  it('si modifica SOLO nel passo iniziale, e il messaggio dice quale è', async () => {
    runQueryOne.mockResolvedValue({ ciId: 'ci1', changeId: 'c1', status: TASK_STATUS.PENDING, currentStep: 'deployment' })
    const r = await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [passo()] }, ctx))
    expect(r.message).toContain('only in the initial step (assessment)')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('lo scrive chi SUPPORTA il CI', async () => {
    assertUserInCITeam.mockRejectedValue(new GraphQLError('no', { extensions: { code: 'FORBIDDEN' } }))
    expect((await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [passo()] }, ctx))).code).toBe('FORBIDDEN')
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
  })

  it('almeno un passo, e ogni passo ha un titolo e due finestre valide', async () => {
    expect((await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [] }, ctx))).message)
      .toContain('At least one step')
    expect((await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [{ ...passo(), title: '  ' }] }, ctx))).message)
      .toContain('the title is required')
    const rotto = { ...passo(), releaseWindow: finestra('2026-10-03T02:00:00Z', '2026-10-02T22:00:00Z') }
    expect((await esito(() => saveDeployPlan(null, { taskId: 'dp1', steps: [rotto] }, ctx))).message)
      .toContain('Step 1')
    expect(txRun).not.toHaveBeenCalled()
  })
})

describe('saveDeployPlan — l\'inviluppo nasce QUI, nella stessa istruzione dei passi', () => {
  it('è la prima e l\'ultima data fra TUTTE le finestre, validazioni comprese', async () => {
    await saveDeployPlan(null, { taskId: 'dp1', steps: [passo('A'), {
      title: 'B',
      validationWindow: finestra('2026-09-30T06:00:00Z', '2026-09-30T07:00:00Z'),
      releaseWindow:    finestra('2026-10-05T20:00:00Z', '2026-10-05T23:00:00Z'),
    }] }, ctx)
    const [cypher, params] = txRun.mock.calls[0] as unknown as [string, Record<string, unknown>]
    // Una sola istruzione: passi e inviluppo insieme, mai due verità.
    expect(String(cypher)).toContain('SET dp.steps = $steps')
    expect(String(cypher)).toContain('dp.window_start = $windowStart, dp.window_end = $windowEnd')
    // Normalizzato in ISO `Z` da `planEnvelope`: il confronto in Cypher e' fra
    // STRINGHE, e un `+02:00` darebbe un ordine alfabetico senza senso.
    expect(params['windowStart']).toBe('2026-09-30T06:00:00.000Z')
    expect(params['windowEnd']).toBe('2026-10-05T23:00:00.000Z')
  })

  it('i titoli si salvano ripuliti, e il piano torna «in corso»', async () => {
    await saveDeployPlan(null, { taskId: 'dp1', steps: [{ ...passo(), title: '  Riavvio  ' }] }, ctx)
    const params = txRun.mock.calls[0]![1] as Record<string, unknown>
    expect(JSON.parse(String(params['steps']))[0].title).toBe('Riavvio')
    expect(String(txRun.mock.calls[0]![0])).toContain(TASK_STATUS.IN_PROGRESS)
  })

  it('nella storia della change finiscono quanti passi e quali', async () => {
    await saveDeployPlan(null, { taskId: 'dp1', steps: [passo('Riavvio'), passo('Verifica')] }, ctx)
    const [, , , azione, , frase, i18n] = writeAudit.mock.calls[0] as unknown as [unknown, unknown, unknown, string, unknown, string, { key: string; params: Record<string, string> }]
    expect(azione).toBe('deploy_plan_saved')
    expect(frase).toContain('"Riavvio", "Verifica"')
    expect(i18n).toMatchObject({ key: 'planSaved', params: { ci: 'VM-01', count: '2' } })
  })
})

describe('completeDeployPlanTask', () => {
  const conPassi = (steps: unknown) =>
    runQueryOne.mockResolvedValue({ ciId: 'ci1', changeId: 'c1', status: TASK_STATUS.PENDING, steps: steps === null ? null : JSON.stringify(steps), props: { id: 'dp1' } })

  it('non si chiude un piano vuoto: almeno un passo va compilato', async () => {
    for (const steps of [null, []]) {
      conPassi(steps)
      const r = await esito(() => completeDeployPlanTask(null, { taskId: 'dp1' }, ctx))
      expect(r.code).toBe('CONFLICT')
      expect(r.message).toContain('At least one step must be filled in')
    }
    expect(txRun).not.toHaveBeenCalled()
  })

  it('né uno già chiuso, né uno di un altro gruppo', async () => {
    runQueryOne.mockResolvedValue({ ciId: 'ci1', changeId: 'c1', status: TASK_STATUS.COMPLETED, steps: '[]' })
    expect((await esito(() => completeDeployPlanTask(null, { taskId: 'dp1' }, ctx))).code).toBe('CONFLICT')

    conPassi([{ title: 'A' }])
    assertUserInCITeam.mockRejectedValue(new GraphQLError('no', { extensions: { code: 'FORBIDDEN' } }))
    expect((await esito(() => completeDeployPlanTask(null, { taskId: 'dp1' }, ctx))).code).toBe('FORBIDDEN')
  })

  it('chiuso: si segna chi e quando, si ricalcola il rischio e si riprovano le transizioni', async () => {
    conPassi([{ title: 'A' }, { title: 'B' }])
    await completeDeployPlanTask(null, { taskId: 'dp1' }, ctx)
    const cypher = String(txRun.mock.calls[0]![0])
    expect(cypher).toContain(TASK_STATUS.COMPLETED)
    expect(cypher).toContain('CREATE (dp)-[:COMPLETED_BY]->(u)')
    expect(computeAggregateRisk).toHaveBeenCalledWith(expect.anything(), 'c1', 't1')
    expect(evaluateAutoTransitions).toHaveBeenCalledTimes(1)
    expect((writeAudit.mock.calls[0]![6] as { params: Record<string, string> }).params).toMatchObject({ count: '2' })
  })
})
