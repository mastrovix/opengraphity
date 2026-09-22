/**
 * notificationChannel.ts — the parts the SSRF suite does not cover: listing,
 * deleting and testing a channel, and linking a Slack account to a user that
 * no longer exists.
 *
 * Why it matters: every one of these reads or writes `NotificationChannel`
 * nodes by id, and ids are guessable across tenants. The list, the delete and
 * the test message must match on `tenant_id` too, or one customer could list,
 * remove or fire another customer's webhooks. A test message for a channel
 * that is not ours must be NotFound and must not be sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn() }
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))
// The SSRF rules have their own suite (notificationChannel.test.ts): here only whether they are consulted.
const assertSafeOutboundUrl = vi.fn(async (_url: string) => undefined)
vi.mock('../../../lib/safeUrl.js', () => ({ assertSafeOutboundUrl }))
const sendTestMessage = vi.fn(async () => true)
vi.mock('@opengraphity/notifications', () => ({ sendTestMessage }))

const { notificationChannelResolvers } = await import('../notificationChannel.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const nodeRecord = (props: Record<string, unknown>) => ({ get: () => ({ properties: props }) })
const runWith = (records: unknown[]) => vi.fn().mockResolvedValue({ records })
const onRead = (run: ReturnType<typeof vi.fn>) => mockSession.executeRead.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ run }))
const onWrite = (run: ReturnType<typeof vi.fn>) => mockSession.executeWrite.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({ run }))

beforeEach(() => { vi.clearAllMocks() })

describe('Query.notificationChannels', () => {
  it('lists only the caller tenant channels, newest first, with parsed event types', async () => {
    const run = runWith([
      nodeRecord({ id: 'ch-1', platform: 'slack', name: 'Ops', webhook_url: 'https://h/1', channel_id: 'C1', event_types: '["incident.created","change.approved"]', active: true, created_at: '2026-09-01' }),
      nodeRecord({ id: 'ch-2', platform: 'email', name: 'Mail', active: false, created_at: '2026-08-01' }),
    ])
    onRead(run)
    const out = await notificationChannelResolvers.Query.notificationChannels(null, null, ctx)
    expect(run.mock.calls[0]![0]).toContain('MATCH (n:NotificationChannel {tenant_id: $tenantId})')
    expect(run.mock.calls[0]![0]).toContain('ORDER BY n.created_at DESC')
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1' })
    expect(out).toEqual([
      { id: 'ch-1', platform: 'slack', name: 'Ops', webhookUrl: 'https://h/1', channelId: 'C1', eventTypes: ['incident.created', 'change.approved'], active: true, createdAt: '2026-09-01' },
      // A channel stored without the optional properties reads as nulls and no event types.
      { id: 'ch-2', platform: 'email', name: 'Mail', webhookUrl: null, channelId: null, eventTypes: [], active: false, createdAt: '2026-08-01' },
    ])
  })
})

describe('Mutation.updateNotificationChannel', () => {
  it('an unsupported platform is refused before any write', async () => {
    await expect(notificationChannelResolvers.Mutation.updateNotificationChannel(null, { id: 'ch-1', input: { platform: 'fax', name: 'x', eventTypes: [] } }, ctx))
      .rejects.toThrow(/platform "fax" is not supported/)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('without a webhook URL no SSRF check is needed and nulls are written', async () => {
    const run = runWith([nodeRecord({ id: 'ch-1', platform: 'email', name: 'Mail', event_types: '[]', active: true })])
    onWrite(run)
    await notificationChannelResolvers.Mutation.updateNotificationChannel(null, { id: 'ch-1', input: { platform: 'email', name: 'Mail', channelId: 'C9', eventTypes: ['a'] } }, ctx)
    expect(assertSafeOutboundUrl).not.toHaveBeenCalled()
    expect(run.mock.calls[0]![1]).toMatchObject({ id: 'ch-1', tenantId: 'tenant-1', webhookUrl: null, channelId: 'C9', eventTypes: '["a"]' })
  })
})

describe('Mutation.deleteNotificationChannel', () => {
  it('deletes by id AND tenant, so another tenant channel is untouched', async () => {
    const run = runWith([])
    onWrite(run)
    expect(await notificationChannelResolvers.Mutation.deleteNotificationChannel(null, { id: 'ch-1' }, ctx)).toBe(true)
    expect(run.mock.calls[0]![0]).toBe('MATCH (n:NotificationChannel {id: $id, tenant_id: $tenantId}) DETACH DELETE n')
    expect(run.mock.calls[0]![1]).toEqual({ id: 'ch-1', tenantId: 'tenant-1' })
  })
})

describe('Mutation.testNotificationChannel', () => {
  it('a channel of another tenant is NotFound and nothing is sent', async () => {
    onRead(runWith([]))
    await expect(notificationChannelResolvers.Mutation.testNotificationChannel(null, { id: 'ch-x' }, ctx)).rejects.toThrow('NotificationChannel not found')
    expect(sendTestMessage).not.toHaveBeenCalled()
  })

  it('re-checks the stored URL, then sends the test message for the caller tenant', async () => {
    const run = runWith([nodeRecord({ id: 'ch-1', platform: 'slack', name: 'Ops', webhook_url: 'https://hooks.example/1', event_types: '[]', active: true })])
    onRead(run)
    expect(await notificationChannelResolvers.Mutation.testNotificationChannel(null, { id: 'ch-1' }, ctx)).toBe(true)
    expect(run.mock.calls[0]![1]).toEqual({ id: 'ch-1', tenantId: 'tenant-1' })
    expect(assertSafeOutboundUrl).toHaveBeenCalledWith('https://hooks.example/1')
    expect(sendTestMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'ch-1', webhookUrl: 'https://hooks.example/1' }), 'tenant-1')
  })

  it('a channel without a webhook (email) is sent without an URL check', async () => {
    onRead(runWith([nodeRecord({ id: 'ch-2', platform: 'email', name: 'Mail', event_types: '[]', active: true })]))
    await notificationChannelResolvers.Mutation.testNotificationChannel(null, { id: 'ch-2' }, ctx)
    expect(assertSafeOutboundUrl).not.toHaveBeenCalled()
    expect(sendTestMessage).toHaveBeenCalledOnce()
  })
})

describe('Mutation.linkSlackAccount', () => {
  it('a caller whose user node is gone gets NotFound, not a fake success', async () => {
    onWrite(runWith([]))
    await expect(notificationChannelResolvers.Mutation.linkSlackAccount(null, { slackId: null }, ctx)).rejects.toThrow('User not found')
  })

  it('an omitted slackId unlinks, and a user without team reads teamId null', async () => {
    onWrite(runWith([nodeRecord({ id: 'admin-1', tenant_id: 'tenant-1', email: 'adm@test.io', name: 'Admin', role: 'admin' })]))
    const out = await notificationChannelResolvers.Mutation.linkSlackAccount(null, {}, ctx)
    expect(out).toEqual({ id: 'admin-1', tenantId: 'tenant-1', email: 'adm@test.io', name: 'Admin', role: 'admin', teamId: null, slackId: null })
  })
})
