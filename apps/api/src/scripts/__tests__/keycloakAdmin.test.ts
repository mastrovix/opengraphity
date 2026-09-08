import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { assignRealmRole, createKeycloakAdmin, findUserIdByEmail, keycloakConfigFromEnv } from '../lib/keycloakAdmin.js'

type Call = { url: string; init?: RequestInit }

function fakeResponse(status: number, body: unknown = null, headers: Record<string, string> = {}): Response {
  return {
    ok:      status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json:    async () => body,
    text:    async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function makeClient(responses: Response[]) {
  const calls: Call[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error(`fetch inatteso: ${String(url)}`)
    return next
  })
  const kc = createKeycloakAdmin({
    baseUrl: 'http://kc.test/', adminUser: 'admin', adminPassword: 's3cret',
    fetch: fetchMock as unknown as typeof fetch,
  })
  return { kc, calls }
}

describe('createKeycloakAdmin', () => {
  it('strips trailing slashes from baseUrl', () => {
    expect(makeClient([]).kc.baseUrl).toBe('http://kc.test/')
    expect(createKeycloakAdmin({ baseUrl: 'http://x', adminUser: 'a', adminPassword: 'b' }).baseUrl).toBe('http://x')
  })

  it('getAdminToken posts the password grant and returns the token', async () => {
    const { kc, calls } = makeClient([fakeResponse(200, { access_token: 'tok' })])
    await expect(kc.getAdminToken()).resolves.toBe('tok')
    expect(calls[0]!.url).toBe('http://kc.test//realms/master/protocol/openid-connect/token')
    const body = calls[0]!.init!.body as URLSearchParams
    expect(body.get('grant_type')).toBe('password')
    expect(body.get('username')).toBe('admin')
    expect(body.get('password')).toBe('s3cret')
  })

  it('getAdminToken fails loudly on auth error or missing token', async () => {
    await expect(makeClient([fakeResponse(401)]).kc.getAdminToken()).rejects.toThrow(/Keycloak auth fallita \(401\)/)
    await expect(makeClient([fakeResponse(200, {})]).kc.getAdminToken()).rejects.toThrow(/senza access_token/)
  })

  it('get returns JSON on 2xx and throws with body on error', async () => {
    const { kc, calls } = makeClient([fakeResponse(200, [{ id: '1' }])])
    await expect(kc.get('tok', '/admin/realms/x')).resolves.toEqual([{ id: '1' }])
    expect((calls[0]!.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer tok')

    await expect(makeClient([fakeResponse(403, 'forbidden')]).kc.get('tok', '/p')).rejects.toThrow('GET /p → 403: forbidden')
  })

  it('exists maps 404 → false, 2xx → true, others → error', async () => {
    await expect(makeClient([fakeResponse(404)]).kc.exists('t', '/r')).resolves.toBe(false)
    await expect(makeClient([fakeResponse(200, {})]).kc.exists('t', '/r')).resolves.toBe(true)
    await expect(makeClient([fakeResponse(500, 'boom')]).kc.exists('t', '/r')).rejects.toThrow('GET /r → 500: boom')
  })

  it('post returns the id from Location on 201 and created:false on 409', async () => {
    const { kc, calls } = makeClient([fakeResponse(201, null, { location: 'http://kc.test/admin/realms/x/users/abc' })])
    await expect(kc.post('t', '/admin/realms/x/users', { a: 1 })).resolves.toEqual({ id: 'abc', created: true })
    expect(calls[0]!.init!.method).toBe('POST')
    expect(calls[0]!.init!.body).toBe('{"a":1}')

    await expect(makeClient([fakeResponse(409)]).kc.post('t', '/p', {})).resolves.toEqual({ created: false })
    await expect(makeClient([fakeResponse(204)]).kc.post('t', '/p', {})).resolves.toEqual({ id: undefined, created: true })
    await expect(makeClient([fakeResponse(400, 'bad')]).kc.post('t', '/p', {})).rejects.toThrow('POST /p → 400: bad')
  })

  it('put throws on non-2xx; setPassword targets reset-password', async () => {
    const { kc, calls } = makeClient([fakeResponse(204)])
    await kc.setPassword('t', 'acme', 'u1', 'pw', true)
    expect(calls[0]!.url).toBe('http://kc.test//admin/realms/acme/users/u1/reset-password')
    expect(calls[0]!.init!.method).toBe('PUT')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ type: 'password', value: 'pw', temporary: true })

    await expect(makeClient([fakeResponse(500, 'x')]).kc.put('t', '/p', {})).rejects.toThrow('PUT /p → 500: x')
  })
})

describe('findUserIdByEmail / assignRealmRole', () => {
  it('finds the user by exact email', async () => {
    const { kc, calls } = makeClient([fakeResponse(200, [{ id: 'u9' }])])
    await expect(findUserIdByEmail(kc, 't', 'acme', 'a+b@x.io')).resolves.toBe('u9')
    expect(calls[0]!.url).toContain('/admin/realms/acme/users?email=a%2Bb%40x.io&exact=true')
    await expect(findUserIdByEmail(makeClient([fakeResponse(200, [])]).kc, 't', 'acme', 'n@x')).rejects.toThrow(/non trovato/)
  })

  it('assigns an existing role without creating it', async () => {
    const { kc, calls } = makeClient([
      fakeResponse(200, [{ id: 'r1', name: 'user' }]),
      fakeResponse(204),
    ])
    await expect(assignRealmRole(kc, 't', 'acme', 'u1', 'user', false)).resolves.toEqual({ roleCreated: false })
    expect(calls[1]!.url).toBe('http://kc.test//admin/realms/acme/users/u1/role-mappings/realm')
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual([{ id: 'r1', name: 'user' }])
  })

  it('creates a missing role when allowed, fails otherwise', async () => {
    const { kc } = makeClient([
      fakeResponse(200, []),
      fakeResponse(201),
      fakeResponse(200, [{ id: 'r2', name: 'viewer' }]),
      fakeResponse(204),
    ])
    await expect(assignRealmRole(kc, 't', 'acme', 'u1', 'viewer', true)).resolves.toEqual({ roleCreated: true })

    await expect(assignRealmRole(makeClient([fakeResponse(200, [])]).kc, 't', 'acme', 'u1', 'viewer', false))
      .rejects.toThrow('Ruolo "viewer" non trovato nel realm "acme"')
  })
})

describe('keycloakConfigFromEnv', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env['KEYCLOAK_URL']
    delete process.env['KEYCLOAK_ADMIN_USER']
    delete process.env['KEYCLOAK_ADMIN_PASSWORD']
    delete process.env['NODE_ENV']
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('requires KEYCLOAK_ADMIN_PASSWORD with no default', () => {
    expect(() => keycloakConfigFromEnv()).toThrow('Environment variable KEYCLOAK_ADMIN_PASSWORD is required but is not set')
  })

  it('uses local defaults for url/user outside production', () => {
    process.env['KEYCLOAK_ADMIN_PASSWORD'] = 'pw'
    expect(keycloakConfigFromEnv()).toEqual({ baseUrl: 'http://localhost:8080', adminUser: 'admin', adminPassword: 'pw' })
  })

  it('refuses the localhost default in production', () => {
    process.env['KEYCLOAK_ADMIN_PASSWORD'] = 'pw'
    process.env['NODE_ENV'] = 'production'
    expect(() => keycloakConfigFromEnv()).toThrow(/KEYCLOAK_URL is required in production/)
  })
})
