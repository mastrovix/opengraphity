/**
 * LOADING THE OLA/UC UNITS OF A CHANGE FROM THE GRAPH.
 *
 * `loadChangeUnits` feeds three readers: the change detail box (one change),
 * the report (units concluded in a period) and the nightly alert pass (open
 * units of one team). Each must see exactly its own units:
 *  - the report must not count a unit concluded before the period, nor one
 *    still open, or the attainment percentage is wrong;
 *  - the alert pass must not alert a team about a unit that is closed or that
 *    belongs to another team (a deploy step measures the CI's owner team for
 *    validation and the support team for release);
 *  - every query is scoped to the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  assessments: [] as unknown[],
  plans: [] as unknown[],
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    h.calls.push({ cypher, params })
    return cypher.includes(':AssessmentTask') ? h.assessments : h.plans
  },
}))

import { loadChangeUnits, assessmentUnitsCypher, deployPlanUnitsCypher } from '../olaChangeUnits.js'

const change = { ticketId: 'chg-7', ticketNumber: 'CHG00000007', ticketTitle: 'Portal release' }
const assessment = (id: string, over: Record<string, unknown> = {}) => ({
  ...change, id, createdAt: '2026-09-15T10:00:00Z', concludedAt: null, responderRole: 'owner', alerted: [], currentTeamId: 'net', ciName: 'Portal',
  segments: [], ...over,
})
const plan = (over: Record<string, unknown> = {}) => ({
  ...change, id: 'dp-1', createdAt: '2026-09-15T10:00:00Z', alerted: [], ciName: 'Portal', ownerTeamId: 'app', supportTeamId: 'ops',
  steps: JSON.stringify([
    { title: '', validationWindow: { start: '2026-09-17T07:00:00Z', end: '2026-09-17T09:00:00Z' }, releaseWindow: { start: '2026-09-17T18:00:00Z', end: '2026-09-17T20:00:00Z' } },
  ]),
  testedAt: null, deployedAt: null, ...over,
})

const session = {} as never

beforeEach(() => { h.calls = []; h.assessments = []; h.plans = [] })

describe('loadChangeUnits', () => {
  it('one change: every unit, both queries scoped to tenant and change', async () => {
    h.assessments = [assessment('at-1', { concludedAt: '2026-09-16T00:00:00Z' })]
    h.plans = [plan()]
    const units = await loadChangeUnits(session, 't1', { by: 'change', changeId: 'chg-7' })
    expect(units.map((u) => u.key)).toEqual(['assessment:at-1', 'validation:dp-1:0', 'release:dp-1:0'])
    for (const c of h.calls) expect(c.params).toEqual({ tenantId: 't1', changeId: 'chg-7' })
    // A step with no title shows as "no title", not as an empty label.
    expect(units[1]!.stepTitle).toBeNull()
  })

  it('concluded: only units closed on or after the cut-off', async () => {
    h.assessments = [
      assessment('old', { concludedAt: '2026-08-01T00:00:00Z' }),
      assessment('in', { concludedAt: '2026-09-10T00:00:00Z' }),
      assessment('open'),
    ]
    h.plans = [plan({ testedAt: '2026-09-17T08:00:00Z', deployedAt: null })]
    const units = await loadChangeUnits(session, 't1', { by: 'concluded', cutoff: '2026-09-01T00:00:00Z', teamId: null })
    expect(units.map((u) => u.key)).toEqual(['assessment:in', 'validation:dp-1:0'])
    for (const c of h.calls) expect(c.params).toEqual({ tenantId: 't1', cutoff: '2026-09-01T00:00:00Z', teamId: null })
  })

  it('open: only units still running AND currently held by that team', async () => {
    h.assessments = [assessment('mine'), assessment('theirs', { currentTeamId: 'other' }), assessment('done', { concludedAt: '2026-09-16T00:00:00Z' })]
    h.plans = [plan()]
    const units = await loadChangeUnits(session, 't1', { by: 'open', teamId: 'ops' })
    // The release of the step is measured on the support team (ops); validation is the owner team's.
    expect(units.map((u) => u.key)).toEqual(['release:dp-1:0'])
    const net = await loadChangeUnits(session, 't1', { by: 'open', teamId: 'net' })
    expect(net.map((u) => u.key)).toEqual(['assessment:mine'])
    expect(h.calls[0]!.params).toEqual({ tenantId: 't1', teamId: 'ops' })
  })

  it('a step whose CI has no team measures no team segment', async () => {
    h.plans = [plan({ ownerTeamId: null, supportTeamId: null })]
    const units = await loadChangeUnits(session, 't1', { by: 'change', changeId: 'chg-7' })
    expect(units.every((u) => u.segments.length === 0)).toBe(true)
  })
})

describe('the scope filters in the queries', () => {
  it('each scope filters differently, and every query is tenant-scoped', () => {
    for (const s of ['change', 'concluded', 'open'] as const) {
      expect(assessmentUnitsCypher(s)).toContain('tenant_id: $tenantId')
      expect(deployPlanUnitsCypher(s)).toContain('tenant_id: $tenantId')
    }
    expect(assessmentUnitsCypher('concluded')).toContain('t.completed_at >= $cutoff')
    expect(assessmentUnitsCypher('open')).toContain(':Team {id: $teamId}')
    expect(deployPlanUnitsCypher('open')).toContain('v.tested_at IS NULL OR d.deployed_at IS NULL')
    expect(deployPlanUnitsCypher('concluded')).toContain('d.deployed_at >= $cutoff')
  })
})
