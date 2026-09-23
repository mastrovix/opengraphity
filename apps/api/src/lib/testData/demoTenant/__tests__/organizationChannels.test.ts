/**
 * D58, the notification channels of the demo (the owner's choice of 23 Sep
 * 2026: a real address, given to the run). The mutations are fakes here: what
 * matters is that a channel exists only when its address was given, that the
 * address goes to the Channels page's mutation and nowhere else, and that the
 * rules routed to it can be put back as they were.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routableChannels } from '@opengraphity/notifications'

const fake = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; input: Record<string, unknown> }>,
  rules: [] as Array<{ id: string; target: string; enabled: boolean; channels: string[] }>,
}))

vi.mock('@opengraphity/neo4j', () => ({ runQuery: async () => fake.rules }))
vi.mock('../../../../graphql/resolvers/notificationChannel.js', () => ({
  notificationChannelResolvers: { Mutation: { createNotificationChannel: async (_p: unknown, { input }: { input: Record<string, unknown> }) => {
    fake.channels.push(input); return { id: `ch-${String(fake.channels.length)}` }
  } } },
}))
vi.mock('../../../../graphql/resolvers/notificationRules.js', () => ({
  notificationRuleResolvers: { Mutation: { updateNotificationRule: async (_p: unknown, a: { id: string; input: Record<string, unknown> }) => { fake.updates.push(a); return {} } } },
}))
vi.mock('../../../../graphql/resolvers/organizationSettings.js', () => ({ organizationSettingsResolvers: { Mutation: {} } }))

const { createDemoChannels, firstStates, DEMO_CHANNEL_EVENTS, DEMO_CHANNEL_RULES } = await import('../organization.js')

const ctx = { tenantId: 'demo' } as never
const session = {} as never
const TEAMS = 'https://example.webhook.office.com/webhookb2/abc'

beforeEach(() => {
  fake.channels = []; fake.updates = []
  fake.rules = [{ id: 'r-assigned', target: 'team_owner', enabled: true, channels: ['in_app'] }, { id: 'r-change', target: 'team_owner', enabled: true, channels: ['in_app', 'slack'] }]
})

describe('D58: the channels of the demo', () => {
  it('without an address there is no channel and no rule is touched', async () => {
    const out = await createDemoChannels(session, ctx, {})
    expect(out).toEqual({ created: [], platforms: [], previous: [] })
    expect(fake.channels).toEqual([])
    expect(fake.updates).toEqual([])
  })

  it('an address given becomes a channel through the Channels page\'s mutation, and it is not returned to the caller', async () => {
    const out = await createDemoChannels(session, ctx, { DEMO_TEAMS_WEBHOOK_URL: `  ${TEAMS} ` })
    expect(fake.channels).toEqual([{ platform: 'teams', name: 'IT Operations', webhookUrl: TEAMS, eventTypes: [...DEMO_CHANNEL_EVENTS] }])
    expect(out.platforms).toEqual(['teams'])
    expect(JSON.stringify(out)).not.toContain('webhook.office.com')
  })

  it('the rules of what people do are routed to the platform, and their channels are remembered for the clean-up', async () => {
    const out = await createDemoChannels(session, ctx, { DEMO_TEAMS_WEBHOOK_URL: TEAMS, DEMO_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/C' })
    expect(fake.updates).toEqual([
      { id: 'r-assigned', input: { channels: ['in_app', 'teams', 'slack'] } },
      { id: 'r-change', input: { channels: ['in_app', 'slack', 'teams'] } },
    ])
    expect(out.previous.map((p) => [p.id, p.channels])).toEqual([['r-assigned', ['in_app']], ['r-change', ['in_app', 'slack']]])
  })

  it('the events are ones the product delivers to Slack and Teams, and never the ones the live system produces by itself', () => {
    for (const rule of DEMO_CHANNEL_RULES) expect(routableChannels(rule)).toEqual(expect.arrayContaining(['slack', 'teams']))
    expect(DEMO_CHANNEL_EVENTS).not.toContain('sla_breach')
    expect(DEMO_CHANNEL_EVENTS).not.toContain('escalation')
  })

  it('a rule changed twice is put back to its FIRST state', () => {
    const first = { id: 'r1', target: 'all', enabled: true, channels: ['in_app'] }
    expect(firstStates([first, { ...first, target: 'team_owner' }, { id: 'r2', target: 'all', enabled: false, channels: [] }]))
      .toEqual([first, { id: 'r2', target: 'all', enabled: false, channels: [] }])
  })
})
