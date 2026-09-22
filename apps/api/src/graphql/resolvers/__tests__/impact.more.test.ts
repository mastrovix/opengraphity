/**
 * impact.ts — what the change-impact panel shows beyond the blast radius.
 *
 * The CAB reads "open incidents", "recent changes" and the breakdown to decide
 * whether a change goes ahead. If a resolved incident were counted as open, or a
 * closed change as ongoing, the risk score would be inflated for every change on
 * that CI; if the resolver read the tenant from anywhere but the request context,
 * one customer could see another's incidents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Server)`),
}))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getTerminalStepNames: vi.fn(async (_s: unknown, _t: string, entity: string) => (entity === 'change' ? ['completed', 'failed'] : ['closed'])),
}))
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({
  impactRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON'),
}))
vi.mock('../../../lib/impactWeights.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/impactWeights.js')>()
  return { ...actual, impactAnalysisWeights: vi.fn(async () => ({ ...actual.FACTORY_IMPACT_WEIGHTS, isDefault: false })) }
})
vi.mock('../../../lib/riskBands.js', () => ({
  MAX_RISK_SCORE: 100,
  riskBandOf: vi.fn(async (_t: string, score: number) => (score === 0 ? 'none' : 'some')),
}))
vi.mock('../../../lib/environmentRisk.js', () => ({
  ENV_RISK_SCALE: ['0', '1', '2', '3'],
  environmentRiskScore: vi.fn(async () => 0),
}))

const h = vi.hoisted(() => ({ session: null as unknown }))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...actual,
    ciTypeFromLabels: vi.fn(() => 'server'),
    withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn(h.session)),
  }
})

const { computeImpactAnalysis, impactResolvers } = await import('../impact.js')

const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
let rowsFor: Array<[string, Array<Record<string, unknown>>]> = []

const session = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({ run: (cypher: string, params: Record<string, unknown>) => {
      calls.push({ cypher, params })
      const rows = rowsFor.find(([k]) => cypher.includes(k))?.[1] ?? []
      return Promise.resolve({ records: rows.map((r) => ({ get: (f: string) => r[f] })) })
    } })),
}
h.session = session

beforeEach(() => { calls.length = 0; rowsFor = [] })

describe('computeImpactAnalysis — incidents and changes', () => {
  it('lists open and recently resolved incidents, but counts only the open ones in the score', async () => {
    rowsFor = [
      ['true AS isOpen', [{ id: 'i1', number: 'INC1', title: 'Down', severity: 'high', status: 'new', ciName: 'web', ciId: 'c1', createdAt: '2026-09-20', isOpen: true }]],
      ['false AS isOpen', [{ id: 'i2', number: null, title: 'Old', severity: null, status: 'closed', ciName: 'web', ciId: 'c1', createdAt: '2026-09-10', isOpen: false }]],
    ]
    const res = await computeImpactAnalysis(session as never, 't1', ['c1'])

    expect(res.openIncidents).toEqual([
      { id: 'i1', number: 'INC1', title: 'Down', severity: 'high', status: 'new', ciName: 'web', ciId: 'c1', createdAt: '2026-09-20', isOpen: true },
      // A missing number is an empty string, a missing severity stays null (no invented value).
      { id: 'i2', number: '', title: 'Old', severity: null, status: 'closed', ciName: 'web', ciId: 'c1', createdAt: '2026-09-10', isOpen: false },
    ])
    expect(res.breakdown.openIncidents).toBe(1)
    // Open vs resolved is decided by the tenant's terminal steps, not a literal.
    const open = calls.find((c) => c.cypher.includes('true AS isOpen'))!
    expect(open.params).toMatchObject({ tenantId: 't1', terminalSteps: ['closed'] })
  })

  it('rejected changes count as failed; changes in a terminal phase are not ongoing', async () => {
    rowsFor = [
      ['AS approvalStatus', [
        { id: 'ch1', code: 'CHG1', title: 'Patch', phase: 'implementation', approvalStatus: 'rejected', ciName: 'web', ciId: 'c1', createdAt: '2026-09-19' },
        { id: 'ch2', code: null, title: 'Done', phase: 'completed', approvalStatus: null, ciName: 'web', ciId: 'c1', createdAt: '2026-09-18' },
      ]],
    ]
    const res = await computeImpactAnalysis(session as never, 't1', ['c1'])

    expect(res.recentChanges.map((c) => [c.id, c.code, c.phase])).toEqual([['ch1', 'CHG1', 'implementation'], ['ch2', '', 'completed']])
    expect(res.breakdown).toMatchObject({ failedChanges: 1, ongoingChanges: 1 })
    expect(res.riskScore).toBeGreaterThan(0)
    expect(res.breakdown.scoreDetails).not.toBe('No risk factor found')
  })

  it('with nothing around the CI the score is zero and the breakdown says so in words', async () => {
    const res = await computeImpactAnalysis(session as never, 't1', ['c1'])
    expect(res.riskScore).toBe(0)
    expect(res.riskLevel).toBe('none')
    expect(res.breakdown.scoreDetails).toBe('No risk factor found')
  })
})

describe('computeImpactAnalysis — blast radius rows', () => {
  it('maps each impacted CI; a CI without environment stays without one (not "unknown")', async () => {
    rowsFor = [['MATCH path = (ci)', [
      { id: 'c2', name: 'db', label: 'Server', environment: 'prod', distance: 1 },
      { id: 'c3', name: 'cache', label: 'Server', environment: null, distance: 2 },
    ]]]
    const res = await computeImpactAnalysis(session as never, 't1', ['c1'])
    expect(res.blastRadius).toEqual([
      { id: 'c2', name: 'db', type: 'server', environment: 'prod', distance: 1 },
      { id: 'c3', name: 'cache', type: 'server', environment: null, distance: 2 },
    ])
    expect(res.breakdown.blastRadiusCIs).toBe(2)
  })
})

describe('impactResolvers.Query.changeImpactAnalysis', () => {
  it('scopes every query to the tenant of the request context', async () => {
    const res = await impactResolvers.Query.changeImpactAnalysis(null, { ciIds: ['c9'] }, { tenantId: 'tenant-ctx' } as never)
    expect(res.blastRadius).toEqual([])
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.params['tenantId']).toBe('tenant-ctx')
    expect(calls[0]!.params['ciIds']).toEqual(['c9'])
  })
})
