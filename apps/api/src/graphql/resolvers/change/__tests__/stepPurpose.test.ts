/**
 * Ondata 4 · A4-2 / A4-3: le regole della change riconoscono i passi dallo
 * SCOPO (e dalla CATEGORIA dove il ruolo è lo stato visibile), non dal nome.
 *
 * Il tenant di questi test ha **rinominato tutto**: `valutazione`,
 * `cab_settimanale`, `in_calendario`, `rilascio_notturno`, `chiusa`. Con il
 * codice di prima l'approvazione completa tentava `scheduled` — un passo che
 * qui non esiste — e finiva in CONFLICT: la change non si approvava e non si
 * rifiutava più. C'è anche il caso opposto, che il nome da solo non può
 * distinguere: un passo CHIAMATO `approval` ma con un altro scopo.
 *
 * Il nucleo (`lib/workflowHelpers.ts`) NON è mockato: la sessione finta
 * risponde alla sua query, così i test esercitano la lettura vera dei
 * metadata dei passi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// ── Passi del tenant (rinominati) ─────────────────────────────────────────────

interface Step { name: string; purpose?: string | null; category?: string | null; order?: number; initial?: boolean; terminal?: boolean }

const CHANGE_STEPS: Step[] = [
  { name: 'valutazione',       purpose: 'assessment',     category: 'active',  order: 1, initial: true },
  { name: 'cab_settimanale',   purpose: 'approval',       category: 'waiting', order: 2 },
  { name: 'in_calendario',     purpose: 'scheduled',      category: 'waiting', order: 3 },
  { name: 'rilascio_notturno', purpose: 'implementation', category: 'active',  order: 4 },
  { name: 'chiusa',            purpose: null,             category: 'closed',  order: 5, terminal: true },
]

let steps: Step[] = CHANGE_STEPS

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => (k in m ? m[k] : null) })
const stepRecords = () => steps.map((s) => rec({
  name: s.name, isInitial: s.initial === true, isTerminal: s.terminal === true, isOpen: s.terminal !== true,
  category: s.category ?? 'active', purpose: s.purpose ?? null, stepOrder: s.order ?? null,
}))

const session = {
  executeRead: (fn: (tx: { run: () => Promise<{ records: unknown[] }> }) => unknown) =>
    fn({ run: async () => ({ records: stepRecords() }) }),
  executeWrite: vi.fn(async (fn: (tx: { run: () => Promise<unknown> }) => unknown) => fn({ run: async () => ({ records: [] }) })),
  close: vi.fn().mockResolvedValue(undefined),
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(session)),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { transition: vi.fn(), getAvailableTransitions: vi.fn() },
}))
vi.mock('../queries.js', () => ({ change: vi.fn(async () => ({ id: 'chg-1' })) }))
vi.mock('../autoTransitions.js', () => ({ evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../helpers.js', () => ({
  afterEnterStep: vi.fn().mockResolvedValue(undefined),
  getInstanceId:  vi.fn().mockResolvedValue('wi-1'),
  writeAudit:     vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../approvalCreation.js', () => ({ areAllApprovalsSatisfied: vi.fn().mockResolvedValue(true) }))
vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

const { runQueryOne } = await import('../../ci-utils.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { afterEnterStep } = await import('../helpers.js')
const { approveChangeApproval, rejectChangeApproval } = await import('../approvalGate.js')
const { invalidateWorkflowCache } = await import('../../../../lib/workflowHelpers.js')
const { targetStepByPurpose, targetStepByCategory, stepNamesByCategory, stepNamesByPurposeOrdered } =
  await import('../../../../lib/workflowTargets.js')

const ctx = { tenantId: 't1', userId: 'u-1', userEmail: 'op@test.io', role: 'admin' as const }

/** Risponde alle query di approvalGate: passo corrente, requisito, ecc. */
function mockGate(currentStep: string) {
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('CURRENT_STEP')) {
      const s = steps.find((x) => x.name === currentStep)
      return { step: currentStep, purpose: s?.purpose ?? null, changeType: 'normal', teamName: 'CAB' }
    }
    if (cypher.includes('HAS_APPROVAL')) return { id: 'appr-1' }
    return { id: 'x' }
  }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  steps = CHANGE_STEPS
  invalidateWorkflowCache()
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_calendario' }, { toStep: 'valutazione' }] as never)
})

