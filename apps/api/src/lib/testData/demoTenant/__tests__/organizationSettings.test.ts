/**
 * THE ORGANIZATION'S OWN SETTINGS (tour of 23 Sep 2026: D55, D58).
 *
 * organization.test.ts checks that what the demo asks for is something the
 * product accepts; organizationChannels.test.ts pins the channels. This file
 * pins how the settings are MADE, through the app's own mutations as the
 * tenant's administrator:
 *
 *  - D55: the retention of the bell notifications, as the Organization page
 *    sets it (not chosen, the nightly clean-up skips the tenant and the
 *    diagnostics warn on the first page);
 *  - D58: the factory rules narrowed — only those still at their factory
 *    recipient («everyone»): a rule someone already changed is theirs; the
 *    alarms' noise turned off only where it is on;
 *  - what every changed rule was BEFORE is returned, and a rule changed twice
 *    (narrowed, then routed to a channel) is put back to its first state by
 *    the clean-up.
 *
 * Neo4j and the resolvers are fakes: the fake store answers the two queries
 * as the database would, and the fake mutation applies the change to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'
import type { GraphQLContext } from '../../../../auth/resolveAuth.js'

interface StoredRule { id: string; event_type: string; target: string; enabled: boolean; channels: string[]; is_seed: boolean }

const fake = vi.hoisted(() => ({
  rules: [] as Array<{ id: string; event_type: string; target: string; enabled: boolean; channels: string[]; is_seed: boolean }>,
  reads: [] as Array<{ text: string; params: Record<string, unknown> }>,
  updates: [] as Array<{ id: string; input: Record<string, unknown> }>,
  retention: [] as Array<{ args: unknown; ctx: unknown }>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: async (_session: unknown, text: string, params: Record<string, unknown>) => {
    fake.reads.push({ text, params })
    const rows = text.includes('r.is_seed = true AND r.target = \'all\'')
      ? fake.rules.filter((r) => r.is_seed && r.target === 'all')
      : fake.rules.filter((r) => (params['events'] as string[]).includes(r.event_type))
    return rows.map((r) => ({ id: r.id, eventType: r.event_type, target: r.target, enabled: r.enabled, channels: [...r.channels] }))
  },
}))
vi.mock('../../../../graphql/resolvers/organizationSettings.js', () => ({
  organizationSettingsResolvers: { Mutation: { setTenantInAppRetentionDays: async (_p: unknown, args: unknown, ctx: unknown) => { fake.retention.push({ args, ctx }); return {} } } },
}))
vi.mock('../../../../graphql/resolvers/notificationRules.js', () => ({
  notificationRuleResolvers: {
    Mutation: {
      updateNotificationRule: async (_p: unknown, a: { id: string; input: Record<string, unknown> }) => {
        fake.updates.push(a)
        Object.assign(fake.rules.find((r) => r.id === a.id)!, a.input)
        return {}
      },
    },
  },
}))
vi.mock('../../../../graphql/resolvers/notificationChannel.js', () => ({
  notificationChannelResolvers: { Mutation: { createNotificationChannel: async () => ({ id: 'ch-1' }) } },
}))

const {
  setDemoRetention, tuneNotificationRules, createDemoChannels, firstStates,
  DEMO_INAPP_RETENTION_DAYS, DEMO_NOTIFICATION_TARGETS, DEMO_NOTIFICATIONS_OFF,
} = await import('../organization.js')

const ctx = { tenantId: 'demo', userId: 'admin-1', role: 'admin' } as unknown as GraphQLContext
const session = {} as Session

const rule = (event: string, over: Partial<StoredRule> = {}): StoredRule =>
  ({ id: `r-${event}`, event_type: event, target: 'all', enabled: true, channels: ['in_app'], is_seed: true, ...over })

beforeEach(() => {
  fake.reads = []
  fake.updates = []
  fake.retention = []
  // The factory rules of a tenant, all at «everyone», except what people changed.
  fake.rules = [
    ...DEMO_NOTIFICATION_TARGETS.map(([event]) => rule(event)),
    ...DEMO_NOTIFICATIONS_OFF.map((event) => rule(event)),
  ]
})

describe('D55: the retention of the bell notifications', () => {
  it('is set as the Organization page sets it, by the administrator', async () => {
    await setDemoRetention(ctx)
    expect(fake.retention).toEqual([{ args: { days: DEMO_INAPP_RETENTION_DAYS }, ctx }])
    expect(DEMO_INAPP_RETENTION_DAYS).toBe(90)
  })
})

describe('D58: the factory rules, narrowed', () => {
  it('reads only the factory rules still at their factory recipient, of this tenant', async () => {
    await tuneNotificationRules(session, ctx)
    expect(fake.reads).toHaveLength(1)
    expect(fake.reads[0]!.text).toContain('WHERE r.is_seed = true AND r.target = \'all\'')
    expect(fake.reads[0]!.params).toEqual({ tenantId: 'demo' })
  })

  it('gives every rule of the list its recipient with updateNotificationRule, and turns the alarms\' noise off', async () => {
    const previous = await tuneNotificationRules(session, ctx)
    expect(fake.updates).toEqual([
      ...DEMO_NOTIFICATION_TARGETS.map(([event, target]) => ({ id: `r-${event}`, input: { target } })),
      ...DEMO_NOTIFICATIONS_OFF.map((event) => ({ id: `r-${event}`, input: { enabled: false } })),
    ])
    // What each rule was before: everyone, on, in the app.
    expect(previous).toEqual(fake.updates.map((u) => ({ id: u.id, target: 'all', enabled: true, channels: ['in_app'] })))
    expect(fake.rules.find((r) => r.event_type === 'event.flapping')!.target).toBe('role:operator')
    expect(fake.rules.find((r) => r.event_type === 'event.stable')!.enabled).toBe(false)
  })

  it('a rule someone already changed is theirs, and a rule missing or already off is left alone', async () => {
    fake.rules = fake.rules
      .filter((r) => r.event_type !== 'digest.daily' && r.event_type !== 'event.resolved')
      .map((r) => {
        if (r.event_type === 'incident.assigned') return { ...r, target: 'role:admin' }
        if (r.event_type === 'event.suppressed') return { ...r, enabled: false }
        if (r.event_type === 'sla.breached') return { ...r, is_seed: false }
        return r
      })
    const previous = await tuneNotificationRules(session, ctx)
    const touched = fake.updates.map((u) => u.id)
    for (const untouched of ['r-incident.assigned', 'r-sla.breached', 'r-digest.daily', 'r-event.suppressed', 'r-event.resolved']) expect(touched).not.toContain(untouched)
    expect(fake.rules.find((r) => r.event_type === 'incident.assigned')!.target).toBe('role:admin')
    expect(touched).toContain('r-event.stable')
    expect(previous.map((p) => p.id)).toEqual(touched)
    expect(previous).toHaveLength(DEMO_NOTIFICATION_TARGETS.length - 3 + DEMO_NOTIFICATIONS_OFF.length - 2)
  })

  it('a rule narrowed and then routed to a channel is put back to what it was before the run, not to what the run made of it', async () => {
    const tuned = await tuneNotificationRules(session, ctx)
    const channels = await createDemoChannels(session, ctx, { DEMO_TEAMS_WEBHOOK_URL: 'https://example.webhook.office.com/webhookb2/test' })
    // incident.assigned was changed twice: narrowed (target), then routed to Teams (channels).
    expect(channels.previous.find((p) => p.id === 'r-incident.assigned')).toEqual({ id: 'r-incident.assigned', target: 'team_owner', enabled: true, channels: ['in_app'] })
    const back = firstStates([...tuned, ...channels.previous])
    expect(back.find((p) => p.id === 'r-incident.assigned')).toEqual({ id: 'r-incident.assigned', target: 'all', enabled: true, channels: ['in_app'] })
    expect(new Set(back.map((p) => p.id)).size).toBe(back.length)
    expect(back).toHaveLength(tuned.length)
  })
})
