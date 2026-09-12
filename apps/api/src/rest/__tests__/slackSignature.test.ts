/**
 * Slack request verification (commands + actions): valid HMAC, wrong/missing
 * signature, timestamp outside the ±5 min replay window, missing signing
 * secret → 401. Plus the command surface not covered by slackCommands.test.ts:
 * unknown command usage, missing title, unlinked Slack user, ambiguous CI, and
 * the interactive actions (assign_me / resolve / escalate) with response_url.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))
import { createHmac } from 'node:crypto'
import type { Request, Response } from 'express'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn(), resolveIncident: vi.fn(), escalateIncident: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { getSession } = await import('@opengraphity/neo4j')
const { createIncident, resolveIncident, escalateIncident } = await import('../../services/incidentService.js')
const { logger } = await import('../../lib/logger.js')
const { resetConfigCache } = await import('../../lib/config.js')
const { handleSlackCommands, handleSlackActions } = await import('../slack.js')

const SECRET = 'test-signing-secret'
const NOW_MS = Date.parse('2026-09-08T10:00:00.000Z')
const nowSec = () => Math.floor(NOW_MS / 1000)

function sign(body: string, ts: number, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
}

function slackReq(params: Record<string, string>, opts: { ts?: number; sig?: string | null; tsHeader?: string | null } = {}): Request {
  const body = new URLSearchParams(params).toString()
  const ts   = opts.ts ?? nowSec()
  const headers: Record<string, string> = {}
  if (opts.tsHeader !== null) headers['x-slack-request-timestamp'] = opts.tsHeader ?? String(ts)
  if (opts.sig !== null) headers['x-slack-signature'] = opts.sig ?? sign(body, ts)
  return { body: Buffer.from(body), headers } as unknown as Request
}

function fakeRes() {
  const res = { body: undefined as unknown, statusCode: 200, sent: undefined as number | undefined, headersSent: false } as {
    body: unknown; statusCode: number; sent: number | undefined; headersSent: boolean
    json: (b: unknown) => void; status: (n: number) => typeof res; sendStatus: (n: number) => void
  }
  res.json       = (b: unknown) => { res.body = b; res.headersSent = true }
  res.status     = (n: number) => { res.statusCode = n; return res }
  res.sendStatus = (n: number) => { res.sent = n; res.statusCode = n; res.headersSent = true }
  return res
}
const asRes = (r: ReturnType<typeof fakeRes>) => r as unknown as Response

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => map[k] })
const userRow = rec({ u: { properties: { id: 'user-1', tenant_id: 'tenant-1' } } })

function sessionWith(reads: unknown[][]) {
  let i = 0
  const writes: Array<{ q: string; p: Record<string, unknown> }> = []
  return {
    writes,
    session: {
      executeRead:  vi.fn().mockImplementation(() => Promise.resolve({ records: reads[i++] ?? [] })),
      executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ run: (q: string, p: Record<string, unknown>) => { writes.push({ q, p }); return Promise.resolve({ records: [] }) } })),
      close: vi.fn().mockResolvedValue(undefined),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW_MS })
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
  resetConfigCache()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetConfigCache()
})

const CMD = { text: 'incident apri Sito giù ci=web-01 high', user_id: 'U123' }

describe('verifySlackSignature (via /og commands)', () => {
  it('valid signature at the current time passes verification', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq({ text: 'help', user_id: 'U1' }), asRes(res))
    expect(res.statusCode).toBe(200)
    expect((res.body as { text: string }).text).toMatch(/Comando non riconosciuto/)
  })

  it('timestamp older than 5 minutes → 401 even with a correct HMAC for that timestamp', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { ts: nowSec() - 301 }), asRes(res))
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('timestamp 5 minutes in the future → 401', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { ts: nowSec() + 301 }), asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('timestamp exactly at the 300 s edge is still accepted', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq({ text: 'help', user_id: 'U1' }, { ts: nowSec() - 300 }), asRes(res))
    expect(res.statusCode).toBe(200)
  })

  it('missing signature header → 401', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { sig: null }), asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('missing timestamp header → 401', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { tsHeader: null }), asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('signature computed with another secret → 401', async () => {
    const body = new URLSearchParams(CMD).toString()
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { sig: sign(body, nowSec(), 'other-secret') }), asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('signature of a different length (no timingSafeEqual throw leak) → 401', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD, { sig: 'v0=short' }), asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('body tampered after signing → 401', async () => {
    const req = slackReq(CMD)
    req.body = Buffer.from(new URLSearchParams({ ...CMD, text: 'incident apri Altro ci=web-01 high' }).toString())
    const res = fakeRes()
    await handleSlackCommands(req, asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('SLACK_SIGNING_SECRET not configured → 401 and an error log (never a silent pass)', async () => {
    vi.stubEnv('SLACK_SIGNING_SECRET', '')
    resetConfigCache()
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD), asRes(res))
    expect(res.statusCode).toBe(401)
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/SLACK_SIGNING_SECRET not configured/))
  })
})

describe('/og commands — remaining branches', () => {
  it('unknown command → ephemeral usage', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq({ text: 'problem apri x', user_id: 'U1' }), asRes(res))
    expect(res.body).toMatchObject({ response_type: 'ephemeral' })
    expect((res.body as { text: string }).text).toMatch(/Comando non riconosciuto.*\/og incident apri/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('missing title → usage, nothing created', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackReq({ text: 'incident apri ci=web-01 high', user_id: 'U1' }), asRes(res))
    expect((res.body as { text: string }).text).toMatch(/Titolo mancante/)
    expect(getSession).not.toHaveBeenCalled()
    expect(createIncident).not.toHaveBeenCalled()
  })

  it('Slack user not linked to a User → ephemeral hint, session closed', async () => {
    const { session } = sessionWith([[]])
    vi.mocked(getSession).mockReturnValue(session as never)
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD), asRes(res))
    expect((res.body as { text: string }).text).toMatch(/Collega il tuo account Slack/)
    expect(createIncident).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('ambiguous CI name (2 matches) → asks for the id; CI lookup is tenant-scoped', async () => {
    const { session } = sessionWith([[userRow], [rec({ id: 'ci-a' }), rec({ id: 'ci-b' })]])
    vi.mocked(getSession).mockReturnValue(session as never)
    const res = fakeRes()
    await handleSlackCommands(slackReq(CMD), asRes(res))
    expect((res.body as { text: string }).text).toMatch(/ambiguo/)
    expect(createIncident).not.toHaveBeenCalled()
    const ciCall = session.executeRead.mock.calls[1]![0] as (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown
    const captured: Array<{ q: string; p: Record<string, unknown> }> = []
    ciCall({ run: (q, p) => { captured.push({ q, p }); return Promise.resolve({ records: [] }) } })
    expect(captured[0]!.q).toMatch(/tenant_id: \$tenantId/)
    expect(captured[0]!.p).toEqual({ tenantId: 'tenant-1', ref: 'web-01' })
  })

  it('non-input error from the service propagates (not swallowed into an ephemeral)', async () => {
    const { session } = sessionWith([[userRow], [rec({ id: 'ci-web' })]])
    vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(createIncident).mockRejectedValueOnce(new Error('bolt down'))
    await expect(handleSlackCommands(slackReq(CMD), asRes(fakeRes()))).rejects.toThrow('bolt down')
  })
})

describe('handleSlackActions', () => {
  const actionReq = (value: unknown, extra: { user?: { id: string }; response_url?: string } = { user: { id: 'U123' } }) =>
    slackReq({ payload: JSON.stringify({ actions: [{ action_id: 'a', value: JSON.stringify(value) }], ...extra }) })

  it('bad signature → 401, no DB access', async () => {
    const req = actionReq({ action: 'resolve', incidentId: 'inc-1' })
    ;(req.headers as Record<string, string>)['x-slack-signature'] = 'v0=deadbeef'
    const res = fakeRes()
    await handleSlackActions(req, asRes(res))
    expect(res.statusCode).toBe(401)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('expired timestamp → 401', async () => {
    const body = new URLSearchParams({ payload: '{}' }).toString()
    const ts = nowSec() - 600
    const req = { body: Buffer.from(body), headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sign(body, ts) } } as unknown as Request
    const res = fakeRes()
    await handleSlackActions(req, asRes(res))
    expect(res.statusCode).toBe(401)
  })

  it('payload without actions/user → 200 and no DB access', async () => {
    const res = fakeRes()
    await handleSlackActions(slackReq({ payload: '{}' }), asRes(res))
    expect(res.sent).toBe(200)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('assign_me → tenant-scoped SET assignee_id, confirmation posted to response_url', async () => {
    const { session, writes } = sessionWith([[userRow]])
    vi.mocked(getSession).mockReturnValue(session as never)
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)

    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'assign_me', incidentId: 'inc-1' }, { user: { id: 'U123' }, response_url: 'https://hooks.slack.test/r' }), asRes(res))

    expect(res.sent).toBe(200)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.q).toMatch(/Incident \{id: \$incidentId, tenant_id: \$tenantId\}/)
    expect(writes[0]!.p).toMatchObject({ incidentId: 'inc-1', tenantId: 'tenant-1', userId: 'user-1' })
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.test/r', expect.objectContaining({ method: 'POST' }))
    const posted = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { text: string }
    expect(posted.text).toMatch(/assign_me/)
    expect(session.close).toHaveBeenCalled()
  })

  it('resolve / escalate delegate to incidentService with the user context', async () => {
    for (const [action, fn] of [['resolve', resolveIncident], ['escalate', escalateIncident]] as const) {
      vi.mocked(getSession).mockReturnValue(sessionWith([[userRow]]).session as never)
      const res = fakeRes()
      await handleSlackActions(actionReq({ action, incidentId: 'inc-9' }), asRes(res))
      expect(res.sent).toBe(200)
      expect(fn).toHaveBeenCalledWith('inc-9', { tenantId: 'tenant-1', userId: 'user-1' })
    }
  })

  it('unlinked Slack user → ephemeral hint via response_url, still 200', async () => {
    vi.mocked(getSession).mockReturnValue(sessionWith([[]]).session as never)
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetchMock)
    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'resolve', incidentId: 'inc-1' }, { user: { id: 'U404' }, response_url: 'https://hooks.slack.test/r' }), asRes(res))
    expect(res.sent).toBe(200)
    expect(resolveIncident).not.toHaveBeenCalled()
    const posted = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as { response_type: string; text: string }
    expect(posted).toMatchObject({ response_type: 'ephemeral' })
    expect(posted.text).toMatch(/Collega il tuo account Slack/)
  })

  it('service failure is logged and still acknowledged with 200 (Slack retries otherwise)', async () => {
    vi.mocked(getSession).mockReturnValue(sessionWith([[userRow]]).session as never)
    vi.mocked(resolveIncident).mockRejectedValueOnce(new Error('guard failed'))
    const res = fakeRes()
    await handleSlackActions(actionReq({ action: 'resolve', incidentId: 'inc-1' }), asRes(res))
    expect(res.sent).toBe(200)
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'slack actions error')
  })
})
