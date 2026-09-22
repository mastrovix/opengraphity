/**
 * Slack per organisation: the OAuth return leg and disconnection.
 *
 * Why these behaviours matter:
 *  - the OAuth callback is reachable by anyone on the internet: it must refuse a
 *    missing or forged state BEFORE calling Slack, and the installation must be
 *    saved on the tenant the SIGNED state names, never on one from the request;
 *  - a Slack refusal or an HTTP failure must not store anything;
 *  - with the one-click app not configured there is no state secret: the flow
 *    must say so rather than sign with an empty key;
 *  - disconnecting deletes only this tenant's installation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const txRun = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ executeWrite: (fn: (t: unknown) => unknown) => fn({ run: txRun }), close })),
}))
const saved = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@opengraphity/notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opengraphity/notifications')>()
  return { ...real, loadSlackInstallation: vi.fn(async () => saved.value) }
})

const { resetConfigCache } = await import('../config.js')
const { signInstallState, verifyInstallState, completeSlackOAuth, disconnectSlack, slackRequestUrls, connectSlackWithToken } = await import('../slackConnect.js')
const { decryptSecret } = await import('@opengraphity/notifications')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
const catchErr = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection') }, (e: unknown) => e)
const INSTALLATION = { tenantId: 'c-test', teamId: 'T1', teamName: 'Acme', mode: 'app', botUserId: 'UB', installedAt: 'x', installedByName: 'admin' }

beforeEach(() => {
  vi.stubEnv('SECRETS_ENCRYPTION_KEY', 'a'.repeat(64))
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'ssecret')
  vi.stubEnv('PUBLIC_BASE_URL', 'https://og.example.com/')
  resetConfigCache()
  txRun.mockReset()
  close.mockClear()
  saved.value = null
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetConfigCache() })

describe('slackRequestUrls', () => {
  it('lives on the public base URL (trailing slash trimmed), or is null without one', () => {
    expect(slackRequestUrls()).toEqual({
      commands: 'https://og.example.com/api/slack/commands',
      actions: 'https://og.example.com/api/slack/actions',
      oauthCallback: 'https://og.example.com/api/slack/oauth/callback',
    })
    vi.stubEnv('PUBLIC_BASE_URL', '')
    resetConfigCache()
    expect(slackRequestUrls()).toBeNull()
  })
})

describe('the signed state', () => {
  it('without a platform client secret there is no signing key: it says so', () => {
    vi.stubEnv('SLACK_CLIENT_SECRET', '')
    resetConfigCache()
    expect(() => signInstallState({ t: 't', u: 'u', name: 'n', r: 'r' })).toThrow(/SLACK_CLIENT_SECRET is not set/)
  })

  it.each(['', 'nodot', '.mac', 'body.'])('a malformed state (%j) is refused', (raw) => {
    let err: unknown
    try { verifyInstallState(raw) } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.slack.badState')
  })

  it('a mac of a different length is refused without comparing', () => {
    const state = signInstallState({ t: 't', u: 'u', name: 'n', r: 'r' })
    const [body] = state.split('.')
    let err: unknown
    try { verifyInstallState(`${body!}.short`) } catch (e) { err = e }
    expect(errKey(err)).toBe('errors.slack.badState')
  })
})

describe('completeSlackOAuth', () => {
  const okResponse = { ok: true, access_token: 'xoxb-from-oauth', bot_user_id: 'UB', team: { id: 'T1', name: 'Acme' } }

  it('exchanges the code and saves the installation on the tenant the SIGNED state names', async () => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'admin@c-test', r: 'https://c-test/admin/integrations' })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okResponse)))
    vi.stubGlobal('fetch', fetchMock)
    txRun.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] })
    saved.value = INSTALLATION

    const out = await completeSlackOAuth('the-code', state)
    expect(out.state).toMatchObject({ t: 'c-test', u: 'u1', r: 'https://c-test/admin/integrations' })
    expect(out.installation).toBe(INSTALLATION)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }]
    expect(url).toBe('https://slack.com/api/oauth.v2.access')
    const form = new URLSearchParams(init.body)
    expect(form.get('code')).toBe('the-code')
    expect(form.get('redirect_uri')).toBe('https://og.example.com/api/slack/oauth/callback')
    // No bearer token on the exchange: the client credentials travel in the form.
    expect(init.headers['Authorization']).toBeUndefined()

    const params = txRun.mock.calls[1]![1] as Record<string, unknown>
    expect(params).toMatchObject({ tenantId: 'c-test', teamId: 'T1', mode: 'app', installedBy: 'u1', installedByName: 'admin@c-test', signingSecretEnc: null })
    expect(decryptSecret(String(params['botTokenEnc']))).toBe('xoxb-from-oauth')
    expect(close).toHaveBeenCalled()
  })

  it('a missing bot user id is stored as null', async () => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'r' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...okResponse, bot_user_id: undefined }))))
    txRun.mockResolvedValue({ records: [] })
    saved.value = INSTALLATION
    await completeSlackOAuth('c', state)
    expect((txRun.mock.calls[1]![1] as Record<string, unknown>)['botUserId']).toBeNull()
  })

  it('a forged state is refused before calling Slack', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(errKey(await catchErr(completeSlackOAuth('c', 'forged.state')))).toBe('errors.slack.badState')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the platform app switched off between start and return → refused, nothing called', async () => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'r' })
    vi.stubEnv('SLACK_SIGNING_SECRET', '')
    resetConfigCache()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(errKey(await catchErr(completeSlackOAuth('c', state)))).toBe('errors.slack.appNotConfigured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['ok:false with an error', { ok: false, error: 'invalid_code' }, 'invalid_code'],
    ['no token', { ok: true, team: { id: 'T1', name: 'A' } }, 'no token'],
    ['no team', { ok: true, access_token: 'xoxb-1' }, 'no token'],
  ])('Slack refusal (%s) → nothing saved', async (_l, body, msg) => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'r' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))))
    const err = await catchErr(completeSlackOAuth('c', state))
    expect(errKey(err)).toBe('errors.slack.oauthRefused')
    expect((err as Error).message).toContain(msg)
    expect(txRun).not.toHaveBeenCalled()
  })

  it('an HTTP failure from Slack → an error, nothing saved', async () => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'r' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })))
    await expect(completeSlackOAuth('c', state)).rejects.toThrow(/Slack oauth.v2.access: HTTP 502/)
    expect(txRun).not.toHaveBeenCalled()
  })

  it('an installation that cannot be read back right after saving is an error, not a silent null', async () => {
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'r' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(okResponse))))
    txRun.mockResolvedValue({ records: [] })
    saved.value = null
    await expect(completeSlackOAuth('c', state)).rejects.toThrow(/not found right after saving/)
  })
})

describe('connectSlackWithToken (edge cases)', () => {
  const SIGNING = '0123456789abcdef0123456789abcdef'

  it('the team name falls back to the team id, and the inputs are trimmed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: 'T9' }))))
    txRun.mockResolvedValue({ records: [] })
    saved.value = INSTALLATION
    await connectSlackWithToken({ tenantId: 'c-test', userId: 'u1', userEmail: 'e' }, '  xoxb-tok  ', ` ${SIGNING} `)
    expect(txRun.mock.calls[1]![1]).toMatchObject({ teamName: 'T9', botUserId: null, tenantId: 'c-test' })
  })

  it('Slack accepting the call but without a team id is a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))))
    const err = await catchErr(connectSlackWithToken({ tenantId: 'c-test', userId: 'u1', userEmail: 'e' }, 'xoxb-tok', SIGNING))
    expect(errKey(err)).toBe('errors.slack.tokenRefused')
    expect((err as Error).message).toContain('unknown error')
  })
})

describe('disconnectSlack', () => {
  it('nothing connected → null, nothing deleted', async () => {
    saved.value = null
    expect(await disconnectSlack('c-test')).toBeNull()
    expect(txRun).not.toHaveBeenCalled()
  })

  it('deletes only this tenant\'s installation and returns what was removed', async () => {
    saved.value = INSTALLATION
    txRun.mockResolvedValueOnce({ records: [] })
    expect(await disconnectSlack('c-test')).toBe(INSTALLATION)
    const [cypher, params] = txRun.mock.calls[0] as [string, Record<string, unknown>]
    expect(cypher).toContain('SlackInstallation {tenant_id: $tenantId}')
    expect(params).toEqual({ tenantId: 'c-test' })
    expect(close).toHaveBeenCalled()
  })
})

describe('a Slack that never answers', () => {
  it('is aborted after 10 seconds instead of hanging the admin\'s request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      vi.stubGlobal('fetch', vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => { rej(new Error('aborted by timeout')) })
      })))
      const p = catchErr(connectSlackWithToken({ tenantId: 'c-test', userId: 'u1', userEmail: 'e' }, 'xoxb-tok', '0123456789abcdef0123456789abcdef'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(((await p) as Error).message).toBe('aborted by timeout')
      expect(txRun).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
