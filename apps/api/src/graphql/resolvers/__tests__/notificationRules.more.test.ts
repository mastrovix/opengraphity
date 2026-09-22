/**
 * Notification rules: listing, step narrowing, duplicates and deletion
 * (resolvers/notificationRules.ts). The sibling notificationRules.test.ts pins
 * channels, targets and severities; this file covers the rest.
 *
 * Why these behaviours matter for an admin:
 *  - a rule whose event type nothing produces must be marked
 *    (`eventProduced: false`), or it looks identical to one that fires;
 *  - step purpose/category narrow ONLY `<entity>.step_entered` rules: on any
 *    other type the rule would look narrowed without being so;
 *  - two identical rules are ambiguous (the dispatcher would apply one at
 *    random), so a duplicate is refused naming the existing rule;
 *  - seeded rules cannot be deleted, and every change invalidates the
 *    dispatcher's rule cache, or the old rule keeps firing;
 *  - every read and write is scoped to the caller's tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }
const runQuery = vi.fn()
const invalidateRuleCache = vi.fn()
const audit = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
vi.mock('../../../lib/bullmq.js', () => ({ getQueue: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit }))
vi.mock('../../../lib/roles.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/roles.js')>()
  return { ...real, assertRolesExist: vi.fn(async () => undefined), tenantRoles: vi.fn(async () => new Map()) }
})
vi.mock('@opengraphity/notifications', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/notifications')>()
  return { ...orig, invalidateRuleCache }
})

const { notificationRuleResolvers, normalizeStepNarrowing } = await import('../notificationRules.js')
const { perms } = await import('../../../lib/__tests__/testPermissions.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const { Query, Mutation } = notificationRuleResolvers

type TxRun = (cypher: string, params: Record<string, unknown>) => Promise<unknown>
/** Makes the next executeRead/Write run its callback against `run`, so the params can be inspected. */
const answer = (fn: typeof mockSession.executeRead, result: unknown) => {
  const run = vi.fn<TxRun>().mockResolvedValue(result)
  fn.mockImplementationOnce(async (cb: (tx: { run: TxRun }) => Promise<unknown>) => cb({ run }))
  return run
}
const nodes = (...props: Array<Record<string, unknown>>) => ({ records: props.map((p) => ({ get: () => ({ properties: p }) })) })
const eventTypeRow = (eventType: string) => ({ records: [{ get: () => eventType }] })

async function codeOf(p: Promise<unknown>): Promise<{ code: unknown; message: string; ext: Record<string, unknown> }> {
  const e = await p.then(() => { throw new Error('expected a rejection') }, (x: unknown) => x)
  expect(e).toBeInstanceOf(GraphQLError)
  const g = e as GraphQLError
  return { code: g.extensions['code'], message: g.message, ext: g.extensions }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset (not just clear): a test that fails early must not leave queued answers for the next one.
  mockSession.executeRead.mockReset()
  mockSession.executeWrite.mockReset()
  runQuery.mockResolvedValue([])
})

