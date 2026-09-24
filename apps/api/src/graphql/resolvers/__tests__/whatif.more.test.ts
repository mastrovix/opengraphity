/**
 * What-if analysis: impact levels, risk score, tenant scoping and edge cases.
 *
 * Why these behaviours matter:
 *  - A change manager decides whether to take a CI down by reading this page.
 *    The impact level per distance (and its shift for "remove"), the risk score
 *    and its cap at 100, and the teams / open incidents counted must stay
 *    exactly as documented, or the page understates the blast radius.
 *  - Every query must carry the caller's tenant: a traversal without it would
 *    show another customer's CIs.
 *  - An unknown CI is NOT_FOUND (never an empty "no impact" answer), and the
 *    traversal depth is clamped to 1..10 so a request cannot ask the database
 *    for an unbounded variable-length path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({ serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON|HOSTED_ON') }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getTerminalStepNames: vi.fn().mockResolvedValue(['closed', 'resolved']) }))

const { whatifResolvers, OPEN_INCIDENTS_ON_CIS_CYPHER } = await import('../whatif.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { getTerminalStepNames } = await import('../../../lib/workflowHelpers.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

type Row = Record<string, unknown>
let target: Row | null
let impacted: Row[]
let teams: Row[]
let services: Row[]
let openCount: unknown

beforeEach(() => {
  vi.clearAllMocks()
  target = { name: 'db-01', lbl: 'Database', env: 'production', status: 'active' }
  impacted = []
  teams = []
  services = []
  openCount = 0
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('AS lbl')) return target
    if (cypher === OPEN_INCIDENTS_ON_CIS_CYPHER) return openCount === undefined ? null : { cnt: openCount }
    return null
  }) as never)
  vi.mocked(runQuery).mockImplementation((async (_s: unknown, cypher: string) => {
    if (cypher.includes('shortestPath(')) return impacted
    if (cypher.includes(':Team')) return teams
    if (cypher.includes(':ServiceMap')) return services
    return []
  }) as never)
})

const ci = (id: string, distance: number, extra: Row = {}): Row =>
  ({ id, name: id, lbls: ['Application'], env: 'production', status: 'active', distance, pathNames: [id, 'db-01'], ...extra })

const analyse = (action: string, depth?: number | null) =>
  whatifResolvers.Query.whatIfAnalysis(null, { ciId: 'db-1', action, depth }, ctx)

describe('impact level by distance', () => {
  it('impact: 1 critical, 2 high, 3 medium, 4+ low', async () => {
    impacted = [ci('a', 1), ci('b', 2), ci('c', 3), ci('d', 4)]
    const r = await analyse('impact')
    expect(r.impactedCIs.map((c) => c.impactLevel)).toEqual(['critical', 'high', 'medium', 'low'])
  })

  it('remove shifts every level up by one: <=2 critical, 3 high, 4+ medium', async () => {
    impacted = [ci('a', 1), ci('b', 2), ci('c', 3), ci('d', 5)]
    const r = await analyse('remove')
    expect(r.impactedCIs.map((c) => c.impactLevel)).toEqual(['critical', 'critical', 'high', 'medium'])
  })
})

describe('target and traversal', () => {
  it('an unknown CI is NOT_FOUND and the session is closed', async () => {
    target = null
    await expect(analyse('impact')).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(close).toHaveBeenCalled()
  })

  it('a target without a type label reads "Unknown"; missing labels/path on an impacted CI too', async () => {
    target = { name: 'thing', lbl: null, env: null, status: null }
    impacted = [ci('a', 1, { lbls: null, pathNames: null })]
    const r = await analyse('impact')
    expect(r.targetCI).toMatchObject({ id: 'db-1', name: 'thing', type: 'Unknown', impactLevel: 'target', impactPath: [] })
    expect(r.impactedCIs[0]).toMatchObject({ type: 'Unknown', impactPath: [] })
  })

  it('depth is clamped to 1..10 (default 5) and every query carries the tenant', async () => {
    for (const [depth, expected] of [[undefined, 5], [null, 5], [0, 1], [-3, 1], [50, 10], [7, 7]] as const) {
      vi.mocked(runQuery).mockClear()
      await analyse('impact', depth)
      const traversal = vi.mocked(runQuery).mock.calls.find(([, c]) => String(c).includes('shortestPath('))!
      expect(String(traversal[1])).toContain(`*1..${expected}]`)
    }
    for (const [, , params] of [...vi.mocked(runQuery).mock.calls, ...vi.mocked(runQueryOne).mock.calls]) {
      expect(params).toMatchObject({ tenantId: 't1' })
    }
  })
})

describe('teams, open incidents and services', () => {
  it('with nothing impacted, teams and incidents are not even queried', async () => {
    const r = await analyse('impact')
    expect(vi.mocked(runQuery).mock.calls.some(([, c]) => String(c).includes(':Team'))).toBe(false)
    expect(getTerminalStepNames).not.toHaveBeenCalled()
    expect(r).toMatchObject({ totalImpacted: 0, riskScore: 0, openIncidents: 0, impactedTeams: [] })
    expect(r.summary).toBe('An outage of db-01 impacts 0 CIs, 0 services, 0 teams. Risk: 0/100.')
  })

  it('counts owner teams and open (non-terminal) incidents on the impacted CIs', async () => {
    impacted = [ci('a', 1), ci('b', 2)]
    teams = [{ id: 'tm-1', name: 'DBA', cnt: 2 }]
    openCount = 3
    const r = await analyse('impact')
    expect(r.impactedTeams).toEqual([{ id: 'tm-1', name: 'DBA', role: 'owner', impactedCICount: 2 }])
    expect(r.openIncidents).toBe(3)
    // Terminal steps come from the tenant's incident workflow, not a hardcoded list.
    expect(getTerminalStepNames).toHaveBeenCalledWith(expect.anything(), 't1', 'incident')
    const inc = vi.mocked(runQueryOne).mock.calls.find(([, c]) => c === OPEN_INCIDENTS_ON_CIS_CYPHER)!
    expect(inc[2]).toEqual({ impactedIds: ['a', 'b'], tenantId: 't1', terminalSteps: ['closed', 'resolved'] })
    // 2 CIs * 10 + 15 for open incidents.
    expect(r.riskScore).toBe(35)
  })

  it('a missing incident count reads as zero', async () => {
    impacted = [ci('a', 1)]
    openCount = undefined
    const r = await analyse('impact')
    expect(r.openIncidents).toBe(0)
  })

  it('each service appears once, at its closest CI, sorted by distance then name; unknown CIs are ignored', async () => {
    impacted = [ci('a', 1), ci('b', 3)]
    services = [
      { id: 'ba-z', name: 'Zeta', env: 'prod', status: 'active', ciId: 'b' },
      { id: 'ba-z', name: 'Zeta', env: 'prod', status: 'active', ciId: 'a' }, // closer: wins
      { id: 'ba-a', name: 'Alpha', env: 'prod', status: 'active', ciId: 'a' },
      { id: 'ba-far', name: 'Far', env: 'prod', status: 'active', ciId: 'b' },
      { id: 'ba-far', name: 'Far', env: 'prod', status: 'active', ciId: 'b' }, // same distance: first kept
      { id: 'ba-x', name: 'Ghost', env: 'prod', status: 'active', ciId: 'not-traversed' },
    ]
    const r = await analyse('impact')
    expect(r.impactedServices.map((s) => [s.id, s.impactLevel])).toEqual([['ba-a', 'critical'], ['ba-z', 'critical'], ['ba-far', 'medium']])
  })

  it('risk score is capped: 10 per CI up to 50, +20 services, +15 incidents, +15 remove, max 100', async () => {
    impacted = Array.from({ length: 8 }, (_, i) => ci(`c${i}`, 1))
    services = [{ id: 'ba-1', name: 'Svc', env: null, status: null, ciId: 'db-1' }]
    openCount = 1
    const r = await analyse('remove')
    expect(r.riskScore).toBe(100)
    expect(r.impactedServices[0]).toMatchObject({ impactLevel: 'critical', impactPath: ['db-01'] })
    // The analysis is audited with its outcome.
    expect(audit).toHaveBeenCalledWith(ctx, 'whatif_analysis', 'CI', 'db-1', { action: 'remove', totalImpacted: 8, riskScore: 100 })
  })
})

describe('whatIfCompare', () => {
  it('runs one analysis per scenario, in order', async () => {
    const r = await whatifResolvers.Query.whatIfCompare(null, { scenarios: [{ ciId: 'db-1', action: 'impact' }, { ciId: 'db-1', action: 'remove' }] }, ctx)
    expect(r.map((x) => x.action)).toEqual(['impact', 'remove'])
    expect(r[1]!.riskScore).toBe(15)
  })
})

// Review of 23 Sep 2026: an unbounded scenario list, each one a traversal of the CMDB, all in parallel.
describe('whatIfCompare — bounded', () => {
  it('more than the cap is refused with its key, before any traversal', async () => {
    const { whatifResolvers, WHAT_IF_MAX_SCENARIOS } = await import('../whatif.js')
    vi.mocked(runQuery).mockClear()
    const scenarios = Array.from({ length: WHAT_IF_MAX_SCENARIOS + 1 }, (_, i) => ({ ciId: `ci-${i}`, action: 'impact' }))
    await expect(whatifResolvers.Query.whatIfCompare(undefined, { scenarios }, ctx as never))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.whatIf.tooManyScenarios' } } })
    expect(vi.mocked(runQuery)).not.toHaveBeenCalled()
  })
})
