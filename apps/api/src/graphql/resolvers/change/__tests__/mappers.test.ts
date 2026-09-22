/**
 * The change mappers turn snake_case Neo4j nodes into the GraphQL shapes the
 * web renders. The contracts pinned here are the ones that decide what a user
 * SEES when data is incomplete:
 *  - a change without type or priority shows "—" (null), never a made-up
 *    "normal" or a priority derived on read that could contradict the stored
 *    one (B-14, B-25);
 *  - neo4j Integers arrive as JS numbers (a raw Integer object renders as
 *    "[object Object]" in the risk badge);
 *  - a corrupt deploy plan fails loudly instead of showing an empty plan;
 *  - the original node stays reachable for field resolvers (withTicketProps).
 */
import { describe, it, expect, vi } from 'vitest'
import neo4j from 'neo4j-driver'

// No real driver (importing the real package opens a connection pool): only
// the Integer conversion the mappers use, with the package's semantics.
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => { throw new Error('no database in this test') }),
  runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => {
    if (v === null || v === undefined) return 0
    if (typeof v === 'number') return v
    if (neo4j.isInt(v)) return v.toNumber()
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
    throw new TypeError(`[neo4j] toNumber: cannot convert ${typeof v} to a number`)
  },
}))
import {
  mapChange, mapAssessmentTask, mapAnswerOption, mapAssessmentQuestion, mapValidationTest,
  mapDeployPlanTask, mapDeploymentTask, mapReviewTask, mapAuditEntry,
} from '../mappers.js'
import { ticketPropsOf } from '../../../../lib/ticketProps.js'

describe('mapChange', () => {
  it('maps a complete change, converting a neo4j Integer risk score to a number', () => {
    const props = {
      id: 'chg-1', tenant_id: 't1', code: 'CHG00000001', number: 'CHG00000001', title: 'Patch DB',
      why: 'CVE', what: 'upgrade', aggregate_risk_score: neo4j.int(42), priority: 'high',
      approval_route: 'cab', change_type: 'normal', approval_status: 'approved', approval_at: '2026-09-01T00:00:00Z',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
    }
    const out = mapChange(props)
    expect(out).toMatchObject({
      id: 'chg-1', tenantId: 't1', title: 'Patch DB', why: 'CVE', what: 'upgrade',
      aggregateRiskScore: 42, priority: 'high', approvalRoute: 'cab', changeType: 'normal',
      approvalStatus: 'approved', approvalAt: '2026-09-01T00:00:00Z',
      requester: null, changeOwner: null, approvalBy: null,
    })
    // Field resolvers (requester, owner…) read the original node from here.
    expect(ticketPropsOf(out)).toBe(props)
  })

  it('B-14 / B-25: missing type, priority and risk stay null — nothing is derived or defaulted', () => {
    const out = mapChange({ id: 'chg-2', tenant_id: 't1', title: 'x', created_at: 'a', updated_at: 'b' })
    expect(out).toMatchObject({
      changeType: null, priority: null, aggregateRiskScore: null,
      why: null, what: null, approvalRoute: null, approvalStatus: null, approvalAt: null,
    })
  })

  it('a zero risk score is a real score, not a missing one', () => {
    expect(mapChange({ aggregate_risk_score: 0 }).aggregateRiskScore).toBe(0)
  })
})

describe('task and assessment mappers', () => {
  it('mapAssessmentTask: score converted, missing code becomes "" and missing score null', () => {
    expect(mapAssessmentTask({ id: 'a1', code: 'AT1', responder_role: 'owner', status: 'completed', score: neo4j.int(7), completed_at: 'z', created_at: 'c' }))
      .toMatchObject({ id: 'a1', code: 'AT1', responderRole: 'owner', score: 7, completedAt: 'z', responses: [] })
    expect(mapAssessmentTask({ id: 'a2', status: 'open', created_at: 'c' }))
      .toMatchObject({ code: '', score: null, completedAt: null, assignee: null })
  })

  it('mapAnswerOption and mapAssessmentQuestion: integers to numbers, flags to booleans', () => {
    expect(mapAnswerOption({ id: 'o1', label: 'Yes', score: neo4j.int(3), sort_order: 1 }))
      .toEqual({ id: 'o1', label: 'Yes', score: 3, sortOrder: 1 })
    expect(mapAssessmentQuestion({ id: 'q1', text: 'Downtime?', category: 'impact', is_core: 1, created_at: 'c' }))
      .toEqual({ id: 'q1', text: 'Downtime?', category: 'impact', isCore: true, isActive: false, createdAt: 'c', options: [] })
  })

  it('an answer option with a non-numeric score is corrupt data and fails loudly', () => {
    // No silent NaN: it would poison the aggregate risk score of every change using it.
    expect(() => mapAnswerOption({ id: 'o1', label: 'Yes', score: 'high', sort_order: 1 })).toThrow(/toNumber/)
  })

  it('validation, deployment and review tasks default missing optional fields to null', () => {
    expect(mapValidationTest({ id: 'v1', status: 'open' })).toEqual({ id: 'v1', code: '', status: 'open', result: null, testedAt: null, testedBy: null })
    expect(mapValidationTest({ id: 'v1', code: 'VT1', status: 'completed', result: 'pass', tested_at: 't' }))
      .toMatchObject({ code: 'VT1', result: 'pass', testedAt: 't' })
    expect(mapDeploymentTask({ id: 'd1', status: 'open' })).toEqual({ id: 'd1', code: '', status: 'open', deployedAt: null, deployedBy: null })
    expect(mapDeploymentTask({ id: 'd1', code: 'DT1', status: 'completed', deployed_at: 't' })).toMatchObject({ code: 'DT1', deployedAt: 't' })
    expect(mapReviewTask({ id: 'r1', status: 'open' })).toEqual({ id: 'r1', code: '', status: 'open', result: null, reviewedAt: null, reviewedBy: null })
    expect(mapReviewTask({ id: 'r1', code: 'RT1', status: 'completed', result: 'ok', reviewed_at: 't' })).toMatchObject({ code: 'RT1', result: 'ok', reviewedAt: 't' })
  })

  it('mapDeployPlanTask parses the steps and refuses a corrupt plan instead of showing an empty one', () => {
    const steps = [{
      title: 'Step 1',
      validationWindow: { start: '2026-09-01T08:00:00.000Z', end: '2026-09-01T09:00:00.000Z' },
      releaseWindow:    { start: '2026-09-01T10:00:00.000Z', end: '2026-09-01T11:00:00.000Z' },
    }]
    const out = mapDeployPlanTask({ id: 'p1', status: 'open', steps: JSON.stringify(steps), created_at: 'c' })
    expect(out).toMatchObject({ id: 'p1', code: '', steps, completedAt: null, assignee: null })
    expect(mapDeployPlanTask({ id: 'p2', code: 'DP2', status: 'completed', completed_at: 'z' })).toMatchObject({ code: 'DP2', steps: [], completedAt: 'z' })
    expect(() => mapDeployPlanTask({ id: 'p3', status: 'open', steps: '{broken' })).toThrow(/Corrupt deploy steps/)
  })

  it('mapAuditEntry keeps the i18n key and params, null when absent', () => {
    expect(mapAuditEntry({ timestamp: 't', action: 'approved', detail: 'ok', detail_key: 'k', detail_params: '{}' }))
      .toEqual({ timestamp: 't', action: 'approved', detail: 'ok', detailKey: 'k', detailParams: '{}', actor: null })
    expect(mapAuditEntry({ timestamp: 't', action: 'x' })).toMatchObject({ detail: null, detailKey: null, detailParams: null })
  })
})
