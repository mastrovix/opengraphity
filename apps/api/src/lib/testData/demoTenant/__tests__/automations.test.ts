/**
 * THE ORGANIZATION'S AUTOMATIONS AND WHAT THEY LEFT BEHIND (tour of 23 Sep
 * 2026, D68).
 *
 * Three years of operation and not one Auto Trigger or Business Rule: the
 * demo now has the two a company in the EU writes early. organization.test.ts
 * checks that the product accepts them; this file pins how they live:
 *
 *  - they are created with the app's own mutations, the trigger with
 *    `createAutoTrigger` and the rule with `createBusinessRule`;
 *  - they are written on a day of the tenant's life: `writtenDaysAgo` back,
 *    never in the tenant's first month;
 *  - they have FIRED since, on the tickets this run wrote after that day, and
 *    each firing left what the engine leaves (automationEngine.ts): an Audit
 *    Log entry by `automation`, e-mail `system`, a few seconds after the
 *    ticket, naming the automation and the ticket; the last one is the
 *    trigger's «last run».
 *
 * Neo4j and the automation resolvers are fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'
import type { GraphQLContext } from '../../../../auth/resolveAuth.js'
import { Rng } from '../random.js'
import { DAY, DemoClock } from '../clock.js'

const fake = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; at: string }>,
  reads: [] as Array<{ text: string; params: Record<string, unknown> }>,
  created: [] as Array<{ mutation: string; args: unknown; ctx: unknown }>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: async (_session: unknown, text: string, params: Record<string, unknown>) => { fake.reads.push({ text, params }); return fake.rows },
}))
vi.mock('../../../../graphql/resolvers/automation.js', () => ({
  automationResolvers: {
    Mutation: {
      createAutoTrigger: async (_p: unknown, args: unknown, ctx: unknown) => { fake.created.push({ mutation: 'createAutoTrigger', args, ctx }); return { id: 'trigger-1' } },
      createBusinessRule: async (_p: unknown, args: unknown, ctx: unknown) => { fake.created.push({ mutation: 'createBusinessRule', args, ctx }); return { id: 'rule-1' } },
    },
  },
}))

const { automationFirings, createAutomation, demoAutomations, writtenAt } = await import('../automations.js')

const session = {} as Session
const ctx = { tenantId: 'demo', userId: 'admin-1', role: 'admin' } as unknown as GraphQLContext
const NOW = Date.parse('2026-09-23T10:00:00.000Z')
const [RULE, TRIGGER] = demoAutomations('item-privileged')

beforeEach(() => {
  fake.rows = []
  fake.reads = []
  fake.created = []
})

describe('D68: created with the app\'s own mutations', () => {
  it('the rule with createBusinessRule, the trigger with createAutoTrigger, as the page sends them, by the administrator', async () => {
    expect(RULE!.kind).toBe('rule')
    expect(TRIGGER!.kind).toBe('trigger')
    expect(await createAutomation(ctx, RULE!)).toBe('rule-1')
    expect(await createAutomation(ctx, TRIGGER!)).toBe('trigger-1')
    expect(fake.created).toEqual([
      { mutation: 'createBusinessRule', args: { input: RULE!.input }, ctx },
      { mutation: 'createAutoTrigger', args: { input: TRIGGER!.input }, ctx },
    ])
  })
})

describe('D68: the day each automation was written', () => {
  it('is `writtenDaysAgo` back, in the tenant\'s life', () => {
    const clock = new DemoClock(NOW, 3, 'Europe/Rome')
    for (const a of [RULE!, TRIGGER!]) {
      const day = NOW - a.writtenDaysAgo * DAY
      for (let i = 0; i < 20; i++) {
        const ms = writtenAt(new Rng(`written/${String(i)}`), clock, a)
        expect(ms).toBeGreaterThanOrEqual(day)
        expect(ms).toBeLessThan(day + DAY)
      }
    }
  })

  it('is never in the tenant\'s first month: a younger tenant had it written thirty days after it started', () => {
    const young = new DemoClock(NOW, 1, 'Europe/Rome')
    expect(NOW - RULE!.writtenDaysAgo * DAY).toBeLessThan(young.startMs)
    const ms = writtenAt(new Rng('young'), young, RULE!)
    expect(ms).toBeGreaterThanOrEqual(young.startMs + 30 * DAY)
    expect(ms).toBeLessThan(young.startMs + 31 * DAY)
  })

  it('is the same moment for the same seed', () => {
    const clock = new DemoClock(NOW, 3, 'Europe/Rome')
    expect(writtenAt(new Rng('same'), clock, TRIGGER!)).toBe(writtenAt(new Rng('same'), clock, TRIGGER!))
  })
})

describe('D68: the firings since the day it was written', () => {
  const WRITTEN = Date.parse('2025-07-30T09:15:00.000Z')

  it('are the tickets of this run opened since that day: the security incidents for the rule, the requests of the item for the trigger', async () => {
    await automationFirings(session, new Rng('f'), 'demo', 'run-1', RULE!, 'rule-1', WRITTEN)
    await automationFirings(session, new Rng('f'), 'demo', 'run-1', TRIGGER!, 'trigger-1', WRITTEN)
    const [rule, trigger] = fake.reads
    expect(rule!.text).toBe(RULE!.firings)
    expect(rule!.text).toContain('i.category = \'security\' AND i.created_at >= $since')
    expect(rule!.params).toEqual({ tenantId: 'demo', runId: 'run-1', since: '2025-07-30T09:15:00.000Z' })
    expect(trigger!.text).toContain('r.catalog_item_id = $itemId AND r.created_at >= $since')
    expect(trigger!.params).toEqual({ itemId: 'item-privileged', tenantId: 'demo', runId: 'run-1', since: '2025-07-30T09:15:00.000Z' })
  })

  it('each firing of the rule leaves the engine\'s Audit Log entry: by the automation, seconds after the ticket, naming the rule and the ticket', async () => {
    fake.rows = [{ id: 'inc-1', at: '2025-08-01T08:00:00.000Z' }, { id: 'inc-2', at: '2025-09-12T14:30:00.000Z' }]
    const { audits, last } = await automationFirings(session, new Rng('f'), 'demo', 'run-1', RULE!, 'rule-1', WRITTEN)
    expect(audits).toHaveLength(2)
    audits.forEach((a, i) => {
      expect(a).toMatchObject({ user_id: 'automation', user_email: 'system', action: 'business_rule.executed', entity_type: 'BusinessRule', entity_id: 'rule-1', ip_address: null })
      expect(JSON.parse(a.details!)).toEqual({ ruleName: 'Security incident: personal data check', entityId: fake.rows[i]!.id, actionsRun: 1, actionsAttempted: 1 })
      const after = Date.parse(a.created_at) - Date.parse(fake.rows[i]!.at)
      expect(after).toBeGreaterThanOrEqual(1000)
      expect(after).toBeLessThanOrEqual(4000)
    })
    expect(new Set(audits.map((a) => a.id)).size).toBe(2)
    expect(last).toBe(audits[1]!.created_at)
  })

  it('a trigger\'s firing is a trigger.executed on the AutoTrigger, and its last run is the latest firing', async () => {
    fake.rows = [{ id: 'sr-7', at: '2026-02-03T11:00:00.000Z' }, { id: 'sr-9', at: '2026-05-20T16:45:00.000Z' }, { id: 'sr-12', at: '2026-09-01T07:10:00.000Z' }]
    const { audits, last } = await automationFirings(session, new Rng('t'), 'demo', 'run-1', TRIGGER!, 'trigger-1', WRITTEN)
    expect(audits.map((a) => [a.action, a.entity_type, a.entity_id])).toEqual(Array.from({ length: 3 }, () => ['trigger.executed', 'AutoTrigger', 'trigger-1']))
    expect(audits.map((a) => JSON.parse(a.details!) as Record<string, unknown>)).toEqual(fake.rows.map((r) => ({
      triggerName: 'Privileged access requested: tell the administrators', entityId: r.id, actionsRun: 1, actionsAttempted: 1,
    })))
    expect(last).toBe(audits[2]!.created_at)
    expect(Date.parse(last!)).toBeGreaterThan(Date.parse('2026-09-01T07:10:00.000Z'))
  })

  it('an automation that never fired has no entry and no last run', async () => {
    expect(await automationFirings(session, new Rng('none'), 'demo', 'run-1', TRIGGER!, 'trigger-1', WRITTEN)).toEqual({ audits: [], last: null })
  })
})
