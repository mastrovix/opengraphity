/**
 * Approval routing del Change process.
 *
 * Backend (helpers.computeAggregateRisk → scoring.determineApprovalRoute):
 *   aggregate = MAX dei risk_score per-CI (fatto in Cypher con max())
 *   route = la FASCIA di rischio del cliente per quel punteggio (soglie in
 *   Matrici di dominio). Con le soglie di fabbrica: ≤30 low · ≤60 medium · high.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/db.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../lib/logger.js', () => ({
  // `child` serve perché scoring.ts ora importa lib/domainMatrix.js, che si
  // prende un logger figlio al caricamento del modulo (ondata 7).
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}))

// Ondata 7: la priorità della change esce dalla matrice del cliente. Qui
// interessa la ROUTE, non la priorità: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../../lib/domainMatrix.js', () => import('../../../lib/__tests__/domainMatrixFake.js'))
// Rimedio 3: le soglie delle fasce di rischio sono dato del cliente, quindi
// `deriveChangePriority` legge il tenant anche solo per sapere che fascia è un
// punteggio. Questo test misura la rotta d'approvazione: il doppio risponde con
// le soglie factory senza grafo.
vi.mock('../../../lib/riskBands.js', async () => {
  const fake = await import('../../../lib/__tests__/riskBandsFake.js')
  return { ...fake, riskBandOf: vi.fn(fake.riskBandOf) }
})

vi.mock('../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

const { determineApprovalRoute } = await import('../scoring.js')
const { computeAggregateRisk } = await import('../helpers.js')
const { runQueryOne } = await import('../../../lib/db.js')
const { riskBandOf } = await import('../../../lib/riskBands.js')

describe('determineApprovalRoute', () => {
  it('soglie di fabbrica: 0 e 30 → low, 31 e 60 → medium, 61 e 100 → high', async () => {
    for (const [score, band] of [[0, 'low'], [30, 'low'], [31, 'medium'], [60, 'medium'], [61, 'high'], [100, 'high']] as const) {
      expect(await determineApprovalRoute('tenant-1', score), `score ${score}`).toBe(band)
    }
  })

  it('segue le fasce del cliente: una quarta fascia è una quarta rotta', async () => {
    vi.mocked(riskBandOf).mockResolvedValueOnce('very_high')
    expect(await determineApprovalRoute('tenant-1', 95)).toBe('very_high')
    expect(riskBandOf).toHaveBeenCalledWith('tenant-1', 95)
  })

  it('aggregate = MAX dei CI scores: [20, 45, 80] → route del massimo (high)', async () => {
    const ciScores = [20, 45, 80]
    expect(await determineApprovalRoute('tenant-1', Math.max(...ciScores))).toBe('high')
    // controprova: senza il CI a 80 la route scenderebbe a medium
    expect(await determineApprovalRoute('tenant-1', Math.max(20, 45))).toBe('medium')
  })
})

describe('computeAggregateRisk (integrazione con la route)', () => {
  // Passata come ManagedTransaction (niente executeWrite): le scritture usano tx.run.
  const mockTx = { run: vi.fn().mockResolvedValue({ records: [] }) }

  beforeEach(() => {
    vi.clearAllMocks()
    mockTx.run.mockResolvedValue({ records: [] })
  })

  it('scrive aggregate_risk_score = max e approval_route derivata (80 → high)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 80, unassessed: 0, changeType: 'normal' } as never)

    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')

    expect(mockTx.run).toHaveBeenCalledOnce()
    const [cypher, params] = mockTx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('aggregate_risk_score')
    expect(params['maxRisk']).toBe(80)
    expect(params['route']).toBe('high')
  })

  it('45 → medium, 20 → low', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 45, unassessed: 0, changeType: 'normal' } as never)
    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')
    expect((mockTx.run.mock.calls[0]![1] as Record<string, unknown>)['route']).toBe('medium')

    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 20, unassessed: 0, changeType: 'normal' } as never)
    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')
    expect((mockTx.run.mock.calls[1]![1] as Record<string, unknown>)['route']).toBe('low')
  })

  it('U-24: finché un CI non ha il suo rischio, il rischio aggregato non è noto → azzerato, priorità iniziale del tipo (non «LOW · 0»)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 89, unassessed: 2, changeType: 'normal' } as never)

    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')

    expect(mockTx.run).toHaveBeenCalledOnce()
    const [cypher, params] = mockTx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('c.aggregate_risk_score = null, c.approval_route = null')
    // `normal` non valutato → matrice change_priority_initial (medium), non la fascia bassa
    expect(params['priority']).toBe('medium')
  })
})
