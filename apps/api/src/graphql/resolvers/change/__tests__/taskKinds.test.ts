/**
 * I CINQUE TIPI DI COMPITO DI UNA CHANGE, in una tabella sola (22 set 2026).
 *
 * ## Perché non c'erano
 * `change/taskKinds.ts` stava al 2,3%. È il posto dove i cinque tipi —
 * assessment, piano di rilascio, validazione, deployment, review — smettono di
 * essere cinque pezzi di codice e diventano cinque RIGHE di una tabella:
 * etichetta del nodo, relazione, chi l'ha chiuso, cosa si azzera riaprendolo,
 * chi può completarlo, quali esiti accetta.
 *
 * Una tabella così è comoda finché è giusta, e nessuno la controllava. I tre
 * fatti che vale la pena fissare:
 *
 *  1. **riaprire un assessment azzera il rischio**, e solo lui: il punteggio
 *     del CI, quello aggregato e la priorità della change derivano da lì;
 *  2. **completare un compito di fase è per il gruppo previsto DEL CI**, e un
 *     compito che non c'è è NOT_FOUND, non un no-op silenzioso («CI sbagliato,
 *     fase sbagliata, o compito già riaperto?»);
 *  3. **gli esiti sono chiusi**: una validazione è pass o fail, una review
 *     confirmed o rejected, e non si accetta altro.
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

const assertMayReopenTasks = vi.fn()
const assertUserInCITeam = vi.fn()
const writeAudit = vi.fn()
const getCIName = vi.fn(async () => 'VM-01')
const resetChangeRisk = vi.fn()
vi.mock('../../../../services/change/helpers.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertMayReopenTasks: (...a: unknown[]) => assertMayReopenTasks(...a),
  assertUserInCITeam: (...a: unknown[]) => assertUserInCITeam(...a),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
  getCIName: (...a: unknown[]) => getCIName(...a),
  resetChangeRisk: (...a: unknown[]) => resetChangeRisk(...a),
}))

const evaluateAutoTransitions = vi.fn()
vi.mock('../../../../services/change/autoTransitions.js', () => ({
  evaluateAutoTransitions: (...a: unknown[]) => evaluateAutoTransitions(...a),
}))

const { TASK_KINDS, reopenTask, completeTask } = await import('../taskKinds.js')
const { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } = await import('../../../../lib/taskStatus.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() } as never

/** Il Cypher di tutte le scritture di questo giro, in un testo solo. */
const scritture = () => (txRun.mock.calls as Array<[string]>).map((c) => String(c[0])).join('\n---\n')

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  txRun.mockResolvedValue({ records: [{ get: () => 'task-1' }] })
  runQueryOne.mockResolvedValue({ changeId: 'c1', ciId: 'ci1', role: 'owner', props: { id: 'task-1' } })
  assertMayReopenTasks.mockReturnValue(undefined)
  assertUserInCITeam.mockResolvedValue(undefined)
  writeAudit.mockResolvedValue(undefined)
  evaluateAutoTransitions.mockResolvedValue(undefined)
  resetChangeRisk.mockResolvedValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('la tabella dei cinque tipi', () => {
  it('ci sono tutti e cinque, ognuno con la sua etichetta e la sua relazione', () => {
    expect(Object.keys(TASK_KINDS).sort())
      .toEqual(['assessment', 'deploy-plan', 'deployment', 'review', 'validation'])
    for (const [nome, k] of Object.entries(TASK_KINDS)) {
      expect(k.label, nome).toMatch(/^[A-Z]/)
      expect(k.rel, nome).toMatch(/^HAS_/)
      expect(k.byRel, nome).toMatch(/_BY$/)
      expect(typeof k.map, nome).toBe('function')
    }
  })

  it('SOLO l\'assessment azzera il rischio riaprendosi: la priorità della change deriva da lì', () => {
    expect(TASK_KINDS['assessment'].reopen.resetRisk).toBe(true)
    for (const nome of ['deploy-plan', 'validation', 'deployment', 'review'] as const) {
      expect(TASK_KINDS[nome].reopen.resetRisk, nome).toBe(false)
    }
  })

  it('riaprire riporta allo stato aperto DEL TIPO, e azzera i campi di quel tipo', () => {
    expect(TASK_KINDS['assessment'].reopen).toMatchObject({ status: TASK_STATUS.IN_PROGRESS, clear: ['score', 'completed_at'] })
    expect(TASK_KINDS['validation'].reopen).toMatchObject({ status: TASK_STATUS.PENDING, clear: ['result', 'tested_at'] })
    expect(TASK_KINDS['review'].reopen).toMatchObject({ status: TASK_STATUS.PENDING, clear: ['result', 'reviewed_at'] })
  })

  it('i due che NON si completano con `completeTask` non dichiarano un `complete`', () => {
    expect(TASK_KINDS['assessment'].complete).toBeUndefined()
    expect(TASK_KINDS['deploy-plan'].complete).toBeUndefined()
    for (const nome of ['validation', 'deployment', 'review'] as const) {
      expect(TASK_KINDS[nome].complete, nome).toBeDefined()
    }
  })

  it('gli esiti sono CHIUSI, e il gruppo che può completare è dichiarato', () => {
    expect(TASK_KINDS['validation'].complete).toMatchObject({
      role: 'owner', allowedResults: [VALIDATION_RESULT.PASS, VALIDATION_RESULT.FAIL],
    })
    expect(TASK_KINDS['review'].complete).toMatchObject({
      role: 'owner', allowedResults: [REVIEW_RESULT.CONFIRMED, REVIEW_RESULT.REJECTED],
    })
    // Il deployment lo conferma chi SUPPORTA il CI, e non ha un esito.
    expect(TASK_KINDS['deployment'].complete).toMatchObject({ role: 'support' })
    expect(TASK_KINDS['deployment'].complete?.allowedResults).toBeUndefined()
  })
})

