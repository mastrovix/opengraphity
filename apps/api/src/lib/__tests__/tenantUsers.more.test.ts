/**
 * tenantUsers — the less common answers from Keycloak.
 *
 * Creating a person is two writes (realm, then graph). If the realm answer is
 * ambiguous we must NOT guess: a created account whose id we cannot find, or two
 * accounts with the same e-mail, would link the graph person to the wrong login.
 * Errors that are not a password-policy refusal must reach the caller untouched
 * (a 500 from Keycloak is not "invalid input"). And the compensation delete must
 * target exactly the account just created, in the tenant's realm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ValidationError } from '../errors.js'

const h = vi.hoisted(() => ({ created: [] as unknown[] }))
vi.mock('../config.js', () => ({ config: { keycloakUrl: 'http://kc//', keycloakAdminUser: 'admin', keycloakAdminPassword: 'x' } }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../../scripts/lib/keycloakAdmin.js', () => ({
  createKeycloakAdmin: vi.fn((opts: unknown) => {
    h.created.push(opts)
    return { getAdminToken: async () => 'real-tok', delete: vi.fn(async () => undefined) }
  }),
}))

const { createRealmUser, deleteRealmUser, setRealmUserEnabled, emailTakenError, setUsersKeycloakAdminForTests } = await import('../tenantUsers.js')

function fakeKc(over: Record<string, unknown> = {}) {
  const kc = {
    getAdminToken: vi.fn(async () => 'tok'),
    get: vi.fn(async () => [] as unknown[]),
    post: vi.fn(async () => ({ created: true })),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ...over,
  }
  setUsersKeycloakAdminForTests(kc as never)
  return kc
}

const INPUT = { email: 'anna@acme.it', name: 'Anna', password: 'Secret-1' }

beforeEach(() => { setUsersKeycloakAdminForTests(null); h.created.length = 0 })

describe('createRealmUser — ambiguous or unexpected answers', () => {
  it('created without an id in the answer: looks the account up by e-mail', async () => {
    const kc = fakeKc({ get: vi.fn(async () => [{ id: 'other', email: 'anna.b@acme.it' }, { id: 'kc-anna', email: 'Anna@Acme.it' }]) })
    await expect(createRealmUser('c-test', INPUT)).resolves.toBe('kc-anna')
    // A single-word name has no last name, not "undefined".
    expect(kc.post.mock.calls[0]![2]).toMatchObject({ firstName: 'Anna', lastName: '' })
    expect(kc.get.mock.calls[0]![1]).toBe('/admin/realms/c-test/users?email=anna%40acme.it&exact=true')
  })

  it('created but not findable: a loud error, never an unlinked person', async () => {
    fakeKc({ get: vi.fn(async () => []) })
    await expect(createRealmUser('c-test', INPUT)).rejects.toThrow('Keycloak created anna@acme.it in realm c-test but the account cannot be found')
  })

  it('two realm accounts with the same e-mail: refuses to pick one', async () => {
    fakeKc({ get: vi.fn(async () => [{ id: 'a', email: 'anna@acme.it' }, { id: 'b', email: 'anna@acme.it' }]) })
    await expect(createRealmUser('c-test', INPUT)).rejects.toThrow('Realm c-test has 2 accounts with e-mail anna@acme.it')
  })

  it('a 400 with a plain-text body keeps the text as the reason', async () => {
    fakeKc({ post: vi.fn(async () => { throw new Error('POST /users → 400: password too short') }) })
    const err = await createRealmUser('c-test', INPUT).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as Error).message).toBe('Keycloak refused the new account: password too short')
  })

  it('a 400 JSON without errorMessage keeps the raw body', async () => {
    fakeKc({ post: vi.fn(async () => { throw new Error('POST /users → 400: {"error":"x"}') }) })
    await expect(createRealmUser('c-test', INPUT)).rejects.toThrow('Keycloak refused the new account: {"error":"x"}')
  })

  it('any other failure is rethrown as it is, not dressed up as a validation error', async () => {
    const boom = new Error('POST /users → 500: internal')
    fakeKc({ post: vi.fn(async () => { throw boom }) })
    await expect(createRealmUser('c-test', INPUT)).rejects.toBe(boom)
  })

  it('a non-Error rejection is rethrown as well', async () => {
    fakeKc({ post: vi.fn(async () => { throw 'socket hang up' as unknown }) })
    await expect(createRealmUser('c-test', INPUT)).rejects.toBe('socket hang up')
  })
})

describe('deleteRealmUser (compensation)', () => {
  it('deletes exactly that account in the tenant realm, with path segments encoded', async () => {
    const kc = fakeKc()
    await deleteRealmUser('c test', 'id/1')
    expect(kc.delete).toHaveBeenCalledWith('tok', '/admin/realms/c%20test/users/id%2F1')
  })

  it('without a test client builds the real admin client from config, trailing slashes trimmed', async () => {
    await deleteRealmUser('c-test', 'kc-1')
    expect(h.created).toEqual([{ baseUrl: 'http://kc', adminUser: 'admin', adminPassword: 'x' }])
  })
})

describe('setRealmUserEnabled', () => {
  it('ignores realm accounts whose e-mail only looks similar', async () => {
    fakeKc({ get: vi.fn(async () => [{ id: 'x' }]) })
    // An account without e-mail never matches: the person is "missing", not someone else.
    await expect(setRealmUserEnabled('c-test', 'anna@acme.it', false)).resolves.toBe('missing')
  })
})

describe('emailTakenError', () => {
  it('carries the i18n key and the e-mail for the UI', () => {
    const e = emailTakenError('anna@acme.it')
    expect(e.message).toContain('anna@acme.it')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.user.emailExists', params: { email: 'anna@acme.it' } })
  })
})