describe('Query.notificationRules', () => {
  it('reads the caller tenant only and marks rules nothing produces', async () => {
    runQuery.mockResolvedValue([{ entityType: 'incident', stepName: 'triage', label: null, purpose: null, category: null, stepOrder: 1 }])
    const run = answer(mockSession.executeRead, nodes(
      { id: 'a', event_type: 'incident.created', enabled: true, title_key: 't', channels: ['in_app'], target: 'all' },
      { id: 'b', event_type: 'incident.triage', enabled: true, title_key: 't' },
      { id: 'c', event_type: 'incident.step_entered', enabled: true, title_key: 't' },
      { id: 'd', event_type: 'digest.daily', enabled: true, title_key: 't' },
      { id: 'e', event_type: 'incident.ghost_step', enabled: true, title_key: 't' },
    ))
    const rules = await Query.notificationRules(null, null, ctx)
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1' })
    // Seeded, workflow-derived (legacy and stable) and UI-only types are produced; a step that no workflow has is not.
    expect(rules.map((r) => [r.id, r.eventProduced])).toEqual([['a', true], ['b', true], ['c', true], ['d', true], ['e', false]])
  })

  it('maps missing properties to explicit defaults rather than undefined', async () => {
    answer(mockSession.executeRead, nodes({ id: 'x', event_type: 'incident.created', enabled: false, title_key: 't' }))
    const [r] = await Query.notificationRules(null, null, ctx)
    expect(r).toMatchObject({
      severityOverride: 'info', channels: ['in_app'], target: 'all', conditions: null, isSeed: false,
      stepPurpose: null, stepCategory: null, escalationDelayMinutes: null, slaWarningThresholdPercent: null,
      digestTime: null, digestRecipients: null,
    })
  })

  it('converts stored numbers and keeps digest recipients only when they are a list', async () => {
    answer(mockSession.executeRead, nodes(
      { id: 'x', event_type: 'digest.daily', escalation_delay_minutes: '15', sla_warning_threshold_percent: 80,
        digest_time: '08:30', digest_recipients: ['a@x'], is_seed: true, step_purpose: 'approval', step_category: 'waiting' },
      { id: 'y', event_type: 'digest.daily', digest_recipients: 'not-a-list' },
    ))
    const [x, y] = await Query.notificationRules(null, null, ctx)
    expect(x).toMatchObject({ escalationDelayMinutes: 15, slaWarningThresholdPercent: 80, digestTime: '08:30',
      digestRecipients: ['a@x'], isSeed: true, stepPurpose: 'approval', stepCategory: 'waiting' })
    expect(y!.digestRecipients).toBeNull()
  })
})

describe('Query.workflowEventTypes', () => {
  it('derives the tenant event types, optionally for one entity', async () => {
    runQuery.mockResolvedValue([{ entityType: 'change', stepName: 'review', label: 'Review', purpose: 'approval', category: null, stepOrder: 1 }])
    const rows = await Query.workflowEventTypes(null, { entityType: 'change' }, ctx)
    expect(rows.map((r) => r.eventType)).toEqual(['change.step_entered', 'change.review'])
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1', entityType: 'change' })
    await Query.workflowEventTypes(null, {}, ctx)
    expect(runQuery.mock.calls[1]![2]).toEqual({ tenantId: 'tenant-1', entityType: null })
  })
})

describe('normalizeStepNarrowing', () => {
  it('distinguishes "not sent" (undefined) from "remove the narrowing" (null)', () => {
    expect(normalizeStepNarrowing('incident.created', undefined, 'stepPurpose')).toBeUndefined()
    expect(normalizeStepNarrowing('incident.created', null, 'stepPurpose')).toBeUndefined()
    // Clearing is allowed on any type: it is how a wrong narrowing is removed.
    expect(normalizeStepNarrowing('incident.created', '   ', 'stepCategory')).toBeNull()
  })

  it('refuses a narrowing on a type that is not <entity>.step_entered', () => {
    expect(() => normalizeStepNarrowing('incident.created', 'approval', 'stepPurpose')).toThrow(/only applies to step-entered event types/)
    // The generic workflow.step.entered is not a per-entity stable type either.
    expect(() => normalizeStepNarrowing('workflow.step.entered', 'waiting', 'stepCategory')).toThrow(GraphQLError)
  })

  it('refuses a purpose outside the closed vocabulary, naming the allowed values', () => {
    expect(() => normalizeStepNarrowing('change.step_entered', 'lunch', 'stepPurpose')).toThrow(/stepPurpose "lunch" out of vocabulary\. Allowed: .*approval/)
  })

  it('accepts a known purpose and any category, trimmed', () => {
    expect(normalizeStepNarrowing('change.step_entered', ' approval ', 'stepPurpose')).toBe('approval')
    // Categories are the tenant's own words: there is no closed list to check against.
    expect(normalizeStepNarrowing('change.step_entered', ' waiting ', 'stepCategory')).toBe('waiting')
  })
})

