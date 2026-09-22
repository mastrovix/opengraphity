/**
 * slackResolvers — the organisation's Slack connection on the Integrations page.
 *
 * Why it matters:
 * - `startSlackInstall` takes a return URL from the browser. If it accepted any
 *   URL, the Slack OAuth round-trip would become an open redirect to another
 *   tenant or an attacker's site. Only http(s) pages of THIS tenant are allowed.
 * - The settings read and the disconnect must use the caller's tenant, never
 *   an argument: otherwise one customer could read or remove another's Slack.
 * - Connecting and disconnecting are audited; a disconnect with nothing to
 *   remove is not an event and must not produce a phantom audit entry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

// The tenant check imports the auth module, which would open a Neo4j driver: never a real database here.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: Number }))
const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit }))
vi.mock('@opengraphity/notifications', () => ({
  loadSlackInstallation: vi.fn(),
  secretsKeyConfigured:  vi.fn(() => true),
}))
vi.mock('../../../lib/slackConnect.js', () => ({
  connectSlackWithToken: vi.fn(),
  disconnectSlack:       vi.fn(),
  slackAppAvailable:     vi.fn(() => false),
  slackAuthorizeUrl:     vi.fn((_ctx: unknown, returnTo: string) => `https://slack.com/oauth/v2/authorize?state=x&r=${encodeURIComponent(returnTo)}`),
  slackRequestUrls:      vi.fn(() => ({ commands: 'c', actions: 'a', oauthCallback: 'o' })),
}))

const notifications = await import('@opengraphity/notifications')
const connect = await import('../../../lib/slackConnect.js')
const { slackResolvers } = await import('../slack.js')

const ctx: GraphQLContext = { tenantId: 'c-one', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }

beforeEach(() => { vi.clearAllMocks() })

describe('Query.slackSettings', () => {
  it('reads the installation of the caller tenant and reports availability flags', async () => {
    vi.mocked(notifications.loadSlackInstallation).mockResolvedValue({ teamId: 'T1', teamName: 'Acme' } as never)
    const out = await slackResolvers.Query.slackSettings(null, null, ctx)
    expect(notifications.loadSlackInstallation).toHaveBeenCalledWith('c-one')
    expect(out).toEqual({
      installation: { teamId: 'T1', teamName: 'Acme' },
      appInstallAvailable: false,
      secretsConfigured: true,
      requestUrls: { commands: 'c', actions: 'a', oauthCallback: 'o' },
    })
  })
})

describe('Mutation.startSlackInstall — the return page must belong to this tenant', () => {
  const expectRejected = (returnTo: string) => {
    let err: unknown
    try { slackResolvers.Mutation.startSlackInstall(null, { returnTo }, ctx) } catch (e) { err = e }
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toBe('The return page must belong to this organization')
    expect(connect.slackAuthorizeUrl).not.toHaveBeenCalled()
  }

  it.each([
    ['another tenant',            'https://c-two.example.com/settings/integrations'],
    ['a foreign site',            'https://evil.com/x'],
    ['a javascript: URL',         'javascript:alert(1)'],
    ['a non-http scheme on host', 'ftp://c-one.example.com/x'],
    ['garbage',                   'not a url'],
    ['localhost (no tenant)',     'http://localhost:5173/'],
  ])('%s is refused', (_label, url) => expectRejected(url))

  it('a page of this tenant starts the OAuth flow with the normalised URL', () => {
    const out = slackResolvers.Mutation.startSlackInstall(null, { returnTo: 'https://c-one.example.com/settings/integrations?tab=slack' }, ctx)
    expect(out).toContain('https://slack.com/oauth/v2/authorize')
    expect(connect.slackAuthorizeUrl).toHaveBeenCalledWith(ctx, 'https://c-one.example.com/settings/integrations?tab=slack')
  })

  it('the tenant portal host is also a page of this tenant', () => {
    slackResolvers.Mutation.startSlackInstall(null, { returnTo: 'http://portal.c-one.localhost/x' }, ctx)
    expect(connect.slackAuthorizeUrl).toHaveBeenCalledWith(ctx, 'http://portal.c-one.localhost/x')
  })
})

describe('Mutation.connectSlackWithToken', () => {
  it('connects and audits the team, never the secrets', async () => {
    vi.mocked(connect.connectSlackWithToken).mockResolvedValue({ teamId: 'T1', teamName: 'Acme', mode: 'token' } as never)
    const out = await slackResolvers.Mutation.connectSlackWithToken(null, { botToken: 'xoxb-secret', signingSecret: 'sig-secret' }, ctx)
    expect(out).toMatchObject({ teamId: 'T1' })
    expect(connect.connectSlackWithToken).toHaveBeenCalledWith(ctx, 'xoxb-secret', 'sig-secret')
    expect(audit).toHaveBeenCalledWith(ctx, 'slack.connected', 'SlackInstallation', 'T1', { mode: 'token', team: 'Acme' })
    // The audit payload is readable by every auditor: tokens must not leak into it.
    expect(JSON.stringify(audit.mock.calls[0])).not.toMatch(/secret/)
  })
})

describe('Mutation.disconnectSlack', () => {
  it('removes the caller tenant installation and audits it', async () => {
    vi.mocked(connect.disconnectSlack).mockResolvedValue({ teamId: 'T1', teamName: 'Acme', mode: 'oauth' } as never)
    expect(await slackResolvers.Mutation.disconnectSlack(null, null, ctx)).toBe(true)
    expect(connect.disconnectSlack).toHaveBeenCalledWith('c-one')
    expect(audit).toHaveBeenCalledWith(ctx, 'slack.disconnected', 'SlackInstallation', 'T1', { mode: 'oauth', team: 'Acme' })
  })

  it('with nothing connected returns false and writes no audit entry', async () => {
    vi.mocked(connect.disconnectSlack).mockResolvedValue(null)
    expect(await slackResolvers.Mutation.disconnectSlack(null, null, ctx)).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })
})
