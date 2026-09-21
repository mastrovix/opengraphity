/**
 * Ondata 8 di «Nulla cablato»: regole delle password e login aziendale scritti
 * nel realm Keycloak dell'organizzazione.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { KeycloakAdmin } from '../../scripts/lib/keycloakAdmin.js'

const {
  parsePasswordPolicy, rulesFromRealm, policyString, assertPasswordRules, setPasswordRules,
  saveLoginProvider, testLoginProvider, loginProviders, setKeycloakAdminForTests, EXISTING_USERS_FLOW,
} = await import('../tenantLogin.js')

const errKey = (e: unknown) => (e as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key

/** Un Keycloak finto: realm, provider, flussi. */
function fakeKeycloak() {
  const state = {
    realm: { passwordPolicy: 'hashAlgorithm(pbkdf2-sha512) and length(10)', bruteForceProtected: false, failureFactor: 30, maxFailureWaitSeconds: 900 } as Record<string, unknown>,
    idps: [] as Array<Record<string, unknown>>,
    flows: [] as Array<{ alias: string }>,
    executions: [] as Array<{ id: string; providerId: string; requirement: string }>,
    puts: [] as Array<{ path: string; body: unknown }>,
  }
  const kc: KeycloakAdmin = {
    baseUrl: 'http://kc',
    getAdminToken: vi.fn(async () => 'tok'),
    get: vi.fn(async (_t: string, path: string) => {
      if (path.endsWith('/identity-provider/instances')) return state.idps
      if (/\/identity-provider\/instances\/\w+$/.test(path)) return state.idps.find((i) => path.endsWith(`/${String(i['alias'])}`))
      if (path.endsWith('/authentication/flows')) return state.flows
      if (path.endsWith('/executions')) return state.executions
      return state.realm
    }) as KeycloakAdmin['get'],
    exists: vi.fn(),
    post: vi.fn(async (_t: string, path: string, body: unknown) => {
      const b = body as Record<string, unknown>
      if (path.endsWith('/identity-provider/instances')) state.idps.push(b)
      if (path.endsWith('/authentication/flows')) state.flows.push({ alias: String(b['alias']) })
      if (path.endsWith('/execution')) state.executions.push({ id: `e${String(state.executions.length)}`, providerId: String(b['provider']), requirement: 'DISABLED' })
      return { created: true }
    }),
    put: vi.fn(async (_t: string, path: string, body: unknown) => {
      state.puts.push({ path, body })
      if (path.endsWith('/executions')) {
        const e = body as { id: string; requirement: string }
        state.executions = state.executions.map((x) => (x.id === e.id ? { ...x, requirement: e.requirement } : x))
      } else if (/\/identity-provider\/instances\/\w+$/.test(path)) {
        const b = body as Record<string, unknown>
        state.idps = state.idps.map((i) => (i['alias'] === b['alias'] ? b : i))
      } else {
        Object.assign(state.realm, body)
      }
    }),
    delete: vi.fn(),
    setPassword: vi.fn(),
  }
  return { kc, state }
}

