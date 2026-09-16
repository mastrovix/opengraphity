/**
 * Revisione totale del 16 set 2026 · A-2/A-3/M-6: una persona nuova con un'e-mail
 * già usata non tocca l'account esistente; l'e-mail si scrive minuscola; la
 * disattivazione spegne l'account nel realm e chiude le sessioni.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({ config: { keycloakUrl: 'http://kc', keycloakAdminUser: 'admin', keycloakAdminPassword: 'x' } }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { normalizeEmail, createRealmUser, setRealmUserEnabled, setUsersKeycloakAdminForTests } = await import('../tenantUsers.js')

function fakeKc(over: Record<string, unknown> = {}) {
  const kc = {
    baseUrl: 'http://kc',
    getAdminToken: vi.fn(async () => 'tok'),
    get: vi.fn(async () => [{ id: 'kc-1', email: 'mario@acme.it' }]),
    exists: vi.fn(),
    post: vi.fn(async () => ({ id: 'kc-new', created: true })),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    ...over,
  }
  setUsersKeycloakAdminForTests(kc as never)
  return kc
}

beforeEach(() => setUsersKeycloakAdminForTests(null))

describe('normalizeEmail', () => {
  it('toglie gli spazi e porta in minuscolo', () => {
    expect(normalizeEmail('  Mario.Rossi@Acme.COM ')).toBe('mario.rossi@acme.com')
  })
  it.each(['', 'mario', 'mario@acme', '@acme.it', 42])('%j non è un indirizzo', (v) => {
    expect(() => normalizeEmail(v)).toThrow(/not an e-mail/)
  })
})

describe('createRealmUser', () => {
  it('crea l\'account con la password nella stessa chiamata, senza reset successivi', async () => {
    const kc = fakeKc()
    await expect(createRealmUser('c-test', { email: 'mario@acme.it', name: 'Mario Rossi', password: 'Secret-1' })).resolves.toBe('kc-new')
    const [, path, body] = kc.post.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect(path).toBe('/admin/realms/c-test/users')
    expect(body).toMatchObject({ username: 'mario@acme.it', firstName: 'Mario', lastName: 'Rossi', credentials: [{ type: 'password', temporary: false }] })
    expect(kc.setPassword).not.toHaveBeenCalled()
    expect(kc.put).not.toHaveBeenCalled()
  })

  it('A-2: un 409 (e-mail già nel realm) è un errore e l\'account esistente non si tocca', async () => {
    const kc = fakeKc({ post: vi.fn(async () => ({ created: false })) })
    await expect(createRealmUser('c-test', { email: 'mario@acme.it', name: 'Mario', password: 'x' })).rejects.toThrow(/already exists: nothing was changed/)
    expect(kc.put).not.toHaveBeenCalled()
    expect(kc.setPassword).not.toHaveBeenCalled()
  })

  it('un rifiuto della policy delle password arriva con il motivo di Keycloak', async () => {
    fakeKc({ post: vi.fn(async () => { throw new Error('POST /admin/realms/c-test/users → 400: {"errorMessage":"invalidPasswordMinLengthMessage"}') }) })
    await expect(createRealmUser('c-test', { email: 'a@b.it', name: 'A', password: 'x' })).rejects.toThrow(/invalidPasswordMinLengthMessage/)
  })
})

describe('setRealmUserEnabled', () => {
  it('M-6: disattivare spegne l\'account e chiude le sessioni', async () => {
    const kc = fakeKc()
    await expect(setRealmUserEnabled('c-test', 'mario@acme.it', false)).resolves.toBe('updated')
    expect(kc.put).toHaveBeenCalledWith('tok', '/admin/realms/c-test/users/kc-1', { enabled: false })
    expect(kc.post).toHaveBeenCalledWith('tok', '/admin/realms/c-test/users/kc-1/logout', {})
  })
  it('riattivare accende l\'account senza logout', async () => {
    const kc = fakeKc()
    await setRealmUserEnabled('c-test', 'mario@acme.it', true)
    expect(kc.put).toHaveBeenCalledWith('tok', '/admin/realms/c-test/users/kc-1', { enabled: true })
    expect(kc.post).not.toHaveBeenCalled()
  })
  it('senza account nel realm: si dice «missing» in entrambe le direzioni, senza inventare un account', async () => {
    const kc = fakeKc({ get: vi.fn(async () => []) })
    await expect(setRealmUserEnabled('c-test', 'x@acme.it', false)).resolves.toBe('missing')
    await expect(setRealmUserEnabled('c-test', 'x@acme.it', true)).resolves.toBe('missing')
    expect(kc.put).not.toHaveBeenCalled()
  })
})