describe('reopenTask', () => {
  it('serve il permesso di riaprire, e si chiede PRIMA di leggere', async () => {
    assertMayReopenTasks.mockImplementation(() => { throw new GraphQLError('no', { extensions: { code: 'FORBIDDEN' } }) })
    expect((await esito(() => reopenTask('validation', 'v1', 'motivo', ctx))).code).toBe('FORBIDDEN')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('un compito che non esiste (o su una change cancellata) è NOT_FOUND', async () => {
    runQueryOne.mockResolvedValue(null)
    expect((await esito(() => reopenTask('validation', 'v9', 'motivo', ctx))).code).toBe('NOT_FOUND')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('riaperto: lo stato torna quello del tipo, i campi si azzerano e chi l\'aveva chiuso si stacca', async () => {
    await reopenTask('validation', 'v1', 'il test era sbagliato', ctx)
    const s = scritture()
    expect(s).toContain('t.result = null')
    expect(s).toContain('t.tested_at = null')
    expect(s).toContain('DELETE r')
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['status']).toBe(TASK_STATUS.PENDING)
  })

  it('un assessment riaperto azzera ANCHE il rischio del CI e quello aggregato', async () => {
    await reopenTask('assessment', 'a1', 'rivalutare', ctx)
    expect(scritture()).toContain("r.risk_score = null, r.ci_phase = 'assessment'")
    expect(resetChangeRisk).toHaveBeenCalledWith(expect.anything(), 'c1', 't1')
  })

  it('gli altri no: toccano solo `updated_at` della change', async () => {
    await reopenTask('deployment', 'd1', 'rifare', ctx)
    expect(resetChangeRisk).not.toHaveBeenCalled()
    expect(scritture()).toContain('SET c.updated_at = $now')
  })

  it('nella storia della change finisce il tipo, il ruolo, il CI e il motivo', async () => {
    await reopenTask('validation', 'v1', 'il test era sbagliato', ctx)
    const [, , , azione, , frase, i18n] = writeAudit.mock.calls[0] as unknown as [unknown, unknown, unknown, string, unknown, string, { key: string; params: Record<string, string> }]
    expect(azione).toBe('task_reopened')
    expect(frase).toContain('VM-01')
    expect(frase).toContain('il test era sbagliato')
    // E la stessa cosa come DATO, per chi la legge in un'altra lingua.
    expect(i18n).toMatchObject({ key: 'taskReopened', params: { ci: 'VM-01', reason: 'il test era sbagliato' } })
  })
})

describe('completeTask', () => {
  it('un tipo che non si completa così lo dice, invece di scrivere a caso', async () => {
    expect((await esito(() => completeTask('assessment', 'c1', 'ci1', undefined, ctx))).message)
      .toContain('is not completed with completeTask')
  })

  it('gli esiti sono chiusi: niente, o uno inventato, si rifiuta PRIMA di toccare il database', async () => {
    for (const r of [undefined, 'boh', '']) {
      const out = await esito(() => completeTask('validation', 'c1', 'ci1', r, ctx))
      expect(out.message).toContain('result must be')
    }
    expect(txRun).not.toHaveBeenCalled()
  })

  it('e il gruppo previsto del CI si verifica prima di scrivere', async () => {
    assertUserInCITeam.mockRejectedValue(new GraphQLError('non sei del gruppo', { extensions: { code: 'FORBIDDEN' } }))
    expect((await esito(() => completeTask('deployment', 'c1', 'ci1', undefined, ctx))).code).toBe('FORBIDDEN')
    expect(txRun).not.toHaveBeenCalled()
    // Il deployment lo conferma chi SUPPORTA.
    expect(assertUserInCITeam.mock.calls[0]![4]).toBe('support')
  })

  it('completato: si scrive l\'esito e il timestamp del TIPO, e chi l\'ha fatto', async () => {
    await completeTask('validation', 'c1', 'ci1', VALIDATION_RESULT.PASS, ctx)
    const s = scritture()
    expect(s).toContain('t.tested_at = $now')
    expect(s).toContain('t.result = $result')
    expect(s).toContain('MERGE (t)-[:TESTED_BY]->(u)')
    expect((txRun.mock.calls[0]![1] as Record<string, unknown>)['result']).toBe(VALIDATION_RESULT.PASS)
  })

  it('un compito senza esito non scrive un campo esito vuoto', async () => {
    await completeTask('deployment', 'c1', 'ci1', undefined, ctx)
    expect(scritture()).not.toContain('t.result =')
    expect(scritture()).toContain('t.deployed_at = $now')
  })

  it('un compito che non c\'è è NOT_FOUND, non un no-op: e il messaggio dice perché', async () => {
    txRun.mockResolvedValue({ records: [] })
    const r = await esito(() => completeTask('deployment', 'c1', 'ci9', undefined, ctx))
    expect(r.code).toBe('NOT_FOUND')
    expect(r.message).toContain('wrong phase, or task reopened?')
    expect(writeAudit).not.toHaveBeenCalled()
    expect(evaluateAutoTransitions).not.toHaveBeenCalled()
  })

  it('chiuso l\'ultimo, la change riprova le sue transizioni automatiche', async () => {
    await completeTask('review', 'c1', 'ci1', REVIEW_RESULT.CONFIRMED, ctx)
    expect(evaluateAutoTransitions).toHaveBeenCalledTimes(1)
    expect(evaluateAutoTransitions.mock.calls[0]![1]).toBe('c1')
  })
})
