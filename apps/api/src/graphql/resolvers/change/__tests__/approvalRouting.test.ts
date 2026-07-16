/**
 * Approval routing del Change process.
 *
 * Backend (helpers.computeAggregateRisk → scoring.determineApprovalRoute):
 *   aggregate = MAX dei risk_score per-CI (fatto in Cypher con max())
 *   route: ≤30 → 'low' (frontend: Auto) · ≤60 → 'medium' (Change Manager)
 *          · >60 → 'high' (CAB)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../ci-utils.js', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
  mapCI:       vi.fn(),
}))

vi.mock('../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/workflowHelpers.js', () => ({
  getInitialStepName: vi.fn().mockResolvedValue('assessment'),
  getWorkflowSteps:   vi.fn().mockResolvedValue([]),
}))

const { determineApprovalRoute } = await import('../scoring.js')
const { computeAggregateRisk } = await import('../helpers.js')
const { runQueryOne } = await import('../../ci-utils.js')

describe('determineApprovalRoute', () => {
  it('boundary bassi: 0 e 30 → low (Auto)', () => {
    expect(determineApprovalRoute(0)).toBe('low')
    expect(determineApprovalRoute(30)).toBe('low')
  })

  it('boundary medi: 31 e 60 → medium (Change Manager)', () => {
    expect(determineApprovalRoute(31)).toBe('medium')
    expect(determineApprovalRoute(60)).toBe('medium')
  })

  it('boundary alti: 61 e 100 → high (CAB)', () => {
    expect(determineApprovalRoute(61)).toBe('high')
    expect(determineApprovalRoute(100)).toBe('high')
  })

  it('aggregate = MAX dei CI scores: [20, 45, 80] → route del massimo (high)', () => {
    const ciScores = [20, 45, 80]
    expect(determineApprovalRoute(Math.max(...ciScores))).toBe('high')
    // controprova: senza il CI a 80 la route scenderebbe a medium
    expect(determineApprovalRoute(Math.max(20, 45))).toBe('medium')
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
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 80 } as never)

    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')

    expect(mockTx.run).toHaveBeenCalledOnce()
    const [cypher, params] = mockTx.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('aggregate_risk_score')
    expect(params['maxRisk']).toBe(80)
    expect(params['route']).toBe('high')
  })

  it('45 → medium, 20 → low', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 45 } as never)
    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')
    expect((mockTx.run.mock.calls[0]![1] as Record<string, unknown>)['route']).toBe('medium')

    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: 20 } as never)
    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')
    expect((mockTx.run.mock.calls[1]![1] as Record<string, unknown>)['route']).toBe('low')
  })

  it('nessun risk score sui CI (maxRisk null) → 0 → low', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ maxRisk: null } as never)

    await computeAggregateRisk(mockTx as never, 'chg-1', 'tenant-1')

    const params = mockTx.run.mock.calls[0]![1] as Record<string, unknown>
    expect(params['maxRisk']).toBe(0)
    expect(params['route']).toBe('low')
  })
})
