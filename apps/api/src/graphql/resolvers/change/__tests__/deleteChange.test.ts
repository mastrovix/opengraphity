/**
 * deleteChange — cancellazione logica della change e i suoi effetti fuori dal
 * grafo, tutti post-commit: timer OLA annullati, rivalutazione degli allarmi
 * silenziati ACCODATA (revisione 2 · B2-05: non più in linea nella mutation),
 * problem che tornano in analisi e — dalla revisione 2 (D6.1) — i Servizi
 * monitorati avvisati che la finestra di questa change non c'è più (i suoi
 * componenti tornano a pesare).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'

const runQueryMock = vi.fn()
vi.mock('../../ci-utils.js', () => ({
  withSession: vi.fn(),
  runQuery: (...a: unknown[]) => runQueryMock(...a),
  runQueryOne: vi.fn(),
  getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  mapCI: vi.fn(),
}))
vi.mock('../../../../lib/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/sla', () => ({
  getActiveOLAContractsFor: vi.fn().mockResolvedValue([]),
  cancelOLABreaches: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../services/eventCorrelation.js', () => ({
  reevaluateSuppressedEvents: vi.fn().mockResolvedValue(0),
  CHANGE_WINDOW_STEPS: ['deployment', 'scheduled'],
}))
vi.mock('../../../../jobs/eventCorrelateWorker.js', () => ({
  enqueueChangeWindowReevaluation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../services/serviceImpact/sync.js', () => ({
  notifyChangeWindowChanged: vi.fn().mockResolvedValue(2),
}))
vi.mock('../autoTransitions.js', () => ({
  evaluateAutoTransitions: vi.fn().mockResolvedValue(undefined),
  revertProblemAfterChangeDetached: vi.fn().mockResolvedValue(undefined),
}))

const { deleteChange } = await import('../changeMutations.js')
const { withSession } = await import('../../ci-utils.js')
const { notifyChangeWindowChanged } = await import('../../../../services/serviceImpact/sync.js')
const { reevaluateSuppressedEvents } = await import('../../../../services/eventCorrelation.js')
const { enqueueChangeWindowReevaluation } = await import('../../../../jobs/eventCorrelateWorker.js')

const admin: GraphQLContext = { tenantId: 't1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator' }

/** La transazione di cancellazione riesce; la lettura dei problem collegati non trova nulla. */
function mockGraph(deleted = true) {
  const executeWrite = vi.fn(async () => ({ records: deleted ? [{ get: () => 'chg-1' }] : [] }))
  const session = { executeWrite, close: vi.fn().mockResolvedValue(undefined) }
  vi.mocked(withSession).mockImplementation((fn: (s: unknown) => unknown) => fn(session) as never)
  runQueryMock.mockResolvedValue([])
  return session
}

beforeEach(() => { vi.clearAllMocks() })

describe('deleteChange', () => {
  it('avvisa i Servizi monitorati che la finestra è sparita, DOPO il commit e senza mai lanciare (D6.1)', async () => {
    const session = mockGraph()
    expect(await deleteChange(null, { id: 'chg-1' }, admin)).toBe(true)
    expect(notifyChangeWindowChanged).toHaveBeenCalledWith('t1', 'chg-1', 'change.deleted')
    expect(vi.mocked(notifyChangeWindowChanged).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(session.executeWrite.mock.invocationCallOrder[0]!)
    // gli allarmi silenziati si rivalutano comunque: i due segnali sono distinti
    // B2-05: la rivalutazione è ACCODATA (una change con 300 allarmi silenziati
    // teneva la mutation per minuti), mai eseguita in linea.
    expect(enqueueChangeWindowReevaluation).toHaveBeenCalledWith('t1', 'chg-1', expect.any(Number))
    expect(reevaluateSuppressedEvents).not.toHaveBeenCalled()
    expect(vi.mocked(enqueueChangeWindowReevaluation).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(session.executeWrite.mock.invocationCallOrder[0]!)
  })

  it('B2-05 — accodamento fallito: l\'errore propaga (fail-loud, nessun try/catch che lo ingoia)', async () => {
    mockGraph()
    vi.mocked(enqueueChangeWindowReevaluation).mockRejectedValueOnce(new Error('Redis down'))
    await expect(deleteChange(null, { id: 'chg-1' }, admin)).rejects.toThrow('Redis down')
  })

  it('coda dei servizi giù: il segnale torna 0 e la cancellazione resta valida', async () => {
    mockGraph()
    vi.mocked(notifyChangeWindowChanged).mockResolvedValueOnce(0)
    expect(await deleteChange(null, { id: 'chg-1' }, admin)).toBe(true)
  })

  it('change inesistente o già eliminata → NOT_FOUND, nessun segnale ai servizi', async () => {
    mockGraph(false)
    await expect(deleteChange(null, { id: 'chg-x' }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(notifyChangeWindowChanged).not.toHaveBeenCalled()
  })

  it('solo admin', async () => {
    mockGraph()
    await expect(deleteChange(null, { id: 'chg-1' }, operator)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(notifyChangeWindowChanged).not.toHaveBeenCalled()
  })
})
