/**
 * The clean-up of a demo tenant (tour of 23 Sep 2026: D6, D47, D60 and the
 * play on top of the demo). A fake graph and a fake queue: what matters here
 * is WHAT the clean-up asks for — which labels it sweeps and how, what it
 * puts back and when it must not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  run: null as Record<string, unknown> | null,
  highest: {} as Record<string, string | null>,
  jobs: [] as Array<{ id: string; data: { tenantId: string; entityId: string } }>,
  alive: [] as string[],
  removed: [] as string[],
}))

function answer(cypher: string, params: Record<string, unknown>): Array<Record<string, unknown>> {
  if (cypher.includes('MATCH (r:DemoDataRun')) return fake.run ? [fake.run] : []
  if (cypher.includes('db.labels()')) return ['Incident', 'Anomaly', 'InAppNotification', 'Counter', 'AuditEntry', 'NotificationRule', 'AssessmentTask'].map((label) => ({ label }))
  if (cypher.includes('RETURN sum(c) AS n')) return [{ n: 0 }]
  if (cypher.includes('ORDER BY size(')) {
    const label = /MATCH \(n:(\w+)/.exec(cypher)![1]!
    const code = fake.highest[label]
    return code ? [{ code }] : []
  }
  if (cypher.includes('UNWIND $ids AS id')) return fake.alive.filter((id) => (params['ids'] as string[]).includes(id)).map((id) => ({ id }))
  if (cypher.includes('RETURN count(*) AS n')) return [{ n: 2 }]
  return []
}

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    run: async (cypher: string, params: Record<string, unknown>) => {
      fake.queries.push({ cypher, params })
      return { records: [] }
    },
    executeWrite: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({ run: async (cypher, params) => { fake.queries.push({ cypher, params }); return { records: [] } } }),
    close: async () => undefined,
  }),
  runQuery: async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    fake.queries.push({ cypher, params })
    return answer(cypher, params)
  },
}))
vi.mock('../../../bullmq.js', () => ({
  getQueue: () => ({
    getJobs: async ([state]: string[], start: number) => (state === 'delayed' && start === 0 ? fake.jobs : []),
    remove: async (id: string) => { fake.removed.push(id); return 1 },
  }),
}))

const { cleanDemoTenant, sequenceOf, WORK_SINCE_RUN, DERIVED_LABELS } = await import('../clean.js')

const writes = (pattern: string) => fake.queries.filter((q) => q.cypher.includes(pattern))
const RUN = { id: 'r1', startedAt: '2026-09-23T03:38:14.274Z', limits: null, eventPolicy: null, hasEventPolicy: false, retention: null, hasRetention: false, rules: null }

beforeEach(() => {
  fake.queries = []; fake.run = { ...RUN }; fake.highest = {}; fake.jobs = []; fake.alive = []; fake.removed = []
})

describe('the sweep lists', () => {
  it('work only: no configuration label is ever swept by time', () => {
    const swept = new Set([...WORK_SINCE_RUN.map(([l]) => l), ...DERIVED_LABELS])
    for (const config of ['NotificationRule', 'SLAPolicy', 'WorkflowDefinition', 'WorkflowStep', 'Role', 'User', 'Team', 'Counter',
      'DashboardConfig', 'EnumTypeDefinition', 'FormField', 'ServiceCatalogItem', 'AutoTrigger', 'BusinessRule', 'Tenant', 'AnomalyConfig']) {
      expect(swept.has(config), config).toBe(false)
    }
  })

  it('the number inside a code', () => {
    expect(sequenceOf('INC00000042')).toBe(42)
    expect(sequenceOf('TKT-000123')).toBe(123)
    expect(sequenceOf('TASK00207618')).toBe(207618)
    expect(sequenceOf(null)).toBeNull()
    expect(sequenceOf('no digits')).toBeNull()
  })
})

describe('cleanDemoTenant', () => {
  it('D47: the anomalies and the bell notifications go whole; the work only when written after the first run started', async () => {
    await cleanDemoTenant('demo', () => undefined)
    expect(writes('MATCH (n:Anomaly {tenant_id: $tenantId}) CALL')).toHaveLength(1)
    expect(writes('MATCH (n:InAppNotification {tenant_id: $tenantId}) CALL')).toHaveLength(1)
    const incidents = writes('MATCH (n:Incident {tenant_id: $tenantId}) WHERE n.demo_run_id IS NULL AND n[$at] >= $since')
    expect(incidents).toHaveLength(1)
    expect(incidents[0]!.params).toMatchObject({ since: RUN.startedAt, at: 'created_at' })
    // A label that is not in the database is not swept.
    expect(writes('MATCH (n:Problem {tenant_id: $tenantId}) WHERE n.demo_run_id IS NULL')).toHaveLength(0)
  })

  it('the history of people and work that no longer exist goes, whenever it was written; the synthetic actors are not people', async () => {
    fake.run = null
    await cleanDemoTenant('demo', () => undefined)
    const orphans = writes('NOT EXISTS { MATCH (:User {id: a.user_id, tenant_id: $tenantId}) }')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.params['synthetic']).toEqual(expect.arrayContaining(['system', 'monitoring', 'automation']))
    expect(orphans[0]!.cypher).toContain('a.demo_run_id IS NULL')
  })

  it('without a run record nothing is swept by time', async () => {
    fake.run = null
    await cleanDemoTenant('demo', () => undefined)
    expect(writes('n.demo_run_id IS NULL AND n[$at] >= $since')).toHaveLength(0)
  })

  it('D6: a counter goes to the highest number left, or away when nothing is left — never to the recorded value', async () => {
    fake.highest = { Incident: 'INC00000007', AssessmentTask: 'TASK00000012' }
    await cleanDemoTenant('demo', () => undefined)
    const merged = writes('MERGE (c:Counter').map((q) => [q.params['kind'], Number(q.params['value'])])
    expect(merged).toEqual([['incident', 7], ['task', 12]])
    const deleted = writes('DELETE c').map((q) => q.params['kind'])
    expect(deleted).toEqual(['problem', 'change', 'service_request'])
  })

  it('D4: an event policy the run did not record is not touched — writing its absence would take it away', async () => {
    await cleanDemoTenant('demo', () => undefined)
    expect(writes('SET t.event_policy')).toHaveLength(0)
    fake.run = { ...RUN, hasEventPolicy: true, eventPolicy: '{"retention_days":30}' }
    await cleanDemoTenant('demo', () => undefined)
    expect(writes('SET t.event_policy').map((q) => q.params['policy'])).toEqual(['{"retention_days":30}'])
  })

  it('D55 and D58: the retention and the notification rules come back as the first run found them', async () => {
    fake.run = { ...RUN, hasRetention: true, retention: 90, rules: JSON.stringify([{ id: 'n1', target: 'all', enabled: true }]) }
    await cleanDemoTenant('demo', () => undefined)
    expect(Number(writes('SET t.inapp_notification_retention_days')[0]!.params['days'])).toBe(90)
    expect(writes('SET r.target = rule.target')[0]!.params['rules']).toEqual([{ id: 'n1', target: 'all', enabled: true, channels: null }])
  })

  it('D60: only the SLA timers of this tenant\'s tickets that no longer exist leave the queue', async () => {
    fake.jobs = [
      { id: 'breach-gone', data: { tenantId: 'demo', entityId: 'gone' } },
      { id: 'warning-kept', data: { tenantId: 'demo', entityId: 'kept' } },
      { id: 'breach-other', data: { tenantId: 'other', entityId: 'x' } },
    ]
    fake.alive = ['kept']
    await cleanDemoTenant('demo', () => undefined)
    expect(fake.removed).toEqual(['breach-gone'])
  })
})
