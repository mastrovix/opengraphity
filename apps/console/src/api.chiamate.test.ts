/**
 * THE CONSOLE'S CALLS. REST, not GraphQL: the product's schema is tied to a
 * tenant and the console has none.
 *
 * Two rules hold every call up, and both come from things that went wrong
 * while using this page:
 *
 *  - the token is refreshed BEFORE each call if it has less than thirty
 *    seconds left. The background loop is not enough: a click landing in the
 *    seconds between expiry and the next cycle came back "Unauthorized", and
 *    on a page that creates and deletes tenants an authorization error looks
 *    like a permissions problem rather than an old token.
 *  - the error body has two shapes, and reading only one of them put
 *    "[object Object]" on the screen — which is not a message, it is an error
 *    inside the error path, i.e. the place you reach when something has
 *    already gone wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const stato = vi.hoisted(() => ({ token: 'tok' as string | undefined, refreshFails: null as unknown }))
const refreshToken = vi.hoisted(() => vi.fn(async (_s?: number) => 'tok'))

vi.mock('./keycloak', () => ({ keycloak: { get token() { return stato.token } } }))
vi.mock('./tokenRefresh', () => ({ refreshToken: (s?: number) => refreshToken(s) }))

const { api } = await import('./api')

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.stubGlobal('fetch', fetchMock)

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body }) as Response
const ko = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as Response

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!

beforeEach(() => {
  stato.token = 'tok'
  refreshToken.mockReset()
  refreshToken.mockResolvedValue('tok')
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(ok({ tenants: [] }))
})

describe('every call refreshes the token first', () => {
  it('asks for a refresh with a thirty-second margin, before fetching', async () => {
    await api.tenants()
    expect(refreshToken).toHaveBeenCalledWith(30)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('a failed refresh stops the call and says the session could not be refreshed', async () => {
    // Without this the rejected refresh reached the page as a bare object.
    refreshToken.mockRejectedValueOnce({ error: 'invalid_grant', error_description: 'Session not active' })
    await expect(api.tenants()).rejects.toThrow('Could not refresh the session: Session not active')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the original cause travels with it', async () => {
    const causa = new Error('network down')
    refreshToken.mockRejectedValueOnce(causa)
    const err = await api.tenants().then(() => null, (e: Error) => e)
    expect((err as { cause?: unknown }).cause).toBe(causa)
  })

  it('the bearer is sent on every call, and an empty one when there is no token', async () => {
    await api.tenants()
    expect((lastCall()[1]!.headers as Record<string, string>)['authorization']).toBe('Bearer tok')
    stato.token = undefined
    await api.tenants()
    expect((lastCall()[1]!.headers as Record<string, string>)['authorization']).toBe('Bearer ')
  })
})

describe('the routes', () => {
  it('creating a tenant POSTs the whole form', async () => {
    const nuovo = {
      slug: 'acme', name: 'Acme', plan: 'pro', timezone: 'Europe/Rome',
      adminEmail: 'a@acme.example', adminFirstName: 'Anna', adminLastName: 'Rossi',
    }
    await api.create(nuovo)
    const [url, init] = lastCall()
    expect(url).toBe('/platform/tenants')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual(nuovo)
  })

  it('listing tenants is a plain GET', async () => {
    await api.tenants()
    expect(lastCall()[0]).toBe('/platform/tenants')
    expect(lastCall()[1]!.method).toBeUndefined()
  })

  it.each([
    ['rename',  () => api.rename('acme', 'Acme S.p.A.'), 'PATCH', { action: 'rename', name: 'Acme S.p.A.' }],
    ['suspend', () => api.suspend('acme'),               'PATCH', { action: 'suspend' }],
    ['resume',  () => api.resume('acme'),                'PATCH', { action: 'resume' }],
  ])('%s PATCHes the tenant with its action', async (_name, call, method, body) => {
    await call()
    const [url, init] = lastCall()
    expect(url).toBe('/platform/tenants/acme')
    expect(init!.method).toBe(method)
    expect(JSON.parse(init!.body as string)).toEqual(body)
  })

  it('resetting a password is a POST on a route of its own', async () => {
    // Nothing about a new password is idempotent, and the answer carries a
    // secret: its own route makes it obvious which response must not be
    // logged or cached.
    await api.resetPassword('acme', 'a@acme.example')
    const [url, init] = lastCall()
    expect(url).toBe('/platform/tenants/acme/admin-password')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ email: 'a@acme.example' })
  })

  it('purging carries the typed confirmation in the body', async () => {
    await api.purge('acme', 'acme')
    const [url, init] = lastCall()
    expect(url).toBe('/platform/tenants/acme')
    expect(init!.method).toBe('DELETE')
    expect(JSON.parse(init!.body as string)).toEqual({ confirm: 'acme' })
  })

  it('the footprint is read per tenant', async () => {
    await api.footprint('acme')
    expect(lastCall()[0]).toBe('/platform/tenants/acme/footprint')
  })

  it('a slug needing escaping is encoded, never interpolated raw', async () => {
    // A slug is typed by whoever creates the tenant: unencoded it could walk
    // out of its own route.
    await api.footprint('a/../../platform/tenants')
    expect(lastCall()[0]).toBe('/platform/tenants/a%2F..%2F..%2Fplatform%2Ftenants/footprint')
    await api.suspend('con spazio')
    expect(lastCall()[0]).toBe('/platform/tenants/con%20spazio')
  })

  it('the answer comes back parsed', async () => {
    fetchMock.mockResolvedValueOnce(ok({ tenants: [{ slug: 'acme', stato: 'active' }] }))
    expect(await api.tenants()).toEqual({ tenants: [{ slug: 'acme', stato: 'active' }] })
  })

  // The queues (23 Sep 2026): the platform's are retried here, a tenant's only in its own console.
  it('the queues are a GET; the failed jobs are read per queue; a retry is a POST on the job, names encoded', async () => {
    await api.queues()
    expect(lastCall()[0]).toBe('/platform/queues')
    expect(lastCall()[1]!.method).toBeUndefined()
    await api.failedJobs('maintenance')
    expect(lastCall()[0]).toBe('/platform/queues/maintenance/jobs')
    await api.retryJob('maintenance', 'repeat:a/b')
    expect(lastCall()[0]).toBe('/platform/queues/maintenance/jobs/repeat%3Aa%2Fb/retry')
    expect(lastCall()[1]!.method).toBe('POST')
  })
})

describe('the two shapes of an error body', () => {
  it('the API\'s own handler answers { error: { code, message } }', async () => {
    fetchMock.mockResolvedValueOnce(ko(409, { error: { code: 'SLUG_TAKEN', message: 'That slug is already in use' } }))
    await expect(api.tenants()).rejects.toThrow('That slug is already in use')
  })

  it('the console routes answer { error: "…" } for the refusals they write themselves', async () => {
    fetchMock.mockResolvedValueOnce(ko(400, { error: 'Unknown action' }))
    await expect(api.tenants()).rejects.toThrow('Unknown action')
  })

  it('a code with no message becomes "HTTP <status> (CODE)": better than a bare status', async () => {
    fetchMock.mockResolvedValueOnce(ko(403, { error: { code: 'FORBIDDEN' } }))
    await expect(api.tenants()).rejects.toThrow('HTTP 403 (FORBIDDEN)')
  })

  it('a plain { message } is read too', async () => {
    fetchMock.mockResolvedValueOnce(ko(500, { message: 'Something broke' }))
    await expect(api.tenants()).rejects.toThrow('Something broke')
  })

  it('a body that is not JSON leaves the status: an nginx page has no message', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('not json') } } as unknown as Response)
    await expect(api.tenants()).rejects.toThrow('HTTP 502')
  })

  it.each([
    ['null',            null],
    ['a string',        'nope'],
    ['an empty object', {}],
    ['an empty error',  { error: '' }],
    ['an empty message', { message: '' }],
  ])('a body that is %s falls back to the status, never to "[object Object]"', async (_what, body) => {
    fetchMock.mockResolvedValueOnce(ko(500, body))
    const err = await api.tenants().then(() => null, (e: Error) => e)
    expect(err?.message).toBe('HTTP 500')
    expect(err?.message).not.toContain('object Object')
  })
})