describe('createNotificationRule', () => {
  const input = { eventType: 'change.step_entered', titleKey: 'k', channels: ['in_app'], target: 'all' }

  it('creates in the caller tenant with defaults and the step narrowing, then audits', async () => {
    const dup = answer(mockSession.executeRead, { records: [] })
    const write = answer(mockSession.executeWrite, nodes({ id: 'new', event_type: 'change.step_entered', enabled: true, title_key: 'k', step_purpose: 'approval' }))
    const out = await Mutation.createNotificationRule(null, { input: { ...input, stepPurpose: 'approval' } }, ctx)
    expect(dup.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', eventType: 'change.step_entered', stepPurpose: 'approval', stepCategory: null })
    const params = write.mock.calls[0]![1]
    expect(params).toMatchObject({ tenantId: 'tenant-1', enabled: true, severityOverride: 'info', stepPurpose: 'approval', stepCategory: null, digestTime: null })
    expect(out.stepPurpose).toBe('approval')
    expect(audit).toHaveBeenCalledWith(ctx, 'notification_rule.created', 'NotificationRule', params['id'])
  })

  it.each([
    [{ stepPurpose: 'approval' }, /\(scopo "approval"\) already exists/],
    [{ stepCategory: 'waiting' }, /\(categoria "waiting"\) already exists/],
    [{}, /A rule for "change.step_entered" already exists/],
  ])('a duplicate with the same narrowing %o is refused with the existing id', async (narrowing, pattern) => {
    answer(mockSession.executeRead, { records: [{ get: () => 'existing-1' }] })
    const { code, message, ext } = await codeOf(Mutation.createNotificationRule(null, { input: { ...input, ...narrowing } }, ctx))
    expect(code).toBe('BAD_USER_INPUT')
    expect(message).toMatch(pattern)
    expect(ext['existingRuleId']).toBe('existing-1')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('refuses a narrowing on a non step-entered type before touching the database', async () => {
    const { code } = await codeOf(Mutation.createNotificationRule(null, { input: { ...input, eventType: 'incident.created', stepCategory: 'waiting' } }, ctx))
    expect(code).toBe('BAD_USER_INPUT')
    expect(mockSession.executeRead).not.toHaveBeenCalled()
  })

  it.each([[0], [-5], [1.5]])('an escalation delay of %s minutes is refused', async (escalationDelayMinutes) => {
    const { code, ext } = await codeOf(Mutation.createNotificationRule(null, { input: { ...input, escalationDelayMinutes } }, ctx))
    expect(code).toBe('BAD_USER_INPUT')
    expect((ext['i18n'] as { key: string }).key).toBe('errors.notificationRule.escalationDelay')
  })

  it('stores the special fields that remain valid', async () => {
    answer(mockSession.executeRead, { records: [] })
    const write = answer(mockSession.executeWrite, nodes({ id: 'n', event_type: 'digest.daily', digest_time: '23:59', escalation_delay_minutes: 30 }))
    const out = await Mutation.createNotificationRule(null, {
      input: { eventType: 'digest.daily', titleKey: 'k', channels: ['email'], target: 'all', enabled: false, severityOverride: 'warning',
        digestTime: '23:59', digestRecipients: ['ops@x'], escalationDelayMinutes: 30, escalationMessage: 'm' },
    }, ctx)
    expect(write.mock.calls[0]![1]).toMatchObject({ enabled: false, severityOverride: 'warning', digestTime: '23:59', digestRecipients: ['ops@x'], escalationDelayMinutes: 30, escalationMessage: 'm' })
    expect(out.digestTime).toBe('23:59')
  })
})

describe('updateNotificationRule', () => {
  it('sets the narrowing on a step-entered rule and invalidates the dispatcher cache', async () => {
    answer(mockSession.executeRead, eventTypeRow('change.step_entered'))
    const write = answer(mockSession.executeWrite, nodes({ id: 'r1', event_type: 'change.step_entered', step_purpose: 'approval' }))
    const out = await Mutation.updateNotificationRule(null, { id: 'r1', input: { stepPurpose: 'approval' } }, ctx)
    expect(write.mock.calls[0]![1]).toMatchObject({ id: 'r1', tenantId: 'tenant-1', stepPurposeGiven: true, stepPurpose: 'approval', stepCategoryGiven: false })
    expect(out.stepPurpose).toBe('approval')
    // Without this the dispatcher keeps applying the old version of the rule.
    expect(invalidateRuleCache).toHaveBeenCalledWith('tenant-1', 'change.step_entered')
    expect(audit).toHaveBeenCalledWith(ctx, 'notification_rule.updated', 'NotificationRule', 'r1')
  })

  it('an empty category removes the narrowing (given=true, value null), unlike omitting it', async () => {
    answer(mockSession.executeRead, eventTypeRow('change.step_entered'))
    const write = answer(mockSession.executeWrite, nodes({ id: 'r1', event_type: 'change.step_entered' }))
    await Mutation.updateNotificationRule(null, { id: 'r1', input: { stepCategory: '' } }, ctx)
    expect(write.mock.calls[0]![1]).toMatchObject({ stepCategoryGiven: true, stepCategory: null, stepPurposeGiven: false })
  })

  it('refuses a narrowing on a rule whose stored type is not step-entered', async () => {
    answer(mockSession.executeRead, eventTypeRow('incident.created'))
    const { code } = await codeOf(Mutation.updateNotificationRule(null, { id: 'r1', input: { stepPurpose: 'approval' } }, ctx))
    expect(code).toBe('BAD_USER_INPUT')
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('a rule that vanished between checks (or belongs to another tenant) is NOT_FOUND at write', async () => {
    answer(mockSession.executeWrite, { records: [] })
    const { code } = await codeOf(Mutation.updateNotificationRule(null, { id: 'other-tenant-rule', input: { enabled: true } }, ctx))
    expect(code).toBe('NOT_FOUND')
    expect(invalidateRuleCache).not.toHaveBeenCalled()
  })

  it('passes the still-valid special fields and null for the ones not sent', async () => {
    const write = answer(mockSession.executeWrite, nodes({ id: 'r1', event_type: 'digest.daily' }))
    await Mutation.updateNotificationRule(null, { id: 'r1', input: { digestTime: '07:05', escalationDelayMinutes: 10, escalationMessage: 'hurry', digestRecipients: ['a@x'] } }, ctx)
    expect(write.mock.calls[0]![1]).toMatchObject({
      digestTime: '07:05', escalationDelayMinutes: 10, escalationMessage: 'hurry', digestRecipients: ['a@x'],
      enabled: null, severityOverride: null, channels: null, target: null,
    })
  })
})

describe('deleteNotificationRule', () => {
  it('deletes a tenant rule, invalidates the cache for its type and audits', async () => {
    const run = answer(mockSession.executeWrite, eventTypeRow('incident.created'))
    await expect(Mutation.deleteNotificationRule(null, { id: 'r9' }, ctx)).resolves.toBe(true)
    expect(run.mock.calls[0]![1]).toEqual({ id: 'r9', tenantId: 'tenant-1' })
    // The Cypher only matches non-seed rules: a seeded rule must never be deletable.
    expect(run.mock.calls[0]![0]).toMatch(/r\.is_seed = false OR r\.is_seed IS NULL/)
    expect(invalidateRuleCache).toHaveBeenCalledWith('tenant-1', 'incident.created')
    expect(audit).toHaveBeenCalledWith(ctx, 'notification_rule.deleted', 'NotificationRule', 'r9')
  })

  it('a seed rule, a missing rule or another tenant\'s rule is NOT_FOUND and nothing is invalidated', async () => {
    answer(mockSession.executeWrite, { records: [] })
    const { code, ext } = await codeOf(Mutation.deleteNotificationRule(null, { id: 'seed' }, ctx))
    expect(code).toBe('NOT_FOUND')
    expect((ext['i18n'] as { key: string }).key).toBe('errors.notificationRule.notDeletable')
    expect(invalidateRuleCache).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})
