import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'
import type { InAppNotification } from '../sse.js'

// Complements dispatcher.test.ts (email escaping, notifications_enabled
// recipients, Teams routing on sla.breached). Covered here: NotificationRule
// lookup + cache, in_app fan-out, Slack routing per tenant, email batching,
// the "one channel fails" contract, workflow.step.entered guards.

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let userRows: Array<Record<string, unknown>> = []
let channelRows: Array<Record<string, unknown>> = []
let ruleRows: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          if (cypher.includes('MATCH (u:User'))         return { records: userRows.map(r => ({ get: (k: string) => r[k] })) }
          if (cypher.includes('NotificationChannel'))   return { records: channelRows.map(r => ({ get: () => ({ properties: r }) })) }
          if (cypher.includes('NotificationRule'))      return { records: ruleRows.map(r => ({ get: () => ({ properties: r }) })) }
          return { records: [] }
        },
      }),
    close: async () => {},
  }),
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
  loggableUrl: (u: string) => { try { return new URL(u).host } catch { return '<invalid-url>' } },
}))
const sendEmail = vi.fn<(msg: { to: string[]; subject: string; html: string }) => Promise<void>>(async () => {})
vi.mock('../email.js', () => ({ sendEmail }))

type FetchInit = { method: string; headers: Record<string, string>; body: string }
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
  async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
)
vi.stubGlobal('fetch', fetchMock)

const { NotificationDispatcher, invalidateRuleCache } = await import('../dispatcher.js')
const { sseManager } = await import('../sse.js')

function rule(channels: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'rule-1', enabled: true, severity_override: 'warning', title_key: 'notification.incident.created.title', channels, target: 'all', ...over }
}
function slackChannel(id: string, events: string[]): Record<string, unknown> {
  return { id, platform: 'slack', webhook_url: `https://hooks.slack.example/${id}`, channel_id: null, event_types: JSON.stringify(events) }
}
function teamsChannel(id: string, events: string[], webhook: string | null = `https://teams.example/${id}`): Record<string, unknown> {
  return { id, platform: 'teams', webhook_url: webhook, channel_id: null, event_types: JSON.stringify(events) }
}
function event(type: string, payload: Record<string, unknown>, tenantId = 't1'): DomainEvent<unknown> {
  return { id: `evt-${type}`, type, tenant_id: tenantId, timestamp: '2026-09-08T10:00:00.000Z', correlation_id: 'c', actor_id: 'u', payload }
}
const incidentPayload = { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'open', assignedTo: 'Mario', ciName: 'db-01' }

let sendToTenant: MockInstance<(tenantId: string, event: InAppNotification) => void>

