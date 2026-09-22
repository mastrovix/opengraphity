/**
 * tenantLogin — what tenantLogin.test.ts leaves out: the parser's failure
 * modes, the out-of-range rules a realm can carry, the Google and SAML tests,
 * saving SAML providers, the missing-field guards, deactivate/remove.
 *
 * Why these matter for an admin of an organization:
 *  - a realm edited from the Keycloak console can carry rules outside the
 *    product's ranges: an untouched value must not block saving the others
 *    (A-19), while any value the admin CHANGES stays inside the range;
 *  - a policy the parser cannot read is an error, never a silent "no rules";
 *  - a provider is activated only if its test passed, and a network failure
 *    during the test is a failed check, not a crash that leaves the page blank;
 *  - the SAML metadata URL and the provider secret are kept across saves, so
 *    editing the display name does not force re-entering them;
 *  - every call goes to the organization's OWN realm (the tenant id).
 * Keycloak and the outside providers are doubles; no network is reached.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KeycloakAdmin } from '../../scripts/lib/keycloakAdmin.js'

const h = vi.hoisted(() => ({
  publicUrls: ['https://sso.example.com/'] as string[],
  created: [] as Array<Record<string, unknown>>,
  kc: null as unknown,
}))

vi.mock('../config.js', () => ({
  config: {
    get keycloakUrl() { return 'http://kc.internal:8080//' },
    get keycloakPublicUrls() { return h.publicUrls },
    get keycloakAdminUser() { return 'admin' },
    get keycloakAdminPassword() { return 'pw' },
  },
}))
vi.mock('../../scripts/lib/keycloakAdmin.js', () => ({
  createKeycloakAdmin: vi.fn((cfg: Record<string, unknown>) => { h.created.push(cfg); return h.kc }),
}))

const tl = await import('../tenantLogin.js')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string; params?: Record<string, unknown> } } }).extensions?.i18n?.key
const errParams = (e: unknown) => (e as { extensions?: { i18n?: { params?: Record<string, unknown> } } }).extensions?.i18n?.params
const catchErr = (fn: () => unknown) => { try { fn() } catch (e) { return e } return null }

function fakeKeycloak() {
  const state = {
    realm: { passwordPolicy: 'length(10)', bruteForceProtected: true, failureFactor: 2, maxFailureWaitSeconds: 60 } as Record<string, unknown>,
    idps: [] as Array<Record<string, unknown>>,
    flows: [] as Array<{ alias: string }>,
    executions: [] as Array<{ id: string; providerId: string; requirement: string }>,
    puts: [] as Array<{ path: string; body: Record<string, unknown> }>,
    posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
    gets: [] as string[],
    deletes: [] as string[],
    dropAfterSave: false,
  }
  const kc: KeycloakAdmin = {
    baseUrl: 'http://kc',
    getAdminToken: vi.fn(async () => 'tok'),
    get: vi.fn(async (_t: string, path: string) => {
      state.gets.push(path)
      if (path.endsWith('/identity-provider/instances')) return state.dropAfterSave && state.puts.length + state.posts.length > 0 ? [] : state.idps
      const m = /\/identity-provider\/instances\/(\w+)$/.exec(path)
      if (m) return state.idps.find((i) => i['alias'] === m[1])
      if (path.endsWith('/authentication/flows')) return state.flows
      if (path.endsWith('/executions')) return state.executions
      return state.realm
    }) as KeycloakAdmin['get'],
    exists: vi.fn(),
    post: vi.fn(async (_t: string, path: string, body: unknown) => {
      const b = body as Record<string, unknown>
      state.posts.push({ path, body: b })
      if (path.endsWith('/identity-provider/instances')) state.idps.push(b)
      return { created: true }
    }),
    put: vi.fn(async (_t: string, path: string, body: unknown) => {
      const b = body as Record<string, unknown>
      state.puts.push({ path, body: b })
      if (/\/identity-provider\/instances\/\w+$/.test(path)) state.idps = state.idps.map((i) => (i['alias'] === b['alias'] ? b : i))
    }),
    delete: vi.fn(async (_t: string, path: string) => { state.deletes.push(path) }),
    setPassword: vi.fn(),
  }
  h.kc = kc
  return { kc, state }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  h.publicUrls = ['https://sso.example.com/']
  h.created.length = 0
  tl.setKeycloakAdminForTests(null)
})
afterEach(() => { vi.unstubAllGlobals() })

const RULES = { minLength: 12, uppercase: 1, lowercase: 1, digits: 1, special: 1, notUsername: false, notEmail: true, history: 0, expireDays: 90, lockoutEnabled: true, lockoutFailures: 5, lockoutMinutes: 15 }

describe('password policy parsing', () => {
  it('an empty policy means no managed token; an unreadable part is an error', () => {
    expect(tl.parsePasswordPolicy(null)).toEqual([])
    expect(tl.parsePasswordPolicy('   ')).toEqual([])
    expect(() => tl.parsePasswordPolicy('length(8) and 42!')).toThrow(/unreadable part: "42!"/)
  })

  it('a token without argument takes the Keycloak default; a non-numeric argument is an error', () => {
    // `length` with no argument is what Keycloak treats as 8.
    expect(tl.rulesFromRealm({ passwordPolicy: 'length and digits()' })).toMatchObject({ minLength: 8, digits: 1, lockoutEnabled: false, lockoutFailures: 30, lockoutMinutes: 15 })
    expect(() => tl.rulesFromRealm({ passwordPolicy: 'length(abc)' })).toThrow(/"length" has a non-numeric value "abc"/)
  })

  it('the lockout minutes never round down to zero', () => {
    expect(tl.rulesFromRealm({ maxFailureWaitSeconds: 5 }).lockoutMinutes).toBe(1)
  })

  it('the policy string writes username and history rules when enabled', () => {
    expect(tl.policyString({ ...RULES, uppercase: 0, lowercase: 0, digits: 0, special: 0, notUsername: true, notEmail: false, history: 4, expireDays: 0 }, null))
      .toBe('length(12) and notUsername(undefined) and passwordHistory(4)')
  })

  it('the policy string writes every managed rule and drops the disabled ones', () => {
    expect(tl.policyString(RULES, 'hashIterations and notEmail(undefined)'))
      .toBe('length(12) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notEmail(undefined) and forceExpiredPasswordChange(90) and hashIterations')
  })
})

describe('rules outside the product ranges (A-19)', () => {
  it('lists every rule outside its range with the value the realm carries', () => {
    const out = tl.passwordRulesOutOfRange({ ...RULES, minLength: 2, lockoutFailures: 1.5 })
    expect(out.map((o) => o.rule)).toEqual(['minLength', 'lockoutFailures'])
    expect(out[0]).toMatchObject({ value: 2 })
    expect(tl.passwordRulesOutOfRange(RULES)).toEqual([])
  })

  it('a non-numeric rule is reported with value 0', () => {
    const out = tl.passwordRulesOutOfRange({ ...RULES, history: 'x' as unknown as number })
    expect(out).toEqual([expect.objectContaining({ rule: 'history', value: 0 })])
  })

  it('an out-of-range value identical to the realm is accepted; changing it keeps the range', () => {
    const current = { ...RULES, lockoutFailures: 1 }
    expect(tl.assertPasswordRules({ ...RULES, lockoutFailures: 1 }, current).lockoutFailures).toBe(1)
    expect(errKey(catchErr(() => tl.assertPasswordRules({ ...RULES, lockoutFailures: 0 }, current)))).toBe('errors.login.rule.lockoutFailures')
  })

  it('the on/off rules must be booleans; a missing body is rejected on the first rule', () => {
    expect(errKey(catchErr(() => tl.assertPasswordRules({ ...RULES, notEmail: 'yes' })))).toBe('errors.login.ruleShape')
    expect(errKey(catchErr(() => tl.assertPasswordRules(undefined)))).toMatch(/^errors\.login\.rule\./)
  })

  it('saving keeps an untouched out-of-range lockout from the realm and never sets a permanent lockout', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    // The realm has failureFactor 2 (below the product minimum): the admin only changes the length.
    const before = await tl.passwordRules('acme')
    expect(state.gets).toEqual(['/admin/realms/acme'])
    const res = await tl.setPasswordRules('acme', { ...before, minLength: 14, notUsername: false, notEmail: false, lockoutMinutes: 1 })
    expect(res.after).toMatchObject({ minLength: 14, lockoutFailures: 2 })
    expect(state.puts[0]!.body).toMatchObject({ failureFactor: 2, maxFailureWaitSeconds: 60, waitIncrementSeconds: 60, permanentLockout: false })
  })
})

describe('Keycloak admin client and public URL', () => {
  it('without a test client it builds one from config, trimming trailing slashes from the base URL', async () => {
    fakeKeycloak()
    await tl.passwordRules('acme')
    expect(h.created[0]).toEqual({ baseUrl: 'http://kc.internal:8080', adminUser: 'admin', adminPassword: 'pw' })
  })

  it('addresses of every provider are given before configuration, under the tenant realm', () => {
    expect(tl.loginProviderAddresses('ac me')).toEqual([
      { kind: 'microsoft', redirectUri: 'https://sso.example.com/realms/ac%20me/broker/microsoft/endpoint', samlSpMetadataUrl: null },
      { kind: 'google', redirectUri: 'https://sso.example.com/realms/ac%20me/broker/google/endpoint', samlSpMetadataUrl: null },
      { kind: 'saml', redirectUri: 'https://sso.example.com/realms/ac%20me/broker/saml/endpoint', samlSpMetadataUrl: 'https://sso.example.com/realms/ac%20me/broker/saml/endpoint/descriptor' },
    ])
  })

  it('no public URL is a loud error, not an address with "undefined" in it', () => {
    h.publicUrls = []
    expect(() => tl.redirectUriOf('acme', 'google')).toThrow(/KEYCLOAK_PUBLIC_URL has no URL/)
  })
})

describe('testLoginProvider', () => {
  it('an unknown provider kind is refused', async () => {
    const e = await tl.testLoginProvider('acme', { kind: 'github' as never }).catch((x: unknown) => x)
    expect(errKey(e)).toBe('errors.login.unknownProvider')
  })

  it('missing fields are listed per provider kind', async () => {
    expect(errParams(await tl.testLoginProvider('acme', { kind: 'microsoft', clientId: ' ', clientSecret: 's' }).catch((x: unknown) => x)))
      .toEqual({ fields: 'clientId, tenant' })
    expect(errParams(await tl.testLoginProvider('acme', { kind: 'saml' }).catch((x: unknown) => x))).toEqual({ fields: 'metadataUrl' })
  })

  it('Microsoft: an unknown tenant stops at discovery with Microsoft\'s description', async () => {
    const fetchMock = vi.fn(async () => json({ error_description: 'Tenant not found' }, 400))
    vi.stubGlobal('fetch', fetchMock)
    const r = await tl.testLoginProvider('acme', { kind: 'microsoft', clientId: 'a', clientSecret: 'b', tenant: 'nope' })
    expect(r).toEqual({ ok: false, checks: [{ key: 'microsoftTenant', ok: false, detail: 'Tenant not found' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('Microsoft: a non-JSON error body falls back to the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('.well-known')
      ? json({ token_endpoint: 'https://ms/token' })
      : new Response('<html>', { status: 503 }))))
    const r = await tl.testLoginProvider('acme', { kind: 'microsoft', clientId: 'a', clientSecret: 'b', tenant: 't' })
    expect(r.checks[1]).toEqual({ key: 'microsoftCredentials', ok: false, detail: '503' })
  })

  it('Google: reachable and a well-formed client id pass; a malformed id names itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const good = await tl.testLoginProvider('acme', { kind: 'google', clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's' })
    expect(good.ok).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)))
    const bad = await tl.testLoginProvider('acme', { kind: 'google', clientId: 'my-app', clientSecret: 's' })
    expect(bad.checks).toEqual([{ key: 'googleReachable', ok: false, detail: '500' }, { key: 'googleClientId', ok: false, detail: 'my-app' }])
  })

  it('a network failure is a failed "network" check, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await tl.testLoginProvider('acme', { kind: 'google', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' })
    expect(r).toEqual({ ok: false, checks: [{ key: 'network', ok: false, detail: 'ECONNREFUSED' }] })
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'offline' }))
    const r2 = await tl.testLoginProvider('acme', { kind: 'google', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' })
    expect(r2.checks[0]).toEqual({ key: 'network', ok: false, detail: 'offline' })
  })

  it('a provider that never answers is cut off after 10 seconds and reported as a network failure', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new Error('aborted')))
      })))
      const pending = tl.testLoginProvider('acme', { kind: 'google', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await pending).checks).toEqual([{ key: 'network', ok: false, detail: 'aborted' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('SAML: the metadata are imported in the tenant realm and must carry the sign-on URL', async () => {
    const { kc } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    const fetchMock = vi.fn(async () => json({ singleSignOnServiceUrl: 'https://idp/sso' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await tl.testLoginProvider('acme', { kind: 'saml', metadataUrl: ' https://idp/meta ' })).toEqual({ ok: true, checks: [{ key: 'samlMetadata', ok: true, detail: null }] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://kc/admin/realms/acme/identity-provider/import-config')
    expect(JSON.parse(String(init.body))).toEqual({ providerId: 'saml', fromUrl: 'https://idp/meta' })
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')

    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    expect((await tl.testLoginProvider('acme', { kind: 'saml', metadataUrl: 'https://idp/meta' })).checks[0]).toEqual({ key: 'samlMetadata', ok: false, detail: 'no singleSignOnServiceUrl' })
  })

  it('SAML: Keycloak refusing the import is a failed check carrying the reason', async () => {
    const { kc } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad metadata', { status: 400 })))
    const r = await tl.testLoginProvider('acme', { kind: 'saml', metadataUrl: 'https://idp/meta' })
    expect(r.checks[0]).toMatchObject({ key: 'samlMetadata', ok: false, detail: expect.stringContaining('400: bad metadata') as unknown as string })
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'kc down' }))
    expect((await tl.testLoginProvider('acme', { kind: 'saml', metadataUrl: 'https://idp/meta' })).checks[0]!.detail).toBe('kc down')
  })
})

describe('saveLoginProvider', () => {
  it('SAML: imports the metadata, keeps the URL, and reuses it when the next save omits it', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    // The flow already exists and its executions are already required: nothing to create.
    state.flows.push({ alias: tl.EXISTING_USERS_FLOW })
    state.executions.push({ id: 'e1', providerId: 'idp-detect-existing-broker-user', requirement: 'REQUIRED' }, { id: 'e2', providerId: 'idp-auto-link', requirement: 'REQUIRED' })
    vi.stubGlobal('fetch', vi.fn(async () => json({ singleSignOnServiceUrl: 'https://idp/sso' })))
    const first = await tl.saveLoginProvider('acme', { kind: 'saml', metadataUrl: 'https://idp/meta', displayName: 'Corporate SSO' }, false)
    expect(first.provider).toMatchObject({ kind: 'saml', displayName: 'Corporate SSO', enabled: false, clientId: null, metadataUrl: 'https://idp/meta', samlSpMetadataUrl: 'https://sso.example.com/realms/acme/broker/saml/endpoint/descriptor' })
    expect(state.idps[0]!['config']).toMatchObject({ singleSignOnServiceUrl: 'https://idp/sso', principalType: 'SUBJECT', syncMode: 'IMPORT' })
    expect(state.posts.filter((p) => p.path.includes('/authentication'))).toHaveLength(0)
    expect(state.puts.filter((p) => p.path.includes('/executions'))).toHaveLength(0)

    const second = await tl.saveLoginProvider('acme', { kind: 'saml' }, false)
    // The existing provider is updated in place and keeps name and metadata URL.
    expect(state.puts.at(-1)!.path).toBe('/admin/realms/acme/identity-provider/instances/saml')
    expect(second.provider).toMatchObject({ displayName: 'Corporate SSO', metadataUrl: 'https://idp/meta' })
  })

  it('SAML without any metadata URL is refused', async () => {
    const { kc } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    expect(errParams(await tl.saveLoginProvider('acme', { kind: 'saml' }, false).catch((x: unknown) => x))).toEqual({ fields: 'metadataUrl' })
  })

  it('a new OAuth provider needs client id and secret; Microsoft also the tenant', async () => {
    const { kc } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    expect(errParams(await tl.saveLoginProvider('acme', { kind: 'google' }, false).catch((x: unknown) => x))).toEqual({ fields: 'clientId' })
    expect(errParams(await tl.saveLoginProvider('acme', { kind: 'google', clientId: 'c' }, false).catch((x: unknown) => x))).toEqual({ fields: 'clientSecret' })
    expect(errParams(await tl.saveLoginProvider('acme', { kind: 'microsoft', clientId: 'c', clientSecret: 's' }, false).catch((x: unknown) => x))).toEqual({ fields: 'tenant' })
  })

  it('an existing provider keeps its secret and tenant; clearing the Google domain removes it', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    state.idps.push(
      { alias: 'microsoft', providerId: 'microsoft', enabled: true, config: { clientId: 'app', clientSecret: 'old', tenantId: 'acme.com' } },
      { alias: 'google', providerId: 'google', enabled: true, config: { clientId: 'g', clientSecret: 'x', hostedDomain: 'acme.com' } },
    )
    const ms = await tl.saveLoginProvider('acme', { kind: 'microsoft', displayName: '  ' }, false)
    expect(ms.provider).toMatchObject({ displayName: 'Microsoft', tenant: 'acme.com', clientId: 'app' })
    expect(state.idps[0]!['config']).toMatchObject({ clientSecret: 'old' })
    const g = await tl.saveLoginProvider('acme', { kind: 'google', hostedDomain: '' }, false)
    expect(g.provider.hostedDomain).toBeNull()
    const g2 = await tl.saveLoginProvider('acme', { kind: 'google', hostedDomain: ' corp.acme.com ' }, false)
    expect(g2.provider.hostedDomain).toBe('corp.acme.com')
  })

  it('a provider missing right after saving is an error, not a fabricated view', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    state.dropAfterSave = true
    await expect(tl.saveLoginProvider('acme', { kind: 'google', clientId: 'c', clientSecret: 's' }, false)).rejects.toThrow(/not found in realm acme right after saving/)
  })

  it('activating runs the test and returns it with the provider', async () => {
    const { kc } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const r = await tl.saveLoginProvider('acme', { kind: 'google', clientId: '1-a.apps.googleusercontent.com', clientSecret: 's' }, true)
    expect(r.provider.enabled).toBe(true)
    expect(r.test?.ok).toBe(true)
  })
})

describe('deactivate / remove', () => {
  it('deactivating turns the provider off in the tenant realm and keeps its configuration', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    state.idps.push({ alias: 'google', providerId: 'google', displayName: 'Staff', enabled: true, config: { clientId: 'g', hostedDomain: 'acme.com' } })
    const v = await tl.deactivateLoginProvider('acme', 'google')
    expect(state.puts[0]).toMatchObject({ path: '/admin/realms/acme/identity-provider/instances/google', body: { enabled: false, config: { clientId: 'g' } } })
    expect(v).toMatchObject({ kind: 'google', displayName: 'Staff', enabled: false, hostedDomain: 'acme.com' })
  })

  it('removing deletes only that provider; an unknown kind never reaches Keycloak', async () => {
    const { kc, state } = fakeKeycloak()
    tl.setKeycloakAdminForTests(kc)
    await tl.removeLoginProvider('acme', 'saml')
    expect(state.deletes).toEqual(['/admin/realms/acme/identity-provider/instances/saml'])
    await expect(tl.removeLoginProvider('acme', '../users')).rejects.toThrow(/Unknown login provider/)
    await expect(tl.deactivateLoginProvider('acme', 'x')).rejects.toThrow(/Unknown login provider/)
    expect(state.deletes).toHaveLength(1)
  })
})