async function caught(p: Promise<unknown>): Promise<GraphQLError> {
  try { await p } catch (e) { return e as GraphQLError }
  throw new Error('nessun errore lanciato')
}

// ── A4-2: il varco delle approvazioni ─────────────────────────────────────────

describe('approvazione della change su un workflow rinominato (A4-2)', () => {
  it('approvazione completa → avanza al passo di SCOPO scheduled («in_calendario»), non al nome «scheduled»', async () => {
    mockGate('cab_settimanale')
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx)
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ instanceId: 'wi-1', toStepName: 'in_calendario', notes: 'Approvazioni complete' }),
      expect.anything(),
    )
    expect(afterEnterStep).toHaveBeenCalledWith(session, 'chg-1', 't1', 'in_calendario')
  })

  it('rifiuto → riporta al passo di SCOPO assessment («valutazione»)', async () => {
    mockGate('cab_settimanale')
    await rejectChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab', note: 'manca il rollback', reopenAll: true }, ctx)
    expect(workflowEngine.transition).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ toStepName: 'valutazione' }),
      expect.anything(),
    )
    expect(afterEnterStep).toHaveBeenCalledWith(session, 'chg-1', 't1', 'valutazione')
  })

  it('un passo CHIAMATO «approval» ma con un altro scopo non è la fase di approvazione', async () => {
    steps = [...CHANGE_STEPS, { name: 'approval', purpose: 'review', category: 'active', order: 6 }]
    mockGate('approval')
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx))
    expect(err.message).toMatch(/non è in fase di approvazione/)
    expect(err.message).toMatch(/scopo review/)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('nessun passo dichiara lo scopo scheduled → si ferma dicendolo e nominando il disegnatore (non un CONFLICT muto)', async () => {
    steps = CHANGE_STEPS.filter((s) => s.purpose !== 'scheduled')
    mockGate('cab_settimanale')
    const err = await caught(approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx))
    expect(err.message).toMatch(/avanzamento della change dopo le approvazioni complete/)
    expect(err.message).toMatch(/nessun passo dichiara lo scopo \[scheduled\]/)
    expect(err.message).toMatch(/disegnatore/)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('due passi con lo stesso scopo → si preferisce quello raggiungibile dalle transizioni disponibili', async () => {
    steps = [...CHANGE_STEPS, { name: 'in_calendario_urgente', purpose: 'scheduled', category: 'waiting', order: 0 }]
    // `order: 0` lo metterebbe primo, ma dal passo corrente si può andare solo in `in_calendario`
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'in_calendario' }] as never)
    mockGate('cab_settimanale')
    await approveChangeApproval(null, { changeId: 'chg-1', teamId: 'team-cab' }, ctx)
    expect(workflowEngine.transition).toHaveBeenCalledWith(session, expect.objectContaining({ toStepName: 'in_calendario' }), expect.anything())
  })
})

// ── I bersagli: scopo, categoria, determinismo ────────────────────────────────

describe('workflowTargets', () => {
  it('per scopo: il passo con step_order più basso, salvo un candidato raggiungibile', async () => {
    steps = [...CHANGE_STEPS, { name: 'rilascio_urgente', purpose: 'implementation', category: 'active', order: 3.5 }]
    expect(await stepNamesByPurposeOrdered(session as never, 't1', 'change', ['implementation']))
      .toEqual(['rilascio_urgente', 'rilascio_notturno'])
    expect(await targetStepByPurpose(session as never, 't1', 'change', ['implementation'], 'x')).toBe('rilascio_urgente')
    expect(await targetStepByPurpose(session as never, 't1', 'change', ['implementation'], 'x', ['rilascio_notturno'])).toBe('rilascio_notturno')
  })

  it('per categoria: «chiusa» si riconosce dalla categoria closed, non dal nome', async () => {
    expect(await stepNamesByCategory(session as never, 't1', 'change', ['closed'])).toEqual(['chiusa'])
    expect(await targetStepByCategory(session as never, 't1', 'change', ['closed'], 'x')).toBe('chiusa')
  })

  it('categoria assente → errore che la nomina e indica il disegnatore (nessuna lista vuota silenziosa)', async () => {
    steps = CHANGE_STEPS.filter((s) => s.category !== 'closed')
    await expect(targetStepByCategory(session as never, 't1', 'change', ['closed'], 'chiusura della change'))
      .rejects.toThrow(/chiusura della change: .*nessun passo ha la categoria \[closed\].*disegnatore/s)
  })
})
