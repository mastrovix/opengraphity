import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks: no Neo4j, no Redis, no outbound HTTP ──────────────────────────────
// packages/notifications/src/consumer.ts = channel loading + Slack/Teams
// dispatch for a tenant (loadChannels / dispatchIncidentNotification / …).
// The BullMQ consumer with the Redis dedup lives in packages/events
// (BaseConsumer) — see packages/events/src/__tests__/consumerDedup.test.ts.

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let channelRows: Array<Record<string, unknown>> = []
let incidentRows: Array<Record<string, unknown>> = []
let changeRows: Array<Record<string, unknown>> = []
const sessionClose = vi.fn(async () => {})
let sessionsOpened = 0

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => {
    sessionsOpened++
    return {
      executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
        fn({
          run: async (cypher: string, params: Record<string, unknown>) => {
            runQueries.push({ cypher, params })
            if (cypher.includes('NotificationChannel')) {
              return { records: channelRows.map(r => ({ get: () => ({ properties: r }) })) }
            }
            if (cypher.includes('MATCH (i:Incident')) {
              return { records: incidentRows.map(r => ({ get: (k: string) => r[k] })) }
            }
            if (cypher.includes('MATCH (c:Change')) {
              return { records: changeRows.map(r => ({ get: (k: string) => r[k] })) }
            }
            return { records: [] }
          },
        }),
      close: sessionClose,
    }
  },
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
  loggableUrl: (u: string) => { try { return new URL(u).host } catch { return '<invalid-url>' } },
}))
vi.mock('../email.js', () => ({ sendEmail: vi.fn(async () => {}) }))

type FetchInit = { method: string; headers: Record<string, string>; body: string }
const fetchMock = vi.fn<(url: string, init: FetchInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
  async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
)
vi.stubGlobal('fetch', fetchMock)

const { loadChannels, dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification } = await import('../consumer.js')

function slackChannel(id: string, events: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, platform: 'slack', webhook_url: `https://hooks.slack.example/${id}`, channel_id: null, event_types: JSON.stringify(events), ...over }
}
function teamsChannel(id: string, events: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, platform: 'teams', webhook_url: `https://teams.example/${id}`, channel_id: null, event_types: JSON.stringify(events), ...over }
}
function bodyOf(call: number): unknown {
  return JSON.parse(fetchMock.mock.calls[call]![1].body)
}

const incident = { id: 'inc-1', title: 'DB down', severity: 'critical', status: 'open', tenantId: 't1' }

beforeEach(() => {
  runQueries.length = 0
  channelRows = []
  incidentRows = []
  changeRows = []
  sessionsOpened = 0
  sessionClose.mockClear()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env['SLACK_BOT_TOKEN']
  vi.restoreAllMocks()
})

// ── loadChannels ─────────────────────────────────────────────────────────────

