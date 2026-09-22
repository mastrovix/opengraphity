/**
 * `me` and the two self-service preferences, on the paths the profile suite
 * does not reach:
 *  - an identity from the token with no `User` node still gets a profile (the
 *    token identity, no preferences) instead of an error that would blank the
 *    whole app shell;
 *  - the role returned is the TOKEN's role, the one the API authorises with:
 *    showing a stale role from the node would make the UI offer actions the
 *    API then refuses;
 *  - writing a preference for a user that does not exist is NOT_FOUND, not a
 *    silent success that the next reload contradicts;
 *  - every query is scoped by the caller's own userId and tenantId.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => {})
vi.mock('@opengraphity/neo4j', () => ({ runQueryOne: (...a: unknown[]) => runQueryOne(...a), getSession: vi.fn(() => ({ close })) }))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { meResolvers } = await import('../me.js')
const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'bob@acme.io', role: 'operator' } as never

beforeEach(() => { runQueryOne.mockReset(); close.mockClear(); audit.mockClear() })

describe('me without a User node', () => {
  it('answers with the token identity and no preferences', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(meResolvers.Query.me(null, {}, ctx)).resolves.toEqual({
      id: 'u1', tenantId: 't1', email: 'bob@acme.io', name: 'bob@acme.io', role: 'operator',
      slackId: null, emailNotifications: null, language: null,
    })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('me with a User node', () => {
  it('the role is the token role, not the one stored on the node; name falls back to email', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@acme.io', role: 'admin' } })
    await expect(meResolvers.Query.me(null, {}, ctx)).resolves.toMatchObject({ role: 'operator', name: 'bob@acme.io' })
  })

  it('closes the session even when the read fails', async () => {
    runQueryOne.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(meResolvers.Query.me(null, {}, ctx)).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('preferences of a missing user', () => {
  it('setMyEmailNotifications → NOT_FOUND, and nothing is audited', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(meResolvers.Mutation.setMyEmailNotifications(null, { enabled: true }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('setMyLanguage → NOT_FOUND', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(meResolvers.Mutation.setMyLanguage(null, { language: 'en' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('preferences of an existing user', () => {
  it('setMyEmailNotifications audits the choice on the caller and returns the token role', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', tenant_id: 't1', email: 'bob@acme.io', role: 'admin', notifications_enabled: true } })
    await expect(meResolvers.Mutation.setMyEmailNotifications(null, { enabled: true }, ctx))
      .resolves.toMatchObject({ emailNotifications: true, role: 'operator' })
    expect(audit).toHaveBeenCalledWith(ctx, 'user.email_notifications.updated', 'User', 'u1', { enabled: true })
    // Scoped by the caller: a user can only change their own preference.
    expect((runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>])[2]).toMatchObject({ userId: 'u1', tenantId: 't1' })
  })
})