beforeEach(() => {
  runQueries.length = 0
  userRows = []
  channelRows = []
  ruleRows = []
  sendEmail.mockClear()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  for (const t of ['t1', 't2', 't3']) invalidateRuleCache(t)
  sendToTenant = vi.spyOn(sseManager, 'sendToTenant').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Rule lookup ──────────────────────────────────────────────────────────────

describe('NotificationDispatcher.process — rule lookup', () => {
  it('no NotificationRule for (tenant, event) → no dispatch on any channel', async () => {
    const d = new NotificationDispatcher()
    await d.process(event('incident.created', incidentPayload))
    const q = runQueries.find(q => q.cypher.includes('NotificationRule'))!
    expect(q.params).toEqual({ tenantId: 't1', eventType: 'incident.created' })
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('a disabled rule behaves like no rule', async () => {
    ruleRows = [rule(['in_app', 'email', 'slack'], { enabled: false })]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(sendToTenant).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rule with in_app → one SSE broadcast to the tenant with title_key/severity_override/entity fields', async () => {
    ruleRows = [rule(['in_app'])]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    const [tenantId, n] = sendToTenant.mock.calls[0]!
    expect(tenantId).toBe('t1')
    expect(n).toMatchObject({
      type: 'incident.created',
      title: 'notification.incident.created.title',
      severity: 'warning',
      entity_id: 'inc-1',
      entity_type: 'incident',
      message: 'DB down — critical — Mario',
      timestamp: '2026-09-08T10:00:00.000Z',
      read: false,
    })
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('rule missing channels/target → defaults in_app / all', async () => {
    ruleRows = [{ id: 'r', enabled: true, title_key: 'k' }]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    expect(sendToTenant.mock.calls[0]![1].severity).toBe('info')
  })

  it('caches the rule per (tenant, event) for 60s; invalidateRuleCache and TTL expiry re-query', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T10:00:00.000Z'))
    ruleRows = [rule(['in_app'])]
    const d = new NotificationDispatcher()
    const ruleQueries = () => runQueries.filter(q => q.cypher.includes('NotificationRule')).length

    await d.process(event('incident.created', incidentPayload))
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(1)

    // another tenant is a different cache key
    await d.process(event('incident.created', incidentPayload, 't2'))
    expect(ruleQueries()).toBe(2)

    invalidateRuleCache('t1', 'incident.created')
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(3)

    vi.setSystemTime(new Date('2026-09-08T10:01:00.001Z'))   // 60s + 1ms later
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(4)

    // a null (no rule) result is cached too
    ruleRows = []
    invalidateRuleCache('t1')
    await d.process(event('incident.created', incidentPayload))
    await d.process(event('incident.created', incidentPayload))
    expect(ruleQueries()).toBe(5)
    expect(sendToTenant).toHaveBeenCalledTimes(5)   // the two "no rule" calls broadcast nothing
  })
})

// ── Slack / Teams routing ────────────────────────────────────────────────────

describe('NotificationDispatcher — Slack routing per tenant', () => {
  it('incident.created with a slack rule → only the tenant slack channels subscribed to "assigned"', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [
      slackChannel('s-assigned', ['assigned']),
      slackChannel('s-other', ['resolved']),
      teamsChannel('t-assigned', ['assigned']),   // rule says slack only
    ]
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))

    const channelQuery = runQueries.find(q => q.cypher.includes('NotificationChannel'))!
    expect(channelQuery.params).toEqual({ tenantId: 't1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://hooks.slack.example/s-assigned')
    const text = init.body
    expect(text).toContain('DB down')
    expect(text).toContain('*CI Affected:* db-01')
    expect(text).toContain('*Assegnato a:* Mario')
    expect(sendToTenant).not.toHaveBeenCalled()
  })

  it('rule with slack AND teams → both platforms of the tenant, each with its own format', async () => {
    ruleRows = [rule(['slack', 'teams'])]
    channelRows = [slackChannel('s', ['escalation']), teamsChannel('t', ['escalation'])]
    await new NotificationDispatcher().process(event('incident.escalated', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s', 'https://teams.example/t'])
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toHaveProperty('blocks')
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toHaveProperty('attachments')
  })

  it('incident.resolved → "resolved", incident.assigned → "assigned" subscriptions', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-res', ['resolved']), slackChannel('s-asg', ['assigned'])]
    const d = new NotificationDispatcher()
    await d.process(event('incident.resolved', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-res'])
    fetchMock.mockClear()
    await d.process(event('incident.assigned', incidentPayload))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-asg'])
  })

  it('incident event without id/title → explicit error (no half-formatted message)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s', ['assigned'])]
    await expect(new NotificationDispatcher().process(event('incident.created', { id: 'inc-1' })))
      .rejects.toThrow('incident notification event missing id/title: incident.created')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('event type with no Slack/Teams mapping (e.g. problem.created) → no dispatch, no error (pinned; NB: no log line either)', async () => {
    ruleRows = [rule(['slack', 'in_app'])]
    channelRows = [slackChannel('s', ['assigned'])]
    await expect(new NotificationDispatcher().process(event('problem.created', { id: 'prb-1', title: 'x' }))).resolves.toBeUndefined()
    expect(sendToTenant).toHaveBeenCalledTimes(1)   // in_app still goes out
    expect(fetchMock).not.toHaveBeenCalled()
    expect(runQueries.some(q => q.cypher.includes('NotificationChannel'))).toBe(false)
  })

  it('change.approved → slack channels subscribed to change_approved (Change enrichment query on the tenant)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-chg', ['change_approved']), slackChannel('s-inc', ['assigned'])]
    await new NotificationDispatcher().process(event('change.approved', { id: 'chg-1', title: 'Upgrade', type: 'normal', status: 'approved' }))
    expect(runQueries.find(q => q.cypher.includes('MATCH (c:Change'))!.params).toEqual({ id: 'chg-1', tenantId: 't1' })
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-chg'])
  })

  it('change.approved without id/title → nothing sent, no error (pinned)', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-chg', ['change_approved'])]
    await expect(new NotificationDispatcher().process(event('change.approved', { id: 'chg-1' }))).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('change.task_assigned → slack channels subscribed to change_task_assigned', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-task', ['change_task_assigned']), teamsChannel('t-task', ['change_task_assigned'])]
    await new NotificationDispatcher().process(event('change.task_assigned', {
      changeId: 'chg-1', changeTitle: 'Upgrade', taskId: 'task-1', ciName: 'db-01', teamName: 'DBA', assignedTo: 'Mario',
    }))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-task'])
  })

  it('sla.breached on an incident → slack channels subscribed to sla_breach with a synthetic title', async () => {
    ruleRows = [rule(['slack'])]
    channelRows = [slackChannel('s-sla', ['sla_breach']), slackChannel('s-asg', ['assigned'])]
    await new NotificationDispatcher().process(event('sla.breached', { entity_type: 'incident', entity_id: 'inc-9', breached_at: 'x' }))
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual(['https://hooks.slack.example/s-sla'])
    expect(fetchMock.mock.calls[0]![1].body).toContain('SLA breach su incident inc-9')
  })

  it('sla.breached on a problem with a teams channel lacking webhook_url → explicit error', async () => {
    ruleRows = [rule(['teams'])]
    channelRows = [teamsChannel('t-broken', ['sla_breach'], null)]
    await expect(new NotificationDispatcher().process(event('sla.breached', { entity_type: 'problem', entity_id: 'prb-1' })))
      .rejects.toThrow('Teams NotificationChannel t-broken has no webhook_url')
  })
})

// ── Email ────────────────────────────────────────────────────────────────────

describe('NotificationDispatcher — email channel', () => {
  it('no eligible recipient → sendEmail not called', async () => {
    ruleRows = [rule(['email'])]
    userRows = []
    await new NotificationDispatcher().process(event('incident.created', incidentPayload))
    expect(runQueries.some(q => q.cypher.includes('MATCH (u:User'))).toBe(true)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('subject = [tenant] title: message(≤80 chars); html carries the entity link; recipients batched by 50', async () => {
    ruleRows = [rule(['email'])]
    userRows = Array.from({ length: 120 }, (_, i) => ({ email: `u${i}@x.example` }))
    const longTitle = 'x'.repeat(200)
    await new NotificationDispatcher().process(event('incident.created', { ...incidentPayload, title: longTitle }))

    expect(sendEmail).toHaveBeenCalledTimes(3)
    const sizes = sendEmail.mock.calls.map(c => c[0].to.length)
    expect(sizes).toEqual([50, 50, 20])
    const first = sendEmail.mock.calls[0]![0]
    expect(first.subject.startsWith('[t1] notification.incident.created.title: ')).toBe(true)
    expect(first.subject.length).toBe('[t1] notification.incident.created.title: '.length + 80)
    expect(first.html).toContain('/incidents/inc-1')
    expect(first.to[0]).toBe('u0@x.example')
  })

  it('a failing sendEmail propagates (job fails → retry), after the in_app broadcast already went out', async () => {
    ruleRows = [rule(['in_app', 'email'])]
    userRows = [{ email: 'ops@x.example' }]
    sendEmail.mockRejectedValueOnce(new Error('resend down'))
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload))).rejects.toThrow('resend down')
    expect(sendToTenant).toHaveBeenCalledTimes(1)
  })

  it('pinned order + contract: slack fails → error propagates and the email channel is NOT attempted', async () => {
    ruleRows = [rule(['slack', 'email'])]
    channelRows = [slackChannel('s', ['assigned'])]
    userRows = [{ email: 'ops@x.example' }]
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    await expect(new NotificationDispatcher().process(event('incident.created', incidentPayload)))
      .rejects.toThrow('Slack webhook rejected the message: HTTP 503')
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

// ── workflow.step.entered ────────────────────────────────────────────────────

describe('NotificationDispatcher — workflow.step.entered (rule embedded in the payload)', () => {
  const step = (channels: string[]) => event('workflow.step.entered', {
    stepName: 'Assessment', entityType: 'change', entityId: 'chg-1',
    notifyRule: { title_key: 'wf.step', severity: 'info', channels, target: 'all' },
  })

  it('does not look up NotificationRule; in_app → SSE with the step name as message', async () => {
    await new NotificationDispatcher().process(step(['in_app']))
    expect(runQueries.some(q => q.cypher.includes('NotificationRule'))).toBe(false)
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    expect(sendToTenant.mock.calls[0]![1]).toMatchObject({ title: 'wf.step', message: 'Assessment', entity_id: 'chg-1', entity_type: 'change' })
  })

  it('missing notifyRule → explicit error', async () => {
    await expect(new NotificationDispatcher().process(event('workflow.step.entered', { stepName: 's' })))
      .rejects.toThrow('workflow.step.entered event without notifyRule payload')
  })

  it('unsupported channel (slack/teams) → in_app/email still delivered, then an explicit error names the channels', async () => {
    userRows = [{ email: 'ops@x.example' }]
    await expect(new NotificationDispatcher().process(step(['in_app', 'email', 'slack', 'teams'])))
      .rejects.toThrow('unsupported channels [slack, teams]')
    expect(sendToTenant).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
