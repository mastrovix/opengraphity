/**
 * A-08 — `/og incident apri` creates the incident through
 * incidentService.createIncident (number, workflow instance, SLA, events),
 * never a bare CREATE (:Incident); the impacted CI is mandatory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { getSession } = await import('@opengraphity/neo4j')
const { createIncident } = await import('../../services/incidentService.js')
const { handleSlackCommands } = await import('../slack.js')

const SECRET = 'test-signing-secret'
process.env['SLACK_SIGNING_SECRET'] = SECRET

function slackRequest(text: string, userId = 'U123'): Request {
  const body = new URLSearchParams({ text, user_id: userId }).toString()
  const ts   = String(Math.floor(Date.now() / 1000))
  const sig  = 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
  return { body: Buffer.from(body), headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig } } as unknown as Request
}

function fakeRes() {
  const res = { body: undefined as unknown, statusCode: 200 } as { body: unknown; statusCode: number; json: (b: unknown) => void; status: (n: number) => typeof res }
  res.json   = (b: unknown) => { res.body = b }
  res.status = (n: number) => { res.statusCode = n; return res }
  return res
}

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => map[k] })
const userRow = rec({ u: { properties: { id: 'user-1', tenant_id: 'tenant-1' } } })

/** Cypher delle letture eseguite, per asserire i predicati (A-9). */
const reads: string[] = []

function sessionWith(rows: unknown[][]) {
  let i = 0
  const writes: Array<{ q: string; p: Record<string, unknown> }> = []
  return {
    writes,
    session: {
      executeRead:  vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const records = rows[i++] ?? []
        // il lettore esegue `tx.run(cypher, params)`: catturiamo il cypher
        await fn({ run: (q: string) => { reads.push(q); return Promise.resolve({ records }) } })
        return { records }
      }),
      executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
        fn({ run: (q: string, p: Record<string, unknown>) => { writes.push({ q, p }); return Promise.resolve({ records: [] }) } })),
      close: vi.fn().mockResolvedValue(undefined),
    },
  }
}

describe('/og incident apri', () => {
  beforeEach(() => { vi.clearAllMocks(); reads.length = 0 })

  it('creates via incidentService with the resolved CI, then marks created_by', async () => {
    const { session, writes } = sessionWith([[userRow], [rec({ id: 'ci-web' })]])
    vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(createIncident).mockResolvedValueOnce({ id: 'inc-1', number: 'INC00000042' } as never)

    const res = fakeRes()
    await handleSlackCommands(slackRequest('incident apri Sito giù ci=web-01 high'), res as unknown as Response)

    expect(createIncident).toHaveBeenCalledWith(
      { title: 'Sito giù', severity: 'high', affectedCIIds: ['ci-web'] },
      { tenantId: 'tenant-1', userId: 'user-1' },
    )
    // Only the reporter marker is written directly — no CREATE (:Incident)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.q).toMatch(/SET i\.created_by = \$userId/)
    expect(writes[0]!.q).not.toMatch(/CREATE/)
    expect(writes[0]!.p).toMatchObject({ id: 'inc-1', tenantId: 'tenant-1', userId: 'user-1' })
    expect((res.body as { response_type: string; text: string }).response_type).toBe('in_channel')
    expect((res.body as { text: string }).text).toContain('INC00000042')
    // A-9: la risoluzione del CI usa le etichette del metamodello del tenant —
    // con la lista fissa un CI di un tipo del cliente dava «CI non trovato».
    expect(reads.find((q) => q.includes('MATCH (ci {tenant_id: $tenantId})'))).toContain('ci:LoadBalancer')
  })

  it('missing ci= → usage, nothing created', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackRequest('incident apri Sito giù high'), res as unknown as Response)
    expect(createIncident).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
    expect((res.body as { text: string }).text).toMatch(/CI impattato mancante/)
  })

  it('invalid severity → usage, nothing created', async () => {
    const res = fakeRes()
    await handleSlackCommands(slackRequest('incident apri Sito giù ci=web-01 urgent'), res as unknown as Response)
    expect(createIncident).not.toHaveBeenCalled()
    expect((res.body as { text: string }).text).toMatch(/Severity mancante o non valida/)
  })

  it('unknown CI → ephemeral error, nothing created', async () => {
    const { session } = sessionWith([[userRow], []])
    vi.mocked(getSession).mockReturnValue(session as never)
    const res = fakeRes()
    await handleSlackCommands(slackRequest('incident apri Sito giù ci=ghost high'), res as unknown as Response)
    expect(createIncident).not.toHaveBeenCalled()
    expect((res.body as { text: string }).text).toMatch(/"ghost" non trovato/)
  })

  it('service ValidationError → ephemeral message with the service reason', async () => {
    const { session } = sessionWith([[userRow], [rec({ id: 'ci-web' })]])
    vi.mocked(getSession).mockReturnValue(session as never)
    const { ValidationError } = await import('../../lib/errors.js')
    vi.mocked(createIncident).mockRejectedValueOnce(new ValidationError('Fornire impact+urgency oppure severity'))
    const res = fakeRes()
    await handleSlackCommands(slackRequest('incident apri Sito giù ci=web-01 high'), res as unknown as Response)
    expect((res.body as { response_type: string; text: string })).toMatchObject({ response_type: 'ephemeral' })
    expect((res.body as { text: string }).text).toMatch(/Fornire impact\+urgency/)
  })

  it('bad signature → 401', async () => {
    const req = slackRequest('incident apri x ci=y high')
    ;(req.headers as Record<string, string>)['x-slack-signature'] = 'v0=deadbeef'
    const res = fakeRes()
    await handleSlackCommands(req, res as unknown as Response)
    expect(res.statusCode).toBe(401)
  })
})
