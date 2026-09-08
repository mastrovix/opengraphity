import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks: no Neo4j, no Redis, no outbound HTTP ──────────────────────────────

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let userRows: Array<Record<string, unknown>> = []
let channelRows: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          if (cypher.includes('MATCH (u:User')) {
            return { records: userRows.map(r => ({ get: (k: string) => r[k] })) }
          }
          if (cypher.includes('NotificationChannel')) {
            return { records: channelRows.map(r => ({ get: () => ({ properties: r }) })) }
          }
          if (cypher.includes('NotificationRule')) {
            return { records: [] }
          }
          return { records: [] }
        },
      }),
    close: async () => {},
  }),
}))
vi.mock('@opengraphity/events', () => ({
  BaseConsumer: class { constructor(public queueName: string) {} async start() {} async stop() {} },
  assertSafeOutboundUrl: vi.fn(async () => {}),
}))
const sendEmail = vi.fn(async () => {})
vi.mock('../email.js', () => ({ sendEmail }))

const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
vi.stubGlobal('fetch', fetchMock)

const { renderNotificationEmail, NotificationDispatcher } = await import('../dispatcher.js')

beforeEach(() => {
  runQueries.length = 0
  userRows = []
  channelRows = []
  sendEmail.mockClear()
  fetchMock.mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('renderNotificationEmail — user content is escaped (D-11)', () => {
  it('escapes title and message; the link is built from safe parts', () => {
    const html = renderNotificationEmail({
      id: 'n1', type: 'incident.created',
      title: 'notification.incident.created.title',
      message: `<img src=x onerror="alert(1)"> DB down & <a href="http://evil">click</a>`,
      severity: 'error', entity_id: 'inc-1', entity_type: 'incident',
      timestamp: '2026-05-01T10:00:00.000Z', read: false,
    })
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a href="http://evil"')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; DB down &amp;')
    expect(html).toContain('/incidents/inc-1"')
  })

  it('omits the link when there is no entity id', () => {
    const html = renderNotificationEmail({
      id: 'n1', type: 'x', title: 't', message: 'm', severity: 'info',
      timestamp: '2026-05-01T10:00:00.000Z', read: false,
    })
    expect(html).not.toContain('<a ')
  })
})

describe('email recipients — notifications_enabled instead of demo-address patterns (D-20)', () => {
  it('the recipient query filters on coalesce(u.notifications_enabled, true) and has no address patterns', async () => {
    userRows = [{ email: 'ops@customer.example' }]
    const d = new NotificationDispatcher()
    // Reach dispatchEmail through the workflow-step path (rule embedded in payload, no NotificationRule lookup).
    await d.process({
      id: 'e1', type: 'workflow.step.entered', tenant_id: 't1', timestamp: '2026-05-01T10:00:00.000Z',
      correlation_id: 'c', actor_id: 'u',
      payload: { stepName: 'Assessment', entityType: 'change', entityId: 'chg-1',
                 notifyRule: { title_key: 'k', severity: 'info', channels: ['email'], target: 'all' } },
    })
    const userQuery = runQueries.find(q => q.cypher.includes('MATCH (u:User'))
    expect(userQuery).toBeDefined()
    expect(userQuery!.cypher).toContain('coalesce(u.notifications_enabled, true) = true')
    expect(userQuery!.cypher).not.toContain('@demo.')
    expect(userQuery!.cypher).not.toContain('opengrafo.com')
    expect(userQuery!.cypher).not.toContain('usr-')
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const arg = sendEmail.mock.calls[0]![0] as unknown as { to: string[]; html: string }
    expect(arg.to).toEqual(['ops@customer.example'])
  })
})

describe('Teams routing goes to the tenant NotificationChannel, never a global env webhook (D-07)', () => {
  it('sla.breached on a problem → adaptive card to each tenant teams channel subscribed to sla_breach', async () => {
    channelRows = [
      { id: 'ch-teams', platform: 'teams', webhook_url: 'https://tenant.example/hook', channel_id: null, event_types: JSON.stringify(['sla_breach']) },
      { id: 'ch-slack', platform: 'slack', webhook_url: 'https://slack.example/hook', channel_id: null, event_types: JSON.stringify(['sla_breach']) },
      { id: 'ch-other', platform: 'teams', webhook_url: 'https://other.example/hook', channel_id: null, event_types: JSON.stringify(['assigned']) },
    ]
    process.env['TEAMS_WEBHOOK_URL'] = 'https://global.example/must-not-be-used'
    const d = new NotificationDispatcher()
    // Private but the seam that matters; call through the class prototype.
    await (d as unknown as { dispatchToChannels: (e: unknown, c: string[]) => Promise<void> }).dispatchToChannels({
      id: 'e2', type: 'sla.breached', tenant_id: 't1', timestamp: '2026-05-01T10:00:00.000Z', correlation_id: 'c', actor_id: 'sla',
      payload: { entity_id: 'prb-1', entity_type: 'problem', breached_at: '2026-05-01T10:00:00.000Z' },
    }, ['in_app', 'teams'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe('https://tenant.example/hook')
    const body = JSON.parse(init.body) as { attachments: Array<{ content: { body: Array<{ text?: string }> } }> }
    expect(body.attachments[0]!.content.body[0]!.text).toContain('SLA Violato')
    delete process.env['TEAMS_WEBHOOK_URL']
  })

  it('a rule with teams only does not post to the tenant slack channels', async () => {
    channelRows = [
      { id: 'ch-slack', platform: 'slack', webhook_url: 'https://slack.example/hook', channel_id: null, event_types: JSON.stringify(['sla_breach']) },
    ]
    const d = new NotificationDispatcher()
    await (d as unknown as { dispatchToChannels: (e: unknown, c: string[]) => Promise<void> }).dispatchToChannels({
      id: 'e3', type: 'sla.breached', tenant_id: 't1', timestamp: '2026-05-01T10:00:00.000Z', correlation_id: 'c', actor_id: 'sla',
      payload: { entity_id: 'inc-1', entity_type: 'incident', breached_at: '2026-05-01T10:00:00.000Z' },
    }, ['teams'])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
