/**
 * Ondata 8 di «Nulla cablato»: Slack collegato per organizzazione, in due modi.
 * Qui lo state firmato del giro OAuth, la prova del token prima del
 * salvataggio, il workspace che appartiene a una sola organizzazione e la
 * cifratura dei segreti.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const tx = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ executeWrite: (fn: (t: unknown) => unknown) => fn(tx), close: vi.fn() })),
}))
const saved = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@opengraphity/notifications', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opengraphity/notifications')>()
  return { ...real, loadSlackInstallation: vi.fn(async () => saved.value) }
})

const { resetConfigCache } = await import('../config.js')
const { signInstallState, verifyInstallState, connectSlackWithToken, slackAuthorizeUrl, slackAppAvailable } = await import('../slackConnect.js')
const { encryptSecret, decryptSecret } = await import('@opengraphity/notifications')

const KEY = 'a'.repeat(64)
const ctx = { tenantId: 'c-test', userId: 'u1', userEmail: 'admin@c-test.local' }
const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key

beforeEach(() => {
  vi.stubEnv('SECRETS_ENCRYPTION_KEY', KEY)
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'ssecret')
  vi.stubEnv('PUBLIC_BASE_URL', 'https://og.example.com/')
  resetConfigCache()
  tx.run.mockReset()
  saved.value = null
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetConfigCache() })

describe('segreti cifrati', () => {
  it('si cifrano e si decifrano con la chiave della piattaforma; con un\'altra chiave no', () => {
    const sealed = encryptSecret('xoxb-secret')
    expect(sealed).toMatch(/^v1:/)
    expect(sealed).not.toContain('xoxb')
    expect(decryptSecret(sealed)).toBe('xoxb-secret')
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', 'b'.repeat(64))
    expect(() => decryptSecret(sealed)).toThrow(/not the key it was saved with/)
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', '')
    expect(() => encryptSecret('x')).toThrow(/SECRETS_ENCRYPTION_KEY is not set/)
  })
})

describe('«Aggiungi a Slack»', () => {
  it('lo state è firmato e scade: manomesso o vecchio viene rifiutato', () => {
    const now = Date.parse('2026-09-15T10:00:00Z')
    const state = signInstallState({ t: 'c-test', u: 'u1', name: 'a', r: 'http://c-test.localhost/admin/integrations' }, now)
    expect(verifyInstallState(state, now + 60_000).t).toBe('c-test')
    const [body, mac] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), t: 'c-one' })).toString('base64url')
    expect(() => verifyInstallState(`${forged}.${mac!}`, now)).toThrow(/Invalid Slack installation state/)
    expect(() => verifyInstallState(state, now + 11 * 60_000)).toThrow(/took too long/)
  })

  it('l\'indirizzo porta client, scope e ritorno sull\'indirizzo pubblico; senza app della piattaforma non si offre', () => {
    const url = new URL(slackAuthorizeUrl(ctx, 'http://c-test.localhost/admin/integrations'))
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('commands,chat:write')
    expect(url.searchParams.get('redirect_uri')).toBe('https://og.example.com/api/slack/oauth/callback')
    vi.stubEnv('SLACK_CLIENT_ID', '')
    resetConfigCache()
    expect(slackAppAvailable()).toBe(false)
    expect(() => slackAuthorizeUrl(ctx, 'http://c-test.localhost/x')).toThrow(/not configured/)
  })
})

describe('collegamento con il token dell\'app dell\'organizzazione', () => {
  const SIGNING = '0123456789abcdef0123456789abcdef'

  it('forma sbagliata → rifiutato prima di chiamare Slack', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(errKey(await connectSlackWithToken(ctx, 'xoxp-user', SIGNING).catch((e: unknown) => e))).toBe('errors.slack.badToken')
    expect(errKey(await connectSlackWithToken(ctx, 'xoxb-1', 'short').catch((e: unknown) => e))).toBe('errors.slack.badSigningSecret')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('il token si prova (auth.test): se Slack lo rifiuta non si salva niente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }))))
    expect(errKey(await connectSlackWithToken(ctx, 'xoxb-1', SIGNING).catch((e: unknown) => e))).toBe('errors.slack.tokenRefused')
    expect(tx.run).not.toHaveBeenCalled()
  })

  it('token buono → salvato CIFRATO sull\'organizzazione; un workspace di un\'altra organizzazione è rifiutato', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: 'T1', team: 'Acme', user_id: 'UBOT' })))
    vi.stubGlobal('fetch', fetchMock)
    tx.run.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] })
    saved.value = { tenantId: 'c-test', teamId: 'T1', teamName: 'Acme', mode: 'token', botUserId: 'UBOT', installedAt: 'x', installedByName: 'admin@c-test.local' }
    await expect(connectSlackWithToken(ctx, 'xoxb-good', SIGNING)).resolves.toMatchObject({ teamId: 'T1', mode: 'token' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(init.headers['Authorization']).toBe('Bearer xoxb-good')
    const params = tx.run.mock.calls[1]![1] as Record<string, string>
    expect(params['botTokenEnc']).toMatch(/^v1:/)
    expect(decryptSecret(params['botTokenEnc']!)).toBe('xoxb-good')
    expect(decryptSecret(params['signingSecretEnc']!)).toBe(SIGNING)

    tx.run.mockReset().mockResolvedValueOnce({ records: [{ get: () => 'c-one' }] })
    expect(errKey(await connectSlackWithToken(ctx, 'xoxb-good', SIGNING).catch((e: unknown) => e))).toBe('errors.slack.teamTaken')
  })

  it('senza SECRETS_ENCRYPTION_KEY non si salva, e lo dice', async () => {
    vi.stubEnv('SECRETS_ENCRYPTION_KEY', '')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, team_id: 'T1', team: 'Acme' }))))
    expect(errKey(await connectSlackWithToken(ctx, 'xoxb-good', SIGNING).catch((e: unknown) => e))).toBe('errors.slack.noSecretsKey')
    expect(tx.run).not.toHaveBeenCalled()
  })
})
