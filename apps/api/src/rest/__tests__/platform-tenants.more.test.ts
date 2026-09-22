/**
 * The platform console routes, on a real Express: tenant CREATION, the
 * Keycloak side-effects of password reset and permanent deletion, and the
 * wiring guard on the actor.
 *
 * Why these behaviours matter:
 *  - Creating a tenant is the most consequential click in the console. Bad
 *    input (an e-mail that is not one, an unknown plan, an invented time
 *    zone) must be a 400 BEFORE Keycloak is touched: an invented zone does not
 *    fail at creation, it fails months later on the first SLA computation.
 *  - The console's own host must be a reserved slug, read from configuration.
 *  - The temporary password is handed over ONCE. If onboarding collapses
 *    after the password was set, the 500 must still carry it — otherwise the
 *    new tenant's administrator is locked out (it happened with the script).
 *  - Password reset must set a TEMPORARY password on the right realm/user;
 *    deletion must delete the realm named by the lifecycle, nothing else.
 *  - A route reached without the platform middleware must fail, not act
 *    anonymously.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v) }))
// The actor is set unless the request asks us not to: that is how we reach
// the "middleware missing" guard without a second router.
vi.mock('../../auth/platformAuth.js', () => ({
  platformAuthMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-no-actor'] !== '1') req.platformActor = { email: 'ops@platform.example', subject: 'sub-1' }
    next()
  },
}))
const cfg = vi.hoisted(() => ({ platformHost: 'opengrafo-admin.localhost' as string | undefined }))
vi.mock('../../lib/config.js', () => ({ config: cfg }))

const lifecycle = vi.hoisted(() => ({
  listTenants:        vi.fn(async () => [] as unknown[]),
  tenantFootprint:    vi.fn(async () => ({})),
  renameTenant:       vi.fn(async () => {}),
  suspendTenant:      vi.fn(async () => {}),
  resumeTenant:       vi.fn(async () => {}),
  purgeTenant:        vi.fn(),
  assertSlugValido:   vi.fn(),
  resetAdminPassword: vi.fn(),
}))
vi.mock('../../lib/tenantLifecycle.js', () => lifecycle)

const kc = vi.hoisted(() => ({
  getAdminToken: vi.fn(async () => 'tok'),
  delete:        vi.fn(async () => {}),
  setPassword:   vi.fn(async () => {}),
}))
const findUserIdByEmail = vi.hoisted(() => vi.fn(async () => 'kc-user-1'))
vi.mock('../../scripts/lib/keycloakAdmin.js', () => ({
  createKeycloakAdmin: () => kc,
  keycloakConfigFromEnv: () => ({}),
  findUserIdByEmail,
}))
vi.mock('../../scripts/lib/password.js', () => ({ generateTemporaryPassword: () => 'Temp-Pw-1' }))
const onboardTenant = vi.hoisted(() => vi.fn())
vi.mock('../../lib/tenantOnboarding.js', () => ({ onboardTenant }))

const { getSession } = await import('@opengraphity/neo4j')
const { platformTenantsRouter } = await import('../platform-tenants.js')

let server: Server
let base: string
const session = { close: vi.fn().mockResolvedValue(undefined) }

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(platformTenantsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/tenants`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  cfg.platformHost = 'opengrafo-admin.localhost'
  vi.mocked(getSession).mockReturnValue(session as never)
})

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('POST /platform/tenants — validation happens before Keycloak', () => {
  it('the console host is a reserved slug, taken from configuration', async () => {
    onboardTenant.mockResolvedValue({ steps: [] })
    await post({ slug: '  ACME ', adminEmail: 'a@acme.io' })
    // The slug is trimmed and lower-cased before validation.
    expect(lifecycle.assertSlugValido).toHaveBeenCalledWith('acme', ['opengrafo-admin'])
  })

  it('without a configured console host nothing extra is reserved', async () => {
    cfg.platformHost = undefined
    onboardTenant.mockResolvedValue({ steps: [] })
    await post({ slug: 'acme', adminEmail: 'a@acme.io' })
    expect(lifecycle.assertSlugValido).toHaveBeenCalledWith('acme', [])
  })

  it('an invalid slug is refused by the lifecycle with its own message', async () => {
    const { ValidationError } = await import('../../lib/errors.js')
    lifecycle.assertSlugValido.mockImplementationOnce(() => { throw new ValidationError('slug "admin" is reserved') })
    const res = await post({ slug: 'admin', adminEmail: 'a@acme.io' })
    expect(res.status).toBe(400)
    expect(onboardTenant).not.toHaveBeenCalled()
  })

  it.each([
    [{ slug: 'acme', adminEmail: 'not-an-email' }, /adminEmail/],
    [{ slug: 'acme' }, /adminEmail/],
    [{ slug: 'acme', adminEmail: 'a@acme.io', plan: 'platinum' }, /plan must be one of/],
    [{ slug: 'acme', adminEmail: 'a@acme.io', timezone: 'Mars/Olympus' }, /not a valid IANA zone/],
  ])('bad input is a 400 and nothing is provisioned (%#)', async (body, msg) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(msg)
    expect(onboardTenant).not.toHaveBeenCalled()
  })
})

describe('POST /platform/tenants — provisioning', () => {
  it('builds the spec with defaults and returns the temporary password once', async () => {
    onboardTenant.mockImplementation(async (_kc, _spec, _pw, cb: { onStep: (l: string) => void; onPassword: () => void }) => {
      cb.onPassword()
      cb.onStep('realm created')
      return { steps: ['realm created'] }
    })
    const res = await post({ slug: 'acme', adminEmail: ' Admin@ACME.io ' })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({ slug: 'acme', temporaryPassword: 'Temp-Pw-1', steps: ['realm created'] })

    const [, spec, password] = onboardTenant.mock.calls[0]!
    expect(spec).toEqual({
      slug: 'acme', tenantName: 'acme', plan: 'starter', timezone: 'UTC',
      email: 'admin@acme.io', firstName: 'Admin', lastName: 'acme', adminRole: 'admin',
      domain: 'opengrafo.com', production: false, piIp: undefined,
    })
    // The password Keycloak receives must be temporary: changed at first login.
    expect(password).toEqual({ value: 'Temp-Pw-1', temporary: true })
  })

  it('explicit fields win over the defaults, and production must be literally true', async () => {
    onboardTenant.mockResolvedValue({ steps: [] })
    await post({
      slug: 'acme', adminEmail: 'a@acme.io', name: 'ACME Corp', plan: 'enterprise', timezone: 'Europe/Rome',
      adminFirstName: 'Ada', adminLastName: 'Lovelace', domain: 'acme.example', production: 'yes',
    })
    expect(onboardTenant.mock.calls[0]![1]).toMatchObject({
      tenantName: 'ACME Corp', plan: 'enterprise', timezone: 'Europe/Rome',
      firstName: 'Ada', lastName: 'Lovelace', domain: 'acme.example', production: false,
    })
  })

  it('a collapse AFTER the password was set still hands the password over, marked partial', async () => {
    onboardTenant.mockImplementation(async (_kc, _spec, _pw, cb: { onPassword: () => void }) => {
      cb.onPassword()
      throw new Error('workflow seeding failed')
    })
    const res = await post({ slug: 'acme', adminEmail: 'a@acme.io' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'workflow seeding failed', slug: 'acme', temporaryPassword: 'Temp-Pw-1', partial: true })
  })

  it('a collapse BEFORE the password was set carries no password (there is none to deliver)', async () => {
    onboardTenant.mockRejectedValue('realm exists')
    const res = await post({ slug: 'acme', adminEmail: 'a@acme.io' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'realm exists', slug: 'acme' })
  })

  it('without the platform actor the route fails instead of acting anonymously', async () => {
    const res = await post({ slug: 'acme', adminEmail: 'a@acme.io' }, { 'x-test-no-actor': '1' })
    expect(res.status).toBe(500)
    expect(onboardTenant).not.toHaveBeenCalled()
  })
})

describe('the Keycloak side of reset and delete', () => {
  it('password reset sets a TEMPORARY password on the user found in the tenant realm', async () => {
    lifecycle.resetAdminPassword.mockImplementation(async (_s, slug: string, email: string, gen: () => string,
      apply: (realm: string, email: string, pw: string) => Promise<void>) => {
      const pw = gen()
      await apply(slug, email, pw)
      return { email, temporaryPassword: pw }
    })
    const res = await fetch(`${base}/acme/admin-password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@acme.io' }),
    })
    expect(res.status).toBe(200)
    expect(findUserIdByEmail).toHaveBeenCalledWith(kc, 'tok', 'acme', 'admin@acme.io')
    expect(kc.setPassword).toHaveBeenCalledWith('tok', 'acme', 'kc-user-1', 'Temp-Pw-1', true)
  })

  it('permanent deletion deletes exactly the realm the lifecycle names', async () => {
    lifecycle.purgeTenant.mockImplementation(async (_s, slug: string, _confirm: string, deleteRealm: (r: string) => Promise<void>) => {
      await deleteRealm(slug)
      return { nodes: 10, realmDeleted: true }
    })
    const res = await fetch(`${base}/acme`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'acme' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slug: 'acme', nodes: 10, realmDeleted: true })
    expect(kc.delete).toHaveBeenCalledWith('tok', '/admin/realms/acme')
    expect(lifecycle.purgeTenant.mock.calls[0]![2]).toBe('acme')
  })
})
