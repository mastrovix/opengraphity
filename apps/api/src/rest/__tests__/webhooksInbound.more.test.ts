/**
 * Inbound webhook: the mandatory fields that are checked per entity type.
 *
 * An inbound webhook that cannot produce a complete ticket must be refused
 * with a 400 that says what is missing, and must leave the reason in
 * `last_error` on the source (that is what the Sources page shows). The
 * cases here were not pinned (plus the lookup of the named CI):
 *  - an incident without the impacted CI (revisione totale · M-18): creating
 *    it anyway would give an incident nobody can route or assess;
 *  - a problem without a priority: the webhook must not invent one.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../services/incidentService.js', () => ({ createIncident: vi.fn() }))
vi.mock('../../services/problemService.js', () => ({ createProblem: vi.fn() }))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Server)`),
}))
vi.mock('@opengraphity/scripting', () => ({ runScript: vi.fn() }))
vi.mock('../../lib/scriptingPlan.js', () => ({ assertScriptingEnabled: vi.fn(async () => undefined) }))
// In-memory Redis for the per-hook rate limit: always the first call of the minute.
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => ({ eval: vi.fn(async () => 1) }) }))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createIncident } = await import('../../services/incidentService.js')
const { createProblem } = await import('../../services/problemService.js')
const { webhookInboundRouter } = await import('../webhooks-inbound.js')

const TOKEN = 'wh-secret-token'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function hook(overrides: Record<string, unknown> = {}) {
  return {
    props: {
      id: 'hook-1', tenant_id: 'tenant-1', secret: sha(TOKEN), entity_type: 'incident',
      field_mapping: JSON.stringify({ summary: 'title', level: 'severity', host: 'affectedCI' }),
      default_values: null, transform_script: null,
      ...overrides,
    },
  }
}

let server: Server
let base: string
const session = { close: vi.fn().mockResolvedValue(undefined) }

beforeAll(async () => {
  const app = express()
  app.use('/api', webhookInboundRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/inbound`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQuery).mockResolvedValue([] as never)
})

function post(body: unknown) {
  return fetch(`${base}/hook-1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })
}

/** The `last_error` writes on the source, i.e. what the Sources page will show. */
const lastErrors = () => vi.mocked(runQuery).mock.calls
  .filter((c) => String(c[1]).includes('SET w.last_error = $message'))
  .map((c) => c[2] as Record<string, unknown>)

describe('incident: the impacted CI is mandatory', () => {
  it.each([
    ['absent', { summary: 'Disk full', level: 'high' }],
    ['blank', { summary: 'Disk full', level: 'high', host: '   ' }],
  ])('affectedCI %s → 400 naming the field, no incident, reason recorded on the source', async (_label, body) => {
    vi.mocked(runQueryOne).mockResolvedValue(hook() as never)
    const res = await post(body)
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: { message: string } }
    expect(error.message).toMatch(/no affectedCI/)
    expect(createIncident).not.toHaveBeenCalled()
    expect(lastErrors()).toHaveLength(1)
    expect(lastErrors()[0]).toMatchObject({ hookId: 'hook-1', tenantId: 'tenant-1', message: expect.stringMatching(/affectedCI/) })
  })
})

describe('incident: the named CI must resolve to exactly one CI of THIS tenant', () => {
  it('no CI with that id or name → 400 "not found", no incident', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook() as never)
    const res = await post({ summary: 'Disk full', level: 'high', host: ' ghost-01 ' })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: { message: string } }
    expect(error.message).toMatch(/Impacted CI " ghost-01 " not found in this organization/)
    expect(createIncident).not.toHaveBeenCalled()
    // Why: the lookup is scoped to the webhook's tenant and uses the trimmed ref.
    const lookup = vi.mocked(runQuery).mock.calls.find((c) => String(c[1]).includes('toLower(ci.name)'))
    expect(lookup![2]).toEqual({ tenantId: 'tenant-1', ref: 'ghost-01' })
  })

  it('two CIs share the name → 400 "ambiguous": the webhook must map the id, not get a random one', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook() as never)
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('toLower(ci.name)') ? [{ id: 'ci-1', name: 'web' }, { id: 'ci-2', name: 'WEB' }] : []) as never)
    const res = await post({ summary: 'Down', level: 'high', host: 'web' })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: { message: string } }
    expect(error.message).toMatch(/ambiguous/)
    expect(createIncident).not.toHaveBeenCalled()
  })
})

describe('problem: the priority is mandatory', () => {
  it('no priority from mapping or defaults → 400, no problem created', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({
      entity_type: 'problem',
      field_mapping: JSON.stringify({ summary: 'title' }),
    }) as never)
    const res = await post({ summary: 'Recurring outage' })
    expect(res.status).toBe(400)
    const { error } = await res.json() as { error: { message: string } }
    expect(error.message).toMatch(/no priority/)
    expect(createProblem).not.toHaveBeenCalled()
    expect(lastErrors()).toHaveLength(1)
  })

  it('a priority from default_values is enough', async () => {
    vi.mocked(createProblem).mockResolvedValue({ id: 'prb-1' } as never)
    vi.mocked(runQueryOne).mockResolvedValue(hook({
      entity_type: 'problem',
      field_mapping: JSON.stringify({ summary: 'title', cat: 'category' }),
      default_values: JSON.stringify({ priority: 'P3' }),
    }) as never)
    const res = await post({ summary: 'Recurring outage', cat: 'network' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'hook-1', entity_type: 'problem', entity_id: 'prb-1' })
    expect(createProblem).toHaveBeenCalledWith(
      { title: 'Recurring outage', description: undefined, priority: 'P3', category: 'network' },
      { tenantId: 'tenant-1', userId: 'webhook' },
    )
  })
})