describe('loadChannels — tenant NotificationChannel rows subscribed to the event', () => {
  it('queries only the active channels of THAT tenant and keeps those subscribed to the event type', async () => {
    channelRows = [
      slackChannel('s-yes', ['assigned', 'resolved']),
      slackChannel('s-no', ['sla_breach']),
      teamsChannel('t-yes', ['assigned']),
    ]
    const rows = await loadChannels('t1', 'assigned')
    expect(rows.map(r => r.id)).toEqual(['s-yes', 't-yes'])
    const q = runQueries[0]!
    expect(q.cypher).toContain('NotificationChannel {tenant_id: $tenantId, active: true}')
    expect(q.params).toEqual({ tenantId: 't1' })
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })

  it('platform filter (from the NotificationRule) restricts the result; missing event_types → not subscribed', async () => {
    channelRows = [
      slackChannel('s', ['assigned']),
      teamsChannel('t', ['assigned']),
      { id: 'no-events', platform: 'slack', webhook_url: 'https://x.example/h', channel_id: null }, // event_types absent
    ]
    expect((await loadChannels('t1', 'assigned', ['teams'])).map(r => r.id)).toEqual(['t'])
    expect((await loadChannels('t1', 'assigned', ['slack'])).map(r => r.id)).toEqual(['s'])
    expect((await loadChannels('t1', 'assigned', ['slack', 'teams'])).map(r => r.id)).toEqual(['s', 't'])
  })

  it('maps webhook_url/channel_id to null when absent', async () => {
    channelRows = [{ id: 'bare', platform: 'slack', event_types: JSON.stringify(['assigned']) }]
    const [row] = await loadChannels('t1', 'assigned')
    expect(row).toEqual({ id: 'bare', platform: 'slack', webhookUrl: null, channelId: null, eventTypes: ['assigned'] })
  })

  it('closes the session even when the query throws', async () => {
    channelRows = [{ id: 'broken', platform: 'slack', event_types: '{not json' }]
    await expect(loadChannels('t1', 'assigned')).rejects.toThrow(SyntaxError)
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

// ── dispatchIncidentNotification ─────────────────────────────────────────────

describe('dispatchIncidentNotification — Slack blocks / Teams adaptive card per channel', () => {
  it('slack channel with webhook → POST {blocks} to the tenant webhook; teams channel → adaptive card attachment', async () => {
    channelRows = [slackChannel('s1', ['assigned']), teamsChannel('t1', ['assigned'])]
    await dispatchIncidentNotification('t1', 'assigned', incident)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [slackUrl, slackInit] = fetchMock.mock.calls[0]!
    expect(slackUrl).toBe('https://hooks.slack.example/s1')
    expect(slackInit.method).toBe('POST')
    expect(slackInit.headers['Content-Type']).toBe('application/json')
    const slackBody = bodyOf(0) as { blocks: Array<{ type: string; text?: { text: string } }> }
    expect(slackBody.blocks[0]!.type).toBe('header')
    expect(slackBody.blocks[0]!.text!.text).toContain('DB down')
    expect(JSON.stringify(slackBody)).toContain('/incidents/inc-1')

    const [teamsUrl] = fetchMock.mock.calls[1]!
    expect(teamsUrl).toBe('https://teams.example/t1')
    const teamsBody = bodyOf(1) as { type: string; attachments: Array<{ contentType: string; content: { type: string } }> }
    expect(teamsBody.type).toBe('message')
    expect(teamsBody.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(teamsBody.attachments[0]!.content.type).toBe('AdaptiveCard')
  })

  it('enriches the incident from the graph (CI names, assignee) before formatting', async () => {
    channelRows = [slackChannel('s1', ['assigned'])]
    incidentRows = [{ ciNames: ['db-01', null], assignedTo: 'Mario Rossi', teamName: 'DBA' }]
    await dispatchIncidentNotification('t1', 'assigned', incident)

    const enrich = runQueries.find(q => q.cypher.includes('MATCH (i:Incident'))
    expect(enrich).toBeDefined()
    expect(enrich!.params).toEqual({ id: 'inc-1', tenantId: 't1' })
    const text = JSON.stringify(bodyOf(0))
    expect(text).toContain('*CI Affected:* db-01')
    expect(text).toContain('*Assegnato a:* Mario Rossi')
  })

  it('falls back to the team name when no user is assigned; "—" when neither', async () => {
    channelRows = [slackChannel('s1', ['assigned'])]
    incidentRows = [{ ciNames: [], assignedTo: null, teamName: 'DBA' }]
    await dispatchIncidentNotification('t1', 'assigned', incident)
    expect(JSON.stringify(bodyOf(0))).toContain('*Assegnato a:* DBA')

    fetchMock.mockClear()
    incidentRows = []
    await dispatchIncidentNotification('t1', 'assigned', incident)
    expect(JSON.stringify(bodyOf(0))).toContain('*Assegnato a:* —')
  })

  it('platforms restriction: only the listed platforms are contacted', async () => {
    channelRows = [slackChannel('s1', ['assigned']), teamsChannel('t1', ['assigned'])]
    await dispatchIncidentNotification('t1', 'assigned', incident, ['teams'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://teams.example/t1')
  })

  it('a channel of an unknown platform is ignored (no fetch, no throw)', async () => {
    channelRows = [{ id: 'mail', platform: 'email', webhook_url: null, channel_id: null, event_types: JSON.stringify(['assigned']) }]
    await expect(dispatchIncidentNotification('t1', 'assigned', incident)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // BUG (packages/notifications/src/consumer.ts:99): a Teams channel without a
  // webhook_url is skipped silently, while the analogous path in dispatcher.ts
  // (sla.breached, line 275) throws `Teams NotificationChannel … has no
  // webhook_url`. A misconfigured channel is a config error, not a no-op.
  it('teams channel without webhook_url → explicit error — BUG: silent skip (consumer.ts:99)', async () => {
    channelRows = [teamsChannel('t-broken', ['assigned'], { webhook_url: null })]
    await expect(dispatchIncidentNotification('t1', 'assigned', incident)).rejects.toThrow(/webhook_url/)
  })

  it('the first channel failing (non-2xx) stops the loop: the error propagates and later channels are NOT contacted (pinned)', async () => {
    channelRows = [slackChannel('s1', ['assigned']), slackChannel('s2', ['assigned'])]
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    await expect(dispatchIncidentNotification('t1', 'assigned', incident))
      .rejects.toThrow('Slack webhook rejected the message: HTTP 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('slack channel by channel_id needs SLACK_BOT_TOKEN: missing → throws before any fetch', async () => {
    channelRows = [slackChannel('s-api', ['assigned'], { webhook_url: null, channel_id: 'C123' })]
    await expect(dispatchIncidentNotification('t1', 'assigned', incident)).rejects.toThrow('SLACK_BOT_TOKEN non configurato')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('slack channel by channel_id with token → chat.postMessage with Bearer auth; Slack ok:false → throws', async () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test'
    channelRows = [slackChannel('s-api', ['assigned'], { webhook_url: null, channel_id: 'C123' })]
    await dispatchIncidentNotification('t1', 'assigned', incident)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(init.headers['Authorization']).toBe('Bearer xoxb-test')
    expect((bodyOf(0) as { channel: string }).channel).toBe('C123')

    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) }))
    await expect(dispatchIncidentNotification('t1', 'assigned', incident)).rejects.toThrow('channel_not_found')
  })

  it('slack channel with neither webhook nor channel id → throws', async () => {
    channelRows = [slackChannel('s-empty', ['assigned'], { webhook_url: null, channel_id: null })]
    await expect(dispatchIncidentNotification('t1', 'assigned', incident)).rejects.toThrow('neither webhookUrl nor channelId')
  })

  it('every session opened is closed (enrichment + channel lookup)', async () => {
    channelRows = [slackChannel('s1', ['assigned'])]
    await dispatchIncidentNotification('t1', 'assigned', incident)
    expect(sessionsOpened).toBe(2)
    expect(sessionClose).toHaveBeenCalledTimes(2)
  })
})

// ── dispatchChangeNotification / dispatchChangeTaskNotification ─────────────

describe('dispatchChangeNotification — Slack only, channels subscribed to change_approved', () => {
  it('posts the change blocks to slack channels; teams channels are ignored (pinned: no Teams change card)', async () => {
    channelRows = [slackChannel('s1', ['change_approved']), teamsChannel('t1', ['change_approved']), slackChannel('s2', ['assigned'])]
    changeRows = [{ ciNames: ['app-01'], assignedTo: null, teamName: 'Release' }]
    await dispatchChangeNotification('t1', { id: 'chg-1', title: 'Upgrade DB', type: 'normal', status: 'approved', tenantId: 't1' })

    const enrich = runQueries.find(q => q.cypher.includes('MATCH (c:Change'))
    expect(enrich!.cypher).toContain('coalesce(c.deleted, false) = false')
    expect(enrich!.params).toEqual({ id: 'chg-1', tenantId: 't1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.slack.example/s1')
    const text = JSON.stringify(bodyOf(0))
    expect(text).toContain('Upgrade DB')
    expect(text).toContain('*CI Affected:* app-01')
    expect(text).toContain('*Assegnato a:* Release')
    expect(text).toContain('/changes/chg-1')
  })
})

describe('dispatchChangeTaskNotification — Slack only, channels subscribed to change_task_assigned', () => {
  it('posts to the subscribed slack channels only', async () => {
    channelRows = [slackChannel('s1', ['change_task_assigned']), slackChannel('s2', ['change_approved']), teamsChannel('t1', ['change_task_assigned'])]
    await dispatchChangeTaskNotification('t1', {
      changeId: 'chg-1', changeTitle: 'Upgrade DB', taskId: 'task-1', ciName: 'db-01', teamName: 'DBA', assignedTo: 'Mario',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('https://hooks.slack.example/s1')
    expect(JSON.stringify(bodyOf(0))).toContain('Upgrade DB')
  })

  it('no subscribed channel → nothing sent, no error', async () => {
    channelRows = [slackChannel('s2', ['change_approved'])]
    await expect(dispatchChangeTaskNotification('t1', {
      changeId: 'chg-1', changeTitle: 'x', taskId: 't', ciName: '—', teamName: '—', assignedTo: '—',
    })).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
