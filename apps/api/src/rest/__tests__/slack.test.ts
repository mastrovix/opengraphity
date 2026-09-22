/**
 * SLACK — the edges of the three public endpoints that the command and
 * signature suites do not reach.
 *
 * These routes are PUBLIC: anyone on the internet can POST to them. What keeps
 * a stranger out is the workspace (team id) and the HMAC of the installation's
 * own secret; what keeps a click from doing the wrong thing is that every user
 * lookup is scoped to the tenant of the workspace that signed the request.
 * Pinned here:
 * - a body that is not the raw bytes cannot be verified, so it fails closed;
 * - an unsigned or team-less request is a 401 before anything is read;
 * - an unknown action button is answered in plain words, never "done";
 * - Slack must always get its 200 (otherwise it retries the click), even when
 *   something breaks after the answer was sent;
 * - the OAuth return page redirects ONLY to an http(s) page of the tenant that
 *   signed the state: anything else would be an open redirect off a public URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import type { Request, Response } from 'express'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('@opengraphity/notifications', () => ({
  loadSlackInstallationByTeam: vi.fn(async (teamId: string) => (teamId === 'T1'
    ? { tenantId: 'tenant-1', teamId: 'T1', teamName: 'Acme', mode: 'token', signingSecret: SECRET }
    : null)),
}))
const svc = vi.hoisted(() => ({ createIncident: vi.fn(), resolveIncident: vi.fn(), escalateIncident: vi.fn(), assignIncidentToUser: vi.fn() }))
vi.mock('../../services/incidentService.js', () => svc)
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: log }))
vi.mock('../../lib/domainMatrix.js', () => ({ domainVocabulary: vi.fn(async () => ['high', 'low']) }))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: vi.fn(async () => '(ci:Server)') }))
const oauth = vi.hoisted(() => ({ verifyInstallState: vi.fn(), completeSlackOAuth: vi.fn() }))
vi.mock('../../lib/slackConnect.js', () => oauth)
// Faithful enough for these tests: the tenant is the first DNS label of the host.
vi.mock('../../auth/resolveAuth.js', () => ({ extractTenantFromHost: (host: string) => host.split(':')[0]!.split('.')[0] ?? null }))
const audit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const SECRET = 'workspace-secret'
const { getSession } = await import('@opengraphity/neo4j')
const { verifySlackSignature, handleSlackCommands, handleSlackActions, handleSlackOAuthCallback } = await import('../slack.js')

function signed(params: Record<string, string>, secret = SECRET): Request {
  const body = new URLSearchParams(params).toString()
  const ts = String(Math.floor(Date.now() / 1000))
  const sig = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
  return { body: Buffer.from(body), headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, query: {} } as unknown as Request
}

function fakeRes() {
  const res = {
    body: undefined as unknown, statusCode: 200, sent: undefined as number | undefined, headersSent: false,
    redirectedTo: undefined as string | undefined, contentType: undefined as string | undefined,
  } as {
    body: unknown; statusCode: number; sent: number | undefined; headersSent: boolean; redirectedTo: string | undefined; contentType: string | undefined
    json: (b: unknown) => void; status: (n: number) => typeof res; sendStatus: (n: number) => void
    type: (t: string) => typeof res; send: (b: unknown) => void; redirect: (code: number, url: string) => void
  }
  res.json = (b) => { res.body = b; res.headersSent = true }
  res.status = (n) => { res.statusCode = n; return res }
  res.sendStatus = (n) => { res.sent = n; res.statusCode = n; res.headersSent = true }
  res.type = (t) => { res.contentType = t; return res }
  res.send = (b) => { res.body = b; res.headersSent = true }
  res.redirect = (code, url) => { res.statusCode = code; res.redirectedTo = url; res.headersSent = true }
  return res
}
const asRes = (r: ReturnType<typeof fakeRes>) => r as unknown as Response

const userRow = { get: (k: string) => (k === 'u' ? { properties: { id: 'user-1' } } : null) }
function sessionReturning(userRecords: unknown[], closeImpl?: () => Promise<void>) {
  const runs: Array<{ q: string; p: Record<string, unknown> }> = []
  const session = {
    executeRead: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      run: async (q: string, p: Record<string, unknown>) => { runs.push({ q, p }); return { records: userRecords } },
    })),
    executeWrite: vi.fn(),
    close: vi.fn(closeImpl ?? (async () => undefined)),
  }
  vi.mocked(getSession).mockReturnValue(session as never)
  return { session, runs }
}

const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockResolvedValue(new Response('ok'))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('verifySlackSignature', () => {
  it('a body that is not the raw bytes (already parsed) cannot be verified: it fails closed', () => {
    const body = 'team_id=T1&text=hi'
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
    const req = { body, headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig } } as unknown as Request
    expect(verifySlackSignature(req, SECRET)).toBe(false)
  })
})

describe('handleSlackCommands — edges', () => {
  it('a parsed (non-raw) body carries no team: 401 and no database access', async () => {
    const res = fakeRes()
    await handleSlackCommands({ body: { team_id: 'T1' }, headers: {} } as unknown as Request, asRes(res))
    expect(res.statusCode).toBe(401)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a signed request with no text gets the usage, not an error', async () => {
    const res = fakeRes()
    await handleSlackCommands(signed({ team_id: 'T1' }), asRes(res))
    expect(res.body).toMatchObject({ response_type: 'ephemeral' })
    expect(String((res.body as { text: string }).text)).toContain('Command not recognised')
  })

  it('"incident open" with nothing after it asks for the CI (no severity is invented)', async () => {
    const res = fakeRes()
    await handleSlackCommands(signed({ team_id: 'T1', text: 'incident open' }), asRes(res))
    expect(String((res.body as { text: string }).text)).toContain('Impacted CI missing')
    expect(svc.createIncident).not.toHaveBeenCalled()
  })

  it('without a user_id the lookup is for the empty Slack id in the workspace tenant, and finds no one', async () => {
    const { runs, session } = sessionReturning([])
    const res = fakeRes()
    await handleSlackCommands(signed({ team_id: 'T1', text: 'incident open Down ci=web high' }), asRes(res))
    expect(runs[0]!.p).toEqual({ slackUserId: '', tenantId: 'tenant-1' })
    expect(String((res.body as { text: string }).text)).toContain('Link your Slack account')
    expect(session.close).toHaveBeenCalled()
  })
})

describe('handleSlackActions — edges', () => {
  const actionReq = (value: unknown, extra: Record<string, unknown> = {}) => signed({
    payload: JSON.stringify({ team: { id: 'T1' }, user: { id: 'U1' }, actions: [{ action_id: 'a', value: value === undefined ? undefined : JSON.stringify(value) }], ...extra }),
  })
  const posted = () => JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { text: string }

  it('no payload at all is a 401: there is no workspace to verify against', async () => {
    const res = fakeRes()
    await handleSlackActions(signed({}), asRes(res))
    expect(res.statusCode).toBe(401)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('an unknown button is answered in plain words, never with "done", and nothing is called', async () => {
    const { runs } = sessionReturning([userRow])
    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'delete_everything', incidentId: 'inc-1' }, { response_url: 'https://hooks.slack.test/r' }), asRes(res))
    // The user is looked up in the tenant of the signing workspace.
    expect(runs[0]!.p).toEqual({ slackUserId: 'U1', tenantId: 'tenant-1' })
    expect(posted().text).toContain('is not one this app performs')
    expect(svc.resolveIncident).not.toHaveBeenCalled()
    expect(res.sent).toBe(200)
  })

  it('a button without a value is treated as an unknown action, not a crash', async () => {
    sessionReturning([userRow])
    const res = fakeRes()
    await handleSlackActions(actionReq(undefined, { response_url: 'https://hooks.slack.test/r' }), asRes(res))
    expect(posted().text).toContain('is not one this app performs')
    expect(res.sent).toBe(200)
  })

  it('a refusal that is not an Error still reaches the user as text', async () => {
    sessionReturning([userRow])
    svc.escalateIncident.mockRejectedValueOnce('no escalation team')
    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'escalate', incidentId: 'inc-1' }, { response_url: 'https://hooks.slack.test/r' }), asRes(res))
    expect(posted().text).toBe('⚠️ no escalation team')
  })

  it('an unlinked user without a response_url: nothing is posted, Slack still gets 200', async () => {
    sessionReturning([])
    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'resolve', incidentId: 'inc-1' }), asRes(res))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.sent).toBe(200)
  })

  it('a malformed payload is logged and still acknowledged with 200', async () => {
    const res = fakeRes()
    await handleSlackActions(signed({ payload: '{not json' }), asRes(res))
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(res.sent).toBe(200)
  })

  it('a failure after the 200 was sent is logged without trying to answer twice', async () => {
    sessionReturning([], async () => { throw new Error('close failed') })
    const res = fakeRes()
    const sendStatus = vi.spyOn(res, 'sendStatus')
    await handleSlackActions(actionReq({ action: 'resolve', incidentId: 'inc-1' }), asRes(res))
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(sendStatus).toHaveBeenCalledTimes(1)
  })
})

describe('handleSlackOAuthCallback', () => {
  const state = (r: string, t = 'acme') => ({ t, u: 'user-1', name: 'admin@acme', r, exp: 0, n: 'x' })
  const cb = async (query: Record<string, unknown>) => {
    const res = fakeRes()
    await handleSlackOAuthCallback({ query } as unknown as Request, asRes(res))
    return res
  }

  it('an unreadable or expired state is a 400 with no redirect', async () => {
    oauth.verifyInstallState.mockImplementation(() => { throw new Error('bad state') })
    const res = await cb({ code: 'c', state: 's' })
    expect(res.statusCode).toBe(400)
    expect(res.contentType).toBe('text/plain')
    expect(res.redirectedTo).toBeUndefined()
    expect(oauth.completeSlackOAuth).not.toHaveBeenCalled()
  })

  it('a return page of ANOTHER tenant is refused (no open redirect)', async () => {
    oauth.verifyInstallState.mockReturnValue(state('https://evil.example.com/integrations'))
    const res = await cb({ code: 'c', state: 's' })
    expect(res.statusCode).toBe(400)
    expect(res.redirectedTo).toBeUndefined()
  })

  it('a non-http(s) return page is refused even on the right tenant', async () => {
    oauth.verifyInstallState.mockReturnValue(state('ftp://acme.example.com/x'))
    expect((await cb({ code: 'c', state: 's' })).statusCode).toBe(400)
  })

  it('non-string query values are ignored (treated as missing)', async () => {
    oauth.verifyInstallState.mockImplementation(() => { throw new Error('empty state') })
    const res = await cb({ code: ['a', 'b'], state: ['s'], error: ['x'] })
    expect(oauth.verifyInstallState).toHaveBeenCalledWith('')
    expect(res.statusCode).toBe(400)
  })

  it('the admin said no on Slack: back to the page with the reason', async () => {
    oauth.verifyInstallState.mockReturnValue(state('https://acme.example.com/settings/integrations'))
    const res = await cb({ state: 's', error: 'access_denied' })
    expect(res.statusCode).toBe(302)
    const url = new URL(res.redirectedTo!)
    expect(url.searchParams.get('slack')).toBe('error')
    expect(url.searchParams.get('reason')).toBe('access_denied')
    expect(oauth.completeSlackOAuth).not.toHaveBeenCalled()
  })

  it('no code and no error: back with reason no_code', async () => {
    oauth.verifyInstallState.mockReturnValue(state('https://acme.example.com/i'))
    const res = await cb({ state: 's' })
    expect(new URL(res.redirectedTo!).searchParams.get('reason')).toBe('no_code')
  })

  it('success: completes the installation, audits it for the tenant of the state, and says connected', async () => {
    oauth.verifyInstallState.mockReturnValue(state('https://acme.example.com/i?tab=slack'))
    oauth.completeSlackOAuth.mockResolvedValue({ state: state('https://acme.example.com/i'), installation: { teamId: 'T9', teamName: 'Acme HQ' } })
    const res = await cb({ code: 'the-code', state: 'signed-state' })
    expect(oauth.completeSlackOAuth).toHaveBeenCalledWith('the-code', 'signed-state')
    const [actx, action, entity, entityId, details] = audit.mock.calls[0] as [Record<string, unknown>, string, string, string, unknown]
    expect(actx).toMatchObject({ tenantId: 'acme', userId: 'user-1', userEmail: 'admin@acme' })
    expect([action, entity, entityId, details]).toEqual(['slack.connected', 'SlackInstallation', 'T9', { mode: 'app', team: 'Acme HQ' }])
    const url = new URL(res.redirectedTo!)
    // The original query of the return page is kept.
    expect(url.searchParams.get('tab')).toBe('slack')
    expect(url.searchParams.get('slack')).toBe('connected')
  })

  it('a failed installation goes back with the i18n key of the error, or "failed"', async () => {
    oauth.verifyInstallState.mockReturnValue(state('https://acme.example.com/i'))
    oauth.completeSlackOAuth.mockRejectedValueOnce(Object.assign(new Error('x'), { extensions: { i18n: { key: 'errors.slack.oauthFailed' } } }))
    let res = await cb({ code: 'c', state: 's' })
    expect(new URL(res.redirectedTo!).searchParams.get('reason')).toBe('errors.slack.oauthFailed')

    oauth.completeSlackOAuth.mockRejectedValueOnce(new Error('network'))
    res = await cb({ code: 'c', state: 's' })
    expect(new URL(res.redirectedTo!).searchParams.get('reason')).toBe('failed')
    expect(log.error).toHaveBeenCalledTimes(2)
    expect(audit).not.toHaveBeenCalled()
  })
})
