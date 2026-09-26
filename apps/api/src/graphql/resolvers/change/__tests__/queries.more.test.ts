/**
 * Change queries: the parts the first suite does not reach.
 *
 * Why these behaviours matter:
 *
 *  - THE AFFECTED CIs panel is the change's working surface: each CI row
 *    carries its assessment, deploy-plan, validation, deployment and review
 *    task. If the batch loaders attached a response, an assignee or a
 *    "completed by" to the wrong task, people would answer or approve on
 *    someone else's behalf without noticing. Duplicate response rows (the
 *    OPTIONAL MATCH on the answering user can fan out) must not double an
 *    answer, which would double the risk score shown.
 *  - THE LIST FILTERS: a filter on a field the Change type does not expose must
 *    fail loudly (a dropped rule would widen the list behind the user's back),
 *    and list-valued fields are not offered as scalar filters.
 *  - THE CALENDAR: a window that overlaps the range belongs to it, a reversed
 *    or empty window never shows, a corrupt plan is COUNTED instead of hidden,
 *    and at the same start validation comes before release (process order).
 *  - QUESTION CATALOGS and LINKED TICKETS: every read is tenant scoped, and
 *    a weight never written counts as 1 (a 0 would make the question
 *    decorative in the risk score).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildSchema, type GraphQLResolveInfo } from 'graphql'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

type Handler = (cypher: string, params: Record<string, unknown>) => unknown
let onQuery: Handler = () => []
let onQueryOne: Handler = () => null
const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []

// The customer's fields of a change (they sort the list since 26 Sep 2026): none here.
vi.mock('../../ticketCustomFields.js', () => ({ requestCustomFieldDefs: async () => [] }))
vi.mock('../../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../ci-utils.js')>()),
  withSession: (fn: (s: unknown) => unknown) => fn({ fakeSession: true }),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    return onQuery(cypher, params)
  }),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    return onQueryOne(cypher, params)
  }),
  getSession: vi.fn(),
}))
vi.mock('../../../../lib/ciMetamodelForTenant.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  serviceRelPatternForTenant: vi.fn(async () => 'DEPENDS_ON'),
}))
vi.mock('../../../../lib/ciTypeFromLabels.js', () => ({
  ciTypeFromLabels: vi.fn((_t: string, labels: string[]) => `from-labels:${labels.join('+')}`),
}))

const q = await import('../queries.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: perms('admin') } as never

beforeEach(() => {
  onQuery = () => []
  onQueryOne = () => null
  calls.length = 0
})

const find = (fragment: string) => calls.filter((c) => c.cypher.includes(fragment))

// ── The list ────────────────────────────────────────────────────────────────

describe('changes — filters and priority', () => {
  it('without a schema, the fallback whitelist applies: a known field filters, an unknown one is refused', async () => {
    onQuery = (c) => (c.includes('count(c) AS total') ? [{ total: 3 }] : [])
    const out = await q.changes(null, { priority: 'high', filters: JSON.stringify({ rules: [{ field: 'code', operator: 'contains', value: 'CHG' }] }) }, ctx) as { total: number }
    const list = calls[0]!
    expect(list.cypher).toContain('c.priority = $priority')
    expect(list.params).toMatchObject({ tenantId: 't1', priority: 'high' })
    // The filter lands in BOTH the page and the count, or the pager would lie.
    expect(Object.keys(list.params).some((k) => k.startsWith('af_'))).toBe(true)
    expect(calls[1]!.cypher).toContain('c.priority = $priority')
    expect(out.total).toBe(3)

    await expect(q.changes(null, { filters: JSON.stringify({ rules: [{ field: 'why', operator: 'contains', value: 'x' }] }) }, ctx))
      .rejects.toThrow(/not allowed/)
  })

  it('with the schema, the scalar fields of Change are the whitelist, lists excluded', async () => {
    const schema = buildSchema('type Query { x: Int } type Change { code: String, why: String, tags: [String] }')
    const info = { schema } as GraphQLResolveInfo
    await q.changes(null, { filters: JSON.stringify({ rules: [{ field: 'why', operator: 'contains', value: 'db' }] }) }, ctx, info)
    expect(calls[0]!.cypher).toMatch(/AND \(.*c\.why/s)
    await expect(q.changes(null, { filters: JSON.stringify({ rules: [{ field: 'tags', operator: 'contains', value: 'x' }] }) }, ctx, info))
      .rejects.toThrow(/not allowed/)
  })

  // Review of 23 Sep 2026: the list filters its phase as `status`, which holds the step's name; Change has no such GraphQL field.
  it('the step filters as `status`, with several values, even with the schema', async () => {
    const schema = buildSchema('type Query { x: Int } type Change { code: String }')
    const info = { schema } as GraphQLResolveInfo
    await q.changes(null, { filters: JSON.stringify({ rules: [{ field: 'status', operator: 'in', value: ['implementation', 'closed'] }] }) }, ctx, info)
    expect(calls[0]!.cypher).toMatch(/AND \(.*c\.status/s)
    expect(Object.values(calls[0]!.params)).toContainEqual(['implementation', 'closed'])
  })

  it('an empty filter group adds nothing, and a missing count reads as zero', async () => {
    const out = await q.changes(null, { filters: JSON.stringify({ rules: [] }) }, ctx) as { total: number; items: unknown[] }
    expect(calls[0]!.cypher).toContain('WHERE coalesce(c.deleted, false) = false\n')
    expect(out).toEqual({ items: [], total: 0 })
  })
})

// ── The affected CIs ────────────────────────────────────────────────────────

describe('changeAffectedCIs', () => {
  const plan = JSON.stringify([{ title: 'Step 1', validationWindow: { start: '', end: '' }, releaseWindow: { start: '', end: '' } }])

  function graph() {
    onQuery = (c, p) => {
      if (c.includes('-[r:AFFECTS_CI]->(ci)')) {
        return [
          {
            ciProps: { id: 'ci-1', name: 'db-01' }, ciLabel: 'Database', ciPhase: 'assessment', riskScore: 7,
            ownerTask: { id: 'at-own', responder_role: 'owner', status: 'pending' },
            supportTask: { id: 'at-sup', responder_role: 'support', status: 'completed', score: 4 },
            deployPlan: { id: 'dp-1', status: 'pending', steps: plan },
            validation: { id: 'vt-1', status: 'pending' },
            deployment: { id: 'dt-1', status: 'pending' },
            review: { id: 'rv-1', status: 'pending' },
          },
          {
            // A CI that already has its type, and no task at all yet.
            ciProps: { id: 'ci-2', name: 'app-01', type: 'application' }, ciLabel: 'Application', ciPhase: 'assessment', riskScore: null,
            ownerTask: { status: 'orphan' }, supportTask: null, deployPlan: null, validation: null, deployment: null, review: null,
          },
        ]
      }
      if (c.includes('HAS_RESPONSE')) {
        expect(p['tenantId']).toBe('t1')
        const q1 = { id: 'q1', text: 'Downtime?', category: 'impact' }
        const opt = { id: 'o1', label: 'Yes', score: 3, sort_order: 1 }
        return [
          { taskId: 'at-sup', respId: 'r1', questionProps: q1, optionProps: opt, answeredAt: '2026-09-01', userProps: { id: 'u-7', name: 'Ada' } },
          // The same response again (fan-out): it must count once.
          { taskId: 'at-sup', respId: 'r1', questionProps: q1, optionProps: opt, answeredAt: '2026-09-01', userProps: { id: 'u-7', name: 'Ada' } },
          { taskId: 'at-sup', respId: 'r2', questionProps: { id: 'q2', text: 'Rollback?' }, optionProps: opt, answeredAt: '2026-09-02', userProps: null },
        ]
      }
      if (c.includes('COMPLETED_BY')) return [{ taskId: 'at-sup', userProps: { id: 'u-7', name: 'Ada' } }]
      if (c.includes('ASSIGNED_TO_TEAM')) return [{ taskId: 'dp-1', teamProps: { id: 'team-1', name: 'DBA' } }]
      if (c.includes('ASSIGNED_TO]->(u:User)')) return [{ taskId: 'at-own', userProps: { id: 'u-9', name: 'Bob' } }]
      return []
    }
  }

  it('attaches each loaded piece to its own task, and never to a neighbour', async () => {
    graph()
    const [first, second] = await q.changeAffectedCIs(null, { changeId: 'c1' }, ctx)

    expect(first!.ci).toMatchObject({ id: 'ci-1', type: 'from-labels:Database' })
    expect(first!.riskScore).toBe(7)
    expect(first!.assessmentOwner).toMatchObject({ id: 'at-own', responses: [], completedBy: null, assignedTeam: null })
    expect(first!.assessmentOwner!.assignee).toMatchObject({ id: 'u-9' })

    const support = first!.assessmentSupport!
    expect(support.responses.map((r) => r.question.id)).toEqual(['q1', 'q2'])
    expect(support.responses[0]!.answeredBy).toMatchObject({ id: 'u-7' })
    // A response whose user is gone shows no author rather than an empty user.
    expect(support.responses[1]!.answeredBy).toBeNull()
    expect(support.completedBy).toMatchObject({ id: 'u-7' })
    expect(support.assignee).toBeNull()

    expect(first!.deployPlan).toMatchObject({ id: 'dp-1', assignedTeam: { id: 'team-1' }, assignee: null, completedBy: null })
    expect(first!.deployPlan!.steps).toHaveLength(1)
    expect(first!.validation).toMatchObject({ id: 'vt-1' })
    expect(first!.deployment).toMatchObject({ id: 'dt-1' })
    expect(first!.review).toMatchObject({ id: 'rv-1' })

    // A stored type wins over the one derived from labels; a task without id is no task.
    expect(second!.ci.type).toBe('application')
    expect(second).toMatchObject({ riskScore: null, assessmentOwner: null, assessmentSupport: null, deployPlan: null, validation: null, deployment: null, review: null })
  })

  it('the loaders are scoped: responses only for assessment tasks, assignments for assessment AND plan tasks', async () => {
    graph()
    await q.changeAffectedCIs(null, { changeId: 'c1' }, ctx)
    expect(find('AFFECTS_CI')[0]!.params).toMatchObject({ changeId: 'c1', tenantId: 't1', ownerRole: 'owner', supportRole: 'support' })
    expect(find('HAS_RESPONSE')[0]!.params['taskIds']).toEqual(['at-own', 'at-sup'])
    expect(find('COMPLETED_BY')[0]!.params).toEqual({ taskIds: ['at-own', 'at-sup', 'dp-1'], tenantId: 't1' })
    expect(find('ASSIGNED_TO_TEAM')[0]!.params['taskIds']).toEqual(['at-own', 'at-sup', 'dp-1'])
  })

  it('a change with no tasks does not run the loaders at all', async () => {
    onQuery = (c) => (c.includes('-[r:AFFECTS_CI]->(ci)')
      ? [{ ciProps: { id: 'ci-3' }, ciLabel: 'Server', ciPhase: 'assessment', riskScore: null, ownerTask: null, supportTask: null, deployPlan: null, validation: null, deployment: null, review: null }]
      : [])
    const out = await q.changeAffectedCIs(null, { changeId: 'c1' }, ctx) as unknown[]
    expect(out).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})

// ── Audit trail, catalogs, linked tickets ───────────────────────────────────

describe('changeAuditTrail', () => {
  it('maps each entry with its actor, or none when the user is gone', async () => {
    onQuery = () => [
      { props: { timestamp: '2026-09-02', action: 'approved', detail_key: 'audit.approved' }, userProps: { id: 'u1', name: 'Ada' } },
      { props: { timestamp: '2026-09-01', action: 'created' }, userProps: null },
    ]
    const out = await q.changeAuditTrail(null, { changeId: 'c1' }, ctx)
    expect(out[0]).toMatchObject({ action: 'approved', detailKey: 'audit.approved', actor: { id: 'u1' } })
    expect(out[1]).toMatchObject({ action: 'created', detail: null, actor: null })
    expect(calls[0]!.params).toEqual({ changeId: 'c1', tenantId: 't1' })
  })
})

describe('assessmentQuestionCatalog and assessmentQuestionsAdmin', () => {
  function graph() {
    onQuery = (c) => {
      if (c.includes('HAS_OPTION')) {
        return [
          { questionId: 'q1', props: { id: 'o1', label: 'Low', score: 1, sort_order: 1 } },
          { questionId: 'q1', props: { id: 'o2', label: 'High', score: 5, sort_order: 2 } },
        ]
      }
      if (c.includes('is_core: true')) {
        return [
          { questionProps: { id: 'q1', text: 'Impact?', is_core: true, is_active: true }, weight: null, sortOrder: 1 },
          { questionProps: { id: 'q2', text: 'Rollback?' }, weight: 2.5, sortOrder: 2 },
        ]
      }
      return [{ props: { id: 'q1', text: 'Impact?' } }, { props: { id: 'q3', text: 'Unused' } }]
    }
  }

  it('the catalog filters by category only when asked, and a weight never written counts as 1', async () => {
    graph()
    const out = await q.assessmentQuestionCatalog(null, { category: 'impact' }, ctx)
    expect(calls[0]!.cypher).toContain('AND q.category = $category')
    expect(calls[0]!.params).toEqual({ tenantId: 't1', category: 'impact' })
    expect(out[0]).toMatchObject({ weight: 1, sortOrder: 1 })
    expect(out[0]!.question.options.map((o) => o.label)).toEqual(['Low', 'High'])
    expect(out[1]).toMatchObject({ weight: 2.5, question: { id: 'q2', options: [] } })

    calls.length = 0
    await q.assessmentQuestionCatalog(null, {}, ctx)
    expect(calls[0]!.cypher).not.toContain('q.category = $category')
    expect(calls[0]!.params['category']).toBeNull()
  })

  it('an empty catalog does not ask for options', async () => {
    const out = await q.assessmentQuestionCatalog(null, {}, ctx)
    expect(out).toEqual([])
    expect(find('HAS_OPTION')).toHaveLength(0)
  })

  it('the admin list gives every question its options, or an empty list', async () => {
    graph()
    const out = await q.assessmentQuestionsAdmin(null, null, ctx)
    expect(out.map((x) => [x.id, x.options.length])).toEqual([['q1', 2], ['q3', 0]])
    expect(calls[0]!.params).toEqual({ tenantId: 't1' })
    expect(find('HAS_OPTION')[0]!.params).toEqual({ ids: ['q1', 'q3'] })
  })
})

describe('changeResolvesIncidents / changeResolvesProblems', () => {
  it('each side fills the field the other one has, as null, so the UI renders one list', async () => {
    onQuery = () => [{ id: 'i1', number: 'INC1', title: 't', status: 'open', severity: 'high', removable: true }]
    expect(await q.changeResolvesIncidents({ id: 'c1' }, null, ctx)).toEqual([
      { id: 'i1', number: 'INC1', title: 't', status: 'open', severity: 'high', removable: true, priority: null },
    ])
    expect(calls[0]!.params).toEqual({ id: 'c1', tenantId: 't1' })

    onQuery = () => [{ id: 'p1', number: 'PRB1', title: 't', status: 'open', priority: 'p2', removable: false }]
    expect(await q.changeResolvesProblems({ id: 'c1' }, null, ctx)).toEqual([
      { id: 'p1', number: 'PRB1', title: 't', status: 'open', priority: 'p2', removable: false, severity: null },
    ])
    expect(calls[1]!.params).toEqual({ id: 'c1', tenantId: 't1' })
  })
})

describe('changeImpactedCIs — the mapping', () => {
  it('derives missing types from labels, defaults distance to 1 and path to empty', async () => {
    onQuery = () => [
      { impactedProps: { id: 'svc' }, impactedLabel: 'Service', affectedProps: { id: 'db', type: 'database' }, affectedLabel: 'Database', distance: null, pathNames: null },
      { impactedProps: { id: 'app', type: 'application' }, impactedLabel: 'Application', affectedProps: { id: 'db' }, affectedLabel: 'Database', distance: 2, pathNames: ['app', 'db'] },
    ]
    const out = await q.changeImpactedCIs(null, { changeId: 'c1' }, ctx)
    expect(out[0]).toMatchObject({ ci: { type: 'from-labels:Service' }, affectedBy: { type: 'database' }, distance: 1, impactPath: [] })
    expect(out[1]).toMatchObject({ ci: { type: 'application' }, affectedBy: { type: 'from-labels:Database' }, distance: 2, impactPath: ['app', 'db'] })
  })
})

// ── My tasks ────────────────────────────────────────────────────────────────

describe('myTasks — every change task kind lands in its column with its role and action', () => {
  it('assigned vs to-be-taken, each kind with the product sentence, newest first', async () => {
    const r = (id: string, createdAt: string, role?: string) => ({ id, code: id.toUpperCase(), role, status: 'pending', entityType: 'change', entityId: 'c1', entityNumber: 'CHG1', ciId: 'ci', ciName: 'db', phase: 'assessment', createdAt })
    onQuery = (c, p) => {
      expect(p).toMatchObject({ userId: 'u1', tenantId: 't1' })
      if (c.includes('MATCH (t:AssessmentTask)-[:ASSIGNED_TO]->')) return [r('a-own', '2026-09-01', 'owner')]
      if (c.includes('<-[:ASSIGNED_TO_TEAM]-(t:AssessmentTask)')) return [r('a-sup', '2026-09-02', 'support')]
      if (c.includes('HAS_VALIDATION')) return [r('val', '2026-09-03')]
      if (c.includes('MATCH (dp:DeployPlanTask)-[:ASSIGNED_TO]->')) return [r('dp-mine', '2026-09-04')]
      if (c.includes('<-[:ASSIGNED_TO_TEAM]-(dp:DeployPlanTask)')) return [r('dp-team', '2026-09-05')]
      if (c.includes('HAS_DEPLOYMENT')) return [r('dep', '2026-09-06')]
      if (c.includes('HAS_REVIEW')) return [r('rev', '2026-09-07')]
      return []
    }
    const out = await q.myTasks(null, null, ctx) as { assignedToMe: Array<Record<string, unknown>>; unassigned: Array<Record<string, unknown>> }
    const line = (t: Record<string, unknown>) => `${t['id']}|${t['kind']}|${t['role']}|${t['action']}`
    expect(out.assignedToMe.map(line)).toEqual([
      'dp-mine|deploy-plan|support|Fill in the deploy plan',
      'a-own|assessment|owner|Fill in the Functional assessment',
    ])
    expect(out.unassigned.map(line)).toEqual([
      'rev|review|owner|Confirm the outcome (Confirmed/Rejected)',
      'dep|deployment|support|Confirm the deploy',
      'dp-team|deploy-plan|support|Fill in the deploy plan',
      'val|validation|owner|Run the validation (Pass/Fail)',
      'a-sup|assessment|support|Fill in the Technical assessment',
    ])
  })
})

// ── The calendar ────────────────────────────────────────────────────────────

describe('changeCalendar — the entries', () => {
  const RANGE = { from: '2026-09-07T00:00:00Z', to: '2026-09-14T00:00:00Z' }
  const step = (title: string, v: [string, string], r: [string, string]) =>
    ({ title, validationWindow: { start: v[0], end: v[1] }, releaseWindow: { start: r[0], end: r[1] } })

  it('keeps overlapping windows, drops outside/empty ones, counts corrupt plans, and orders by start then kind then code', async () => {
    onQuery = () => [
      {
        changeId: 'c2', code: 'CHG2', title: 'Two', changeType: 'normal', priority: 'p2', currentStep: 'scheduled',
        taskCode: 'DP2', ciId: 'ci-2', ciName: null,
        steps: JSON.stringify([
          // Validation and release start together: validation first.
          step('S1', ['2026-09-10T10:00:00Z', '2026-09-10T11:00:00Z'], ['2026-09-10T10:00:00Z', '2026-09-10T12:00:00Z']),
          // Starts on Sunday before the range and ends inside it: it belongs here too.
          step('Overlap', ['', ''], ['2026-09-06T22:00:00Z', '2026-09-07T02:00:00Z']),
          // Entirely after the range.
          step('Later', ['2026-09-20T10:00:00Z', '2026-09-20T11:00:00Z'], ['2026-09-14T00:00:00Z', '2026-09-14T01:00:00Z']),
        ]),
      },
      {
        changeId: 'c1', code: 'CHG1', title: 'One', changeType: null, priority: null, currentStep: null,
        taskCode: null, ciId: null, ciName: null,
        steps: JSON.stringify([step('Same time', ['', ''], ['2026-09-10T10:00:00Z', '2026-09-10T10:30:00Z'])]),
      },
      { changeId: 'c3', code: 'CHG3', title: 'Broken', changeType: null, priority: null, currentStep: null, taskCode: null, ciId: 'ci-3', ciName: 'x', steps: '{not json' },
    ]
    onQueryOne = () => null
    const out = await q.changeCalendar(null, RANGE, ctx) as { entries: Array<Record<string, unknown>>; unreadablePlans: number }

    expect(out.entries.map((e) => `${e['code']}:${e['kind']}:${e['stepTitle']}`)).toEqual([
      'CHG2:release:Overlap',
      'CHG2:validation:S1',
      'CHG1:release:Same time',
      'CHG2:release:S1',
    ])
    // The CI name falls back to its id, and a plan with no CI shows none.
    expect(out.entries[0]).toMatchObject({ ciId: 'ci-2', ciName: 'ci-2', taskCode: 'DP2' })
    expect(out.entries[2]).toMatchObject({ ciId: '', ciName: '' })
    // A missing count reads as zero; the corrupt plan is still counted.
    expect(out.unreadablePlans).toBe(1)
    expect(calls[1]!.params).toEqual({ tenantId: 't1' })
  })

  it('a range bound without an explicit offset is refused before any read', async () => {
    await expect(q.changeCalendar(null, { from: '2026-09-07T00:00:00', to: RANGE.to }, ctx)).rejects.toThrow(/explicit UTC offset/)
    await expect(q.changeCalendar(null, { from: '', to: RANGE.to }, ctx)).rejects.toThrow(/empty or reversed/)
    expect(calls).toHaveLength(0)
  })
})
