/**
 * notificationChannel.ts — guardia SSRF sul webhook del canale: URL non sicuri
 * (loopback, privati, link-local/metadata, file://, localhost, host che risolve
 * a IP privato) → ValidationError PRIMA di scrivere; https pubblico → CREATE con
 * tenant_id del contesto. Le regole SSRF sono quelle REALI di
 * @opengraphity/events: solo il DNS è sostituito da una lookup deterministica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

const mockSession = { executeRead: vi.fn(), executeWrite: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))

// DNS deterministico: le regole restano quelle del package.
const FAKE_DNS: Record<string, string> = {
  'hooks.slack.com':  '3.3.3.3',
  'rebind.corp':      '10.0.0.5',
}
vi.mock('@opengraphity/events', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@opengraphity/events')>()
  const lookup = async (host: string) => {
    const ip = FAKE_DNS[host]
    if (!ip) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
    return [{ address: ip, family: 4 }]
  }
  return {
    ...orig,
    assertSafeOutboundUrl: (url: string, opts?: import('@opengraphity/events').SafeUrlOptions) =>
      orig.assertSafeOutboundUrl(url, { ...opts, lookup }),
  }
})

const { notificationChannelResolvers } = await import('../notificationChannel.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin' }
const input = (webhookUrl: string, platform = 'slack') => ({ platform, name: 'Ops', webhookUrl, eventTypes: ['incident.created'] })

const nodeRecord = (props: Record<string, unknown>) => ({ get: () => ({ properties: props }) })

async function expectValidation(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
  expect((err as GraphQLError).message).toMatch(pattern)
}

const UNSAFE: Array<[string, RegExp]> = [
  ['https://127.0.0.1/hook',          /private\/loopback\/link-local/],
  ['https://10.0.0.1/hook',           /private\/loopback\/link-local/],
  ['https://169.254.169.254/latest',  /private\/loopback\/link-local/],
  ['https://192.168.1.10/hook',       /private\/loopback\/link-local/],
  ['https://localhost/hook',          /"localhost" is not allowed/],
  ['https://api.localhost/hook',      /is not allowed \(loopback\)/],
  ['https://[::1]/hook',              /private\/loopback\/link-local/],
  ['https://[::ffff:127.0.0.1]/hook', /private\/loopback\/link-local/],
  ['file:///etc/passwd',              /scheme "file:" is not allowed/],
  ['ftp://hooks.slack.com/x',         /scheme "ftp:" is not allowed/],
  ['http://hooks.slack.com/x',        /must use https/],           // NODE_ENV=test → https obbligatorio
  ['https://user:pw@hooks.slack.com', /must not embed credentials/],
  ['https://rebind.corp/hook',        /resolves to 10\.0\.0\.5/],  // DNS → privato
  ['https://nope.invalid/hook',       /does not resolve/],
  ['non-un-url',                      /not a valid absolute URL/],
]

describe('createNotificationChannel — URL webhook non sicuro → ValidationError PRIMA di scrivere', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(UNSAFE)('%s', async (url, pattern) => {
    await expectValidation(notificationChannelResolvers.Mutation.createNotificationChannel(null, { input: input(url) }, ctx), pattern)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('https pubblico → CREATE con tenant_id del contesto, event_types serializzati, active=true', async () => {
    const run = vi.fn().mockResolvedValue({ records: [nodeRecord({
      id: 'ch-1', tenant_id: 'tenant-1', platform: 'slack', name: 'Ops', webhook_url: 'https://hooks.slack.com/services/T/B/x',
      channel_id: null, event_types: '["incident.created"]', active: true, created_at: 'now',
    })] })
    mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))

    const out = await notificationChannelResolvers.Mutation.createNotificationChannel(null, { input: input('https://hooks.slack.com/services/T/B/x') }, ctx)

    expect(run).toHaveBeenCalledOnce()
    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain('CREATE (n:NotificationChannel {')
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toMatchObject({ tenantId: 'tenant-1', platform: 'slack', name: 'Ops', webhookUrl: 'https://hooks.slack.com/services/T/B/x', eventTypes: '["incident.created"]' })
    expect(out).toMatchObject({ id: 'ch-1', platform: 'slack', eventTypes: ['incident.created'], active: true })
  })

  it('senza webhookUrl (es. canale email/in-app) → nessuna guardia, scrittura', async () => {
    const run = vi.fn().mockResolvedValue({ records: [nodeRecord({ id: 'ch-2', platform: 'email', name: 'Mail', event_types: '[]', active: true })] })
    mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))
    await notificationChannelResolvers.Mutation.createNotificationChannel(null, { input: { platform: 'email', name: 'Mail', eventTypes: [] } }, ctx)
    expect(run.mock.calls[0]![1]).toMatchObject({ webhookUrl: null, tenantId: 'tenant-1' })
  })

  it('tipo canale sconosciuto → ValidationError senza scrivere — BUG: `platform` è String! nello schema e il resolver non lo valida, "pigeon" viene salvato (notificationChannel.ts:32-58, schema-notification.ts:39)', async () => {
    const run = vi.fn().mockResolvedValue({ records: [nodeRecord({ id: 'ch-3', platform: 'pigeon', name: 'X', event_types: '[]', active: true })] })
    mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))
    await expectValidation(
      notificationChannelResolvers.Mutation.createNotificationChannel(null, { input: input('https://hooks.slack.com/x', 'pigeon') }, ctx),
      /platform/,
    )
    expect(run).not.toHaveBeenCalled()
  })
})

describe('updateNotificationChannel', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(UNSAFE.slice(0, 6))('URL non sicuro %s → ValidationError, nessun SET', async (url, pattern) => {
    await expectValidation(notificationChannelResolvers.Mutation.updateNotificationChannel(null, { id: 'ch-1', input: input(url) }, ctx), pattern)
    expect(mockSession.executeWrite).not.toHaveBeenCalled()
  })

  it('https pubblico → MATCH scoped per tenant + SET', async () => {
    const run = vi.fn().mockResolvedValue({ records: [nodeRecord({ id: 'ch-1', platform: 'teams', name: 'Ops', webhook_url: 'https://hooks.slack.com/y', event_types: '[]', active: true })] })
    mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))

    await notificationChannelResolvers.Mutation.updateNotificationChannel(null, { id: 'ch-1', input: input('https://hooks.slack.com/y', 'teams') }, ctx)

    const [cypher, params] = run.mock.calls[0]!
    expect(cypher).toContain('MATCH (n:NotificationChannel {id: $id, tenant_id: $tenantId})')
    expect(params).toMatchObject({ id: 'ch-1', tenantId: 'tenant-1', webhookUrl: 'https://hooks.slack.com/y' })
  })

  it('canale di un altro tenant → errore "non trovato"', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] })
    mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))
    await expect(notificationChannelResolvers.Mutation.updateNotificationChannel(null, { id: 'ch-altrui', input: input('https://hooks.slack.com/y') }, ctx))
      .rejects.toThrow('NotificationChannel non trovato')
  })
})

describe('testNotificationChannel — ri-verifica l\'URL salvato prima di inviare', () => {
  beforeEach(() => vi.clearAllMocks())

  it('canale con URL (ora) privato → ValidationError, nessun invio', async () => {
    const run = vi.fn().mockResolvedValue({ records: [nodeRecord({ id: 'ch-1', platform: 'slack', name: 'Ops', webhook_url: 'https://169.254.169.254/x', event_types: '[]', active: true })] })
    mockSession.executeRead.mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => fn({ run }))
    await expectValidation(notificationChannelResolvers.Mutation.testNotificationChannel(null, { id: 'ch-1' }, ctx), /private\/loopback\/link-local/)
  })
})