beforeEach(() => { vi.stubEnv('KEYCLOAK_PUBLIC_URL', 'https://sso.example.com') })
afterEach(() => { setKeycloakAdminForTests(null); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const RULES = { minLength: 12, uppercase: 1, lowercase: 1, digits: 1, special: 0, notUsername: true, notEmail: false, history: 5, expireDays: 0, lockoutEnabled: true, lockoutFailures: 5, lockoutMinutes: 15 }

describe('regole delle password', () => {
  it('si leggono dalla policy del realm, e i pezzi che la pagina non governa si conservano', () => {
    expect(parsePasswordPolicy('length(8) and notUsername(undefined)')).toEqual([{ name: 'length', arg: '8' }, { name: 'notUsername', arg: 'undefined' }])
    expect(rulesFromRealm({ passwordPolicy: 'length(8) and digits(2) and passwordHistory(3)', bruteForceProtected: true, failureFactor: 5, maxFailureWaitSeconds: 600 }))
      .toMatchObject({ minLength: 8, digits: 2, uppercase: 0, history: 3, lockoutEnabled: true, lockoutFailures: 5, lockoutMinutes: 10 })
    expect(policyString(RULES, 'hashAlgorithm(pbkdf2-sha512) and length(8) and digits(3)'))
      .toBe('length(12) and upperCase(1) and lowerCase(1) and digits(1) and notUsername(undefined) and passwordHistory(5) and hashAlgorithm(pbkdf2-sha512)')
  })

  it('valori fuori intervallo o caratteri obbligatori più lunghi del minimo → rifiutati con la chiave', () => {
    expect(errKey((() => { try { assertPasswordRules({ ...RULES, minLength: 3 }) } catch (e) { return e } })())).toBe('errors.login.rule.minLength')
    expect(errKey((() => { try { assertPasswordRules({ ...RULES, minLength: 6, uppercase: 3, digits: 4 }) } catch (e) { return e } })())).toBe('errors.login.rulesExceedLength')
  })

  it('il salvataggio scrive policy e blocco nel realm; il blocco non è mai permanente', async () => {
    const { kc, state } = fakeKeycloak()
    setKeycloakAdminForTests(kc)
    const { before, after } = await setPasswordRules('c-test', RULES)
    expect(before.minLength).toBe(10)
    expect(after).toEqual(RULES)
    expect(state.puts.at(-1)!.path).toBe('/admin/realms/c-test')
    expect(state.puts.at(-1)!.body).toMatchObject({ bruteForceProtected: true, failureFactor: 5, maxFailureWaitSeconds: 900, permanentLockout: false })
    expect(String((state.puts.at(-1)!.body as { passwordPolicy: string }).passwordPolicy)).toContain('hashAlgorithm(pbkdf2-sha512)')
  })
})

describe('login aziendale', () => {
  const MS = { kind: 'microsoft' as const, clientId: 'app-1', clientSecret: 's3cret', tenant: 'acme.onmicrosoft.com' }

  it('mancano dati → rifiutato prima di chiamare chiunque', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(errKey(await testLoginProvider('c-test', { kind: 'microsoft', clientId: 'x' }).catch((e: unknown) => e))).toBe('errors.login.missingFields')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Microsoft: la prova chiede un token con id e segreto; se Microsoft li rifiuta il provider NON si attiva e non si scrive niente', async () => {
    const { kc, state } = fakeKeycloak()
    setKeycloakAdminForTests(kc)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('.well-known')
      ? new Response(JSON.stringify({ token_endpoint: 'https://login.microsoftonline.com/t/oauth2/v2.0/token' }))
      : new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace' }), { status: 401 }))))
    const test = await testLoginProvider('c-test', MS)
    expect(test.ok).toBe(false)
    expect(test.checks).toEqual([{ key: 'microsoftTenant', ok: true, detail: null }, { key: 'microsoftCredentials', ok: false, detail: 'AADSTS7000215: Invalid client secret provided.' }])
    expect(errKey(await saveLoginProvider('c-test', MS, true).catch((e: unknown) => e))).toBe('errors.login.testFailed')
    expect(state.idps).toHaveLength(0)
  })

  it('prova superata → provider acceso, primo accesso solo per chi esiste già, segreto mai restituito', async () => {
    const { kc, state } = fakeKeycloak()
    setKeycloakAdminForTests(kc)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes('.well-known') ? { token_endpoint: 'https://login.microsoftonline.com/t/token' } : { access_token: 'x' }))))
    const { provider } = await saveLoginProvider('c-test', MS, true)
    expect(provider).toEqual({
      kind: 'microsoft', displayName: 'Microsoft', enabled: true, clientId: 'app-1', tenant: 'acme.onmicrosoft.com', hostedDomain: null, metadataUrl: null,
      redirectUri: 'https://sso.example.com/realms/c-test/broker/microsoft/endpoint', samlSpMetadataUrl: null,
    })
    expect(JSON.stringify(provider)).not.toContain('s3cret')
    const idp = state.idps[0]!
    expect(idp).toMatchObject({ alias: 'microsoft', providerId: 'microsoft', enabled: true, trustEmail: true, firstBrokerLoginFlowAlias: EXISTING_USERS_FLOW })
    // Keycloak 24 rifiuta i campi che non conosce (visto dal vivo con `hideOnLogin`)
    expect(Object.keys(idp).sort()).toEqual(['alias', 'config', 'displayName', 'enabled', 'firstBrokerLoginFlowAlias', 'providerId', 'storeToken', 'trustEmail'])
    // il flusso del primo accesso: persona esistente collegata, nessuna creazione
    expect(state.flows.map((f) => f.alias)).toEqual([EXISTING_USERS_FLOW])
    expect(state.executions.map((e) => [e.providerId, e.requirement])).toEqual([['idp-detect-existing-broker-user', 'REQUIRED'], ['idp-auto-link', 'REQUIRED']])
  })

  it('salvare senza attivare spegne sempre il provider (la configurazione cambiata va riprovata); la lista mostra solo i provider della pagina', async () => {
    const { kc, state } = fakeKeycloak()
    setKeycloakAdminForTests(kc)
    state.idps.push({ alias: 'google', providerId: 'google', enabled: true, config: { clientId: '1-a.apps.googleusercontent.com', clientSecret: '**********' } })
    state.idps.push({ alias: 'github', providerId: 'github', enabled: true, config: {} })
    const { provider } = await saveLoginProvider('c-test', { kind: 'google', hostedDomain: 'acme.com' }, false)
    expect(provider).toMatchObject({ kind: 'google', enabled: false, hostedDomain: 'acme.com', clientId: '1-a.apps.googleusercontent.com' })
    expect((await loginProviders('c-test')).map((p) => p.kind)).toEqual(['google'])
  })
})
