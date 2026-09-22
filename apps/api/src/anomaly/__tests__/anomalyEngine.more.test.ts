/**
 * The anomaly scanner on a tenant WITH findings: what anomalyEngine.test.ts
 * (which only scans an empty graph) does not reach.
 *
 * Why these behaviours matter:
 *  - a rule hit becomes an Anomaly MERGEd on (tenant, rule, entity): the
 *    hourly scan must not open a duplicate every hour, and the Slack alert
 *    must count only the anomalies that are really NEW;
 *  - a rule whose query fails, or returns an unreadable row, must count as a
 *    failure (and fail the job) — never be treated as "nothing found", which
 *    would auto-resolve every open anomaly of that rule;
 *  - the admin configures types by name; the engine translates them to the
 *    tenant's Neo4j labels, and a configuration citing a type removed from the
 *    metamodel fails the rule loudly instead of scanning a narrower perimeter;
 *  - a Slack outage must not fail the scan (the anomalies are already saved).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Neo4j fake ────────────────────────────────────────────────────────────────

interface Run { q: string; p: Record<string, unknown> }
const reads: Run[] = []
const writes: Run[] = []
const state = {
  tenants: ['tenant-a'] as string[],
  /** Rows returned by the rule query. */
  hits: [] as Array<Record<string, unknown>>,
  ruleQueryFails: false,
  webhook: 'https://hooks.slack.example/T/B/X' as string | null,
  /** Entity ids whose anomaly already exists (MERGE matches, returns the old id). */
  existing: new Set<string>(),
}
const rec = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      run: async (q: string, p: Record<string, unknown>) => {
        reads.push({ q, p })
        if (q.includes('(t:Tenant)')) return { records: state.tenants.map((id) => rec({ id })) }
        if (q.includes('NotificationChannel')) return { records: state.webhook ? [rec({ webhookUrl: state.webhook })] : [] }
        if (state.ruleQueryFails) throw new Error('Unknown procedure gds.wcc.stream')
        return { records: state.hits.map(rec) }
      },
    })),
    executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      run: async (q: string, p: Record<string, unknown>) => {
        writes.push({ q, p })
        if (q.includes('MERGE (a:Anomaly')) {
          return { records: [rec({ id: state.existing.has(p['entityId'] as string) ? 'old-id' : p['newId'] })] }
        }
        return { records: [] }
      },
    })),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('@opengraphity/notifications', () => ({ sendSlackMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
vi.mock('../../lib/workflowHelpers.js', () => ({ getTerminalStepNames: vi.fn().mockResolvedValue(['closed']) }))
vi.mock('../../lib/bullmq.js', () => ({ createWorker: vi.fn(), getQueue: vi.fn() }))

vi.mock('../rules.js', () => ({
  buildAnomalyRule: vi.fn((key: string, settings: { severity: string }) => ({
    key, title: `Title of ${key}`, description: 'd', cypher: `RULE ${key}`, params: { severity: settings.severity },
  })),
}))

const base = { severity: 'high', ciTypes: [] as string[], relations: [], threshold: null, incidentSeverities: [], forbidden: [] as Array<{ fromType: string; relation: string; toType: string }>, isDefault: false, updatedAt: null }
const configs = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('../ruleConfig.js', () => ({
  loadAnomalyRuleConfigs: vi.fn(async () => configs.list),
  anomalyRuleOptions: vi.fn(async () => ({
    ciTypes: [{ name: 'server', label: 'Server', neo4jLabel: 'Server' }, { name: 'database', label: 'Database', neo4jLabel: 'DatabaseInstance' }],
    relations: ['DEPENDS_ON'], incidentSeverities: [],
  })),
  anomalyRuleProblem: vi.fn(() => null),
}))

const { scanTenant, anomalyScannerProcessor, resolveRule } = await import('../anomalyEngine.js')
const { sendSlackMessage } = await import('@opengraphity/notifications')
const { anomalyRuleProblem } = await import('../ruleConfig.js')
const { buildAnomalyRule } = await import('../rules.js')
const { logger } = await import('../../lib/logger.js')

const hit = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityId, entityType: 'ci', entitySubtype: 'server', entityName: `srv-${entityId}`,
  description: 'anomalies.orphan', params: { name: `srv-${entityId}` }, severity: 'high', ...over,
})
const merges = () => writes.filter((w) => w.q.includes('MERGE (a:Anomaly'))
const resolves = () => writes.filter((w) => w.q.includes("SET a.status = 'resolved'"))

beforeEach(() => {
  vi.clearAllMocks()
  reads.length = 0
  writes.length = 0
  state.tenants = ['tenant-a']
  state.hits = []
  state.ruleQueryFails = false
  state.webhook = 'https://hooks.slack.example/T/B/X'
  state.existing = new Set()
  configs.list = [{ ...base, ruleKey: 'orphan_ci', enabled: true }]
})

describe('scanTenant — hits become anomalies', () => {
  it('each hit is MERGEd in the tenant with its data; only new ones count as created', async () => {
    state.hits = [hit('ci-1'), hit('ci-2', { params: { count: { toNumber: () => 7 }, flag: true } })]
    state.existing.add('ci-2')
    const summary = await scanTenant('tenant-a')

    expect(summary).toEqual({ ruleFailures: 0, rules: [{ ruleKey: 'orphan_ci', title: 'Title of orphan_ci', hits: 2, created: 1, disabled: false, error: null }] })
    expect(merges().map((m) => m.p)).toEqual([
      expect.objectContaining({ tenantId: 'tenant-a', ruleKey: 'orphan_ci', entityId: 'ci-1', entitySubtype: 'server', severity: 'high', title: 'Title of orphan_ci' }),
      // Neo4j integers (toNumber) and booleans are stored as strings: the page interpolates them.
      expect.objectContaining({ entityId: 'ci-2', params: JSON.stringify({ count: '7', flag: 'true' }) }),
    ])
    // The rule query itself carries the tenant and the tenant's terminal incident steps.
    expect(reads.find((r) => r.q === 'RULE orphan_ci')!.p).toMatchObject({ tenantId: 'tenant-a', incidentTerminal: ['closed'], severity: 'high' })
    // Anomalies of this rule NOT in the current hits get resolved as "not detected".
    expect(resolves()[0]!.p).toMatchObject({ tenantId: 'tenant-a', ruleKey: 'orphan_ci', currentEntityIds: ['ci-1', 'ci-2'], reason: 'not_detected' })
  })

  it('new anomalies → one Slack alert naming the rule and the count of NEW ones', async () => {
    state.hits = [hit('ci-1'), hit('ci-2'), hit('ci-3')]
    state.existing.add('ci-3')
    await scanTenant('tenant-a')
    expect(sendSlackMessage).toHaveBeenCalledTimes(1)
    const [tenantId, url, , blocks] = vi.mocked(sendSlackMessage).mock.calls[0]!
    expect(tenantId).toBe('tenant-a')
    expect(url).toBe('https://hooks.slack.example/T/B/X')
    const text = JSON.stringify(blocks)
    expect(text).toContain('(2 new)')
    expect(text).toContain('*Title of orphan_ci*\\n2 new anomalies')
    // The channel lookup is scoped to the tenant.
    expect(reads.find((r) => r.q.includes('NotificationChannel'))!.p).toEqual({ tenantId: 'tenant-a' })
  })

  it('a rule with only known anomalies is left out of the Slack fields', async () => {
    configs.list = [{ ...base, ruleKey: 'orphan_ci', enabled: true }, { ...base, ruleKey: 'missing_owner', enabled: true }]
    state.hits = [hit('ci-1')]
    // ci-1 is new for the first rule; for the second rule it already exists.
    let n = 0
    state.existing = { has: () => n++ > 0 } as unknown as Set<string>
    await scanTenant('tenant-a')
    const text = JSON.stringify(vi.mocked(sendSlackMessage).mock.calls[0]![3])
    expect(text).toContain('Title of orphan_ci')
    expect(text).not.toContain('Title of missing_owner')
  })

  it('only already-known anomalies → no Slack alert at all', async () => {
    state.hits = [hit('ci-1')]
    state.existing.add('ci-1')
    await scanTenant('tenant-a')
    expect(sendSlackMessage).not.toHaveBeenCalled()
    expect(reads.some((r) => r.q.includes('NotificationChannel'))).toBe(false)
  })

  it('no active Slack channel → nothing sent, the scan still succeeds', async () => {
    state.hits = [hit('ci-1')]
    state.webhook = null
    const summary = await scanTenant('tenant-a')
    expect(summary.ruleFailures).toBe(0)
    expect(sendSlackMessage).not.toHaveBeenCalled()
  })

  it('a Slack outage is logged but does not fail the scan', async () => {
    state.hits = [hit('ci-1')]
    vi.mocked(sendSlackMessage).mockRejectedValueOnce(new Error('slack 503'))
    const summary = await scanTenant('tenant-a')
    expect(summary.ruleFailures).toBe(0)
    expect(vi.mocked(logger.error).mock.calls.some((c) => c[1] === 'anomaly-engine: slack notification failed')).toBe(true)
  })
})

describe('scanTenant — a broken rule is a failure, never "nothing found"', () => {
  it('a failing rule query: counted, reported, and its open anomalies are NOT auto-resolved', async () => {
    state.ruleQueryFails = true
    const summary = await scanTenant('tenant-a')
    expect(summary.ruleFailures).toBe(1)
    expect(summary.rules[0]).toMatchObject({ ruleKey: 'orphan_ci', error: 'Unknown procedure gds.wcc.stream' })
    expect(resolves()).toHaveLength(0)
    // The scan itself is still recorded.
    expect(writes.some((w) => w.q.includes('MERGE (c:AnomalyConfig'))).toBe(true)
  })

  it('a row whose params are not a map fails the rule (the page could not render it)', async () => {
    for (const params of [null, ['a'], 'text']) {
      writes.length = 0
      state.hits = [hit('ci-1', { params })]
      const summary = await scanTenant('tenant-a')
      expect(summary.rules[0]!.error).toMatch(/must return params as a map/)
      expect(merges()).toHaveLength(0)
      expect(resolves()).toHaveLength(0)
    }
  })

  it('a non-Error throw is reported as its string', async () => {
    vi.mocked(buildAnomalyRule).mockImplementationOnce(() => { throw 'bad settings' as unknown as Error })
    const summary = await scanTenant('tenant-a')
    expect(summary.rules[0]!.error).toBe('bad settings')
  })

  it('the job fails when any rule failed, across every tenant scanned', async () => {
    state.tenants = ['tenant-a', 'tenant-b']
    state.ruleQueryFails = true
    await expect(anomalyScannerProcessor({ name: 'scan', data: {} } as never))
      .rejects.toThrow('anomaly-engine: 2 rule(s) failed across 2 tenant(s)')
  })

  it('a job without data at all is the scheduled all-tenant scan', async () => {
    await expect(anomalyScannerProcessor({ name: 'scan' } as never)).resolves.toBeUndefined()
    expect(reads.some((r) => r.q.includes('(t:Tenant)'))).toBe(true)
  })
})

describe('resolveRule — the admin configures names, the engine uses the tenant labels', () => {
  const options = {
    ciTypes: [{ name: 'server', label: 'Server', neo4jLabel: 'Server' }, { name: 'database', label: 'Database', neo4jLabel: 'DatabaseInstance' }],
    relations: ['DEPENDS_ON'], incidentSeverities: [],
  }

  it('translates CI types and forbidden relations to Neo4j labels', () => {
    resolveRule({ ...base, ruleKey: 'forbidden_relation', enabled: true, ciTypes: ['database'], forbidden: [{ fromType: 'server', relation: 'DEPENDS_ON', toType: 'database' }] } as never, options)
    expect(vi.mocked(buildAnomalyRule).mock.calls[0]![1]).toMatchObject({
      ciLabels: ['DatabaseInstance'],
      forbiddenLabels: [{ fromLabel: 'Server', relation: 'DEPENDS_ON', toLabel: 'DatabaseInstance' }],
    })
  })

  it('a configuration the metamodel no longer supports throws the problem, without building the rule', () => {
    const problem = new Error('type "mainframe" no longer exists')
    vi.mocked(anomalyRuleProblem).mockReturnValueOnce(problem as never)
    expect(() => resolveRule({ ...base, ruleKey: 'orphan_ci', enabled: true, ciTypes: ['mainframe'] } as never, options)).toThrow(problem)
    expect(buildAnomalyRule).not.toHaveBeenCalled()
  })
})
