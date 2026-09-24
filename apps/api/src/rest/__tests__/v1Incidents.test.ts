/**
 * A-08 / A-21 on the REST incidents router, over a real Express app:
 *  - PATCH never accepts `status` (workflow-only) and delegates to the same
 *    updateIncident service as GraphQL;
 *  - POST delegates to incidentService.createIncident;
 *  - typed errors map to 404/400, anything else to a generic 500;
 *  - `?page=1&page=2` (un array) is a 400, not a NaN reaching Cypher.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { perms } from '../../lib/__tests__/testPermissions.js'
/*
 * LA FORMA DELL'ARRAY È CAMBIATA CON EXPRESS 5 (21 set 2026).
 *
 * Express 5 usa `simple` come parser della query string, non piu' `qs`
 * (`extended`). Quindi `?page[]=1` NON produce piu' un array: diventa una
 * chiave letterale `page[]`, che nessuna rotta conosce e che viene ignorata.
 *
 * L'array pero' esiste ancora, nella forma che il parser semplice produce:
 * `?page=1&page=2` → `{ page: ['1','2'] }`. È quella che questi test
 * provano adesso, perche' l'INTENTO non e' cambiato: un array non deve
 * diventare un `NaN` che arriva fino a Cypher.
 *
 * Non si e' rimesso `extended` per far ripassare i test com'erano: quel
 * parser fa passare le query string dentro `qs`, ed e' proprio da li' che
 * venivano i tre avvisi (GHSA-q8mj, GHSA-x5fp, GHSA-4mjr) che questa
 * migrazione ha chiuso.
 */

vi.mock('../../lib/ticketCustomFields.js', async (importOriginal) => ({ ...(await importOriginal<object>()), customFieldDefs: vi.fn(async () => []) }))
const setTicketCustomFields = vi.fn(async () => [])
vi.mock('../../services/ticketCustomFields.js', () => ({ writeTicketCustomFields: (...a: unknown[]) => setTicketCustomFields(...a) }))
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}))
vi.mock('../../middleware/apiKeyAuth.js', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { keyId: 'key-1', tenantId: 'tenant-1', permissions: ['*'], rateLimit: 60 }
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))
vi.mock('../../lib/db.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ close: vi.fn() })),
}))
vi.mock('../../services/incidentService.js', () => ({
  createIncident: vi.fn(),
  updateIncident: vi.fn(),
}))

const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createIncident, updateIncident } = await import('../../services/incidentService.js')
const { incidentsRouter } = await import('../v1/incidents.js')
const { restErrorHandler } = await import('../errorHandler.js')
const { NotFoundError, ValidationError } = await import('../../lib/errors.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/incidents', incidentsRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/incidents`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

const patch = (id: string, body: unknown) => fetch(`${base}/${id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describe('PATCH /api/v1/incidents/:id', () => {
  it('rejects `status` with 400 — status only changes via workflow transition', async () => {
    const res = await patch('inc-1', { status: 'resolved' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toMatch(/workflow transition/)
    expect(updateIncident).not.toHaveBeenCalled()
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('rejects unknown fields (no silent drop)', async () => {
    const res = await patch('inc-1', { title: 'x', assignee_id: 'u-1' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/assignee_id/)
  })

  it('delegates to the updateIncident service of GraphQL with the API-key context', async () => {
    vi.mocked(updateIncident).mockResolvedValueOnce({ id: 'inc-1', title: 'nuovo' } as never)
    const res = await patch('inc-1', { title: 'nuovo', severity: 'high' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { id: 'inc-1', title: 'nuovo' } })
    expect(updateIncident).toHaveBeenCalledWith(
      'inc-1',
      { title: 'nuovo', severity: 'high' },
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'key-1', role: 'operator', permissions: perms('operator') }),
    )
  })

  // Ondata 4: i campi del cliente passano dalla stessa mutation del dettaglio.
  it('customFields → writeTicketCustomFields con l\'oggetto trasformato in elenco; un valore non scalare → 400', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'inc-1', title: 't', status: 'new', severity: 'low', created_at: 'x', updated_at: 'x', esito: 'ok' } })
    const res = await patch('inc-1', { customFields: { esito: 'ok', centro: null } })
    expect(res.status).toBe(200)
    expect(setTicketCustomFields).toHaveBeenCalledWith('incident', 'inc-1', [{ name: 'esito', value: 'ok' }, { name: 'centro', value: null }], expect.objectContaining({ tenantId: 'tenant-1' }))
    expect(updateIncident).not.toHaveBeenCalled()
    const bad = await patch('inc-1', { customFields: { esito: { nested: true } } })
    expect(bad.status).toBe(400)
  })

  it('NotFoundError from the resolver → 404', async () => {
    vi.mocked(updateIncident).mockRejectedValueOnce(new NotFoundError('Incident', 'inc-404'))
    const res = await patch('inc-404', { title: 'x' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Incident inc-404 not found' } })
  })

  it('unexpected error → 500 with a generic message', async () => {
    vi.mocked(updateIncident).mockRejectedValueOnce(new Error('bolt://secret-host refused'))
    const res = await patch('inc-1', { title: 'x' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
  })
})

describe('POST /api/v1/incidents', () => {
  it('delegates to incidentService.createIncident (number, WI, SLA, events)', async () => {
    vi.mocked(createIncident).mockResolvedValueOnce({ id: 'inc-new', number: 'INC00000001' } as never)
    const res = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Down', severity: 'high', affectedCIIds: ['ci-1'] }),
    })
    expect(res.status).toBe(201)
    expect(createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Down', severity: 'high', affectedCIIds: ['ci-1'] }),
      { tenantId: 'tenant-1', userId: 'key-1' },
    )
  })

  it('service ValidationError → 400 with the service message', async () => {
    vi.mocked(createIncident).mockRejectedValueOnce(new ValidationError('An incident must have at least one impacted CI'))
    const res = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Down', severity: 'high' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/impacted CI/)
  })

  it('missing title → 400 before touching the service', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ severity: 'high' }) })
    expect(res.status).toBe(400)
    expect(createIncident).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/incidents', () => {
  it('?page=1&page=2 → 400 (array), no query executed', async () => {
    const res = await fetch(`${base}?page=1&page=2`)
    expect(res.status).toBe(400)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('valid pagination runs the query with integer offset/limit', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 1 })
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'inc-1', title: 't', status: 'new', severity: 'low', created_at: 'x', updated_at: 'x' } }])
    const res = await fetch(`${base}?page=2&limit=5`)
    expect(res.status).toBe(200)
    const body = await res.json() as { meta: { page: number; limit: number; total: number } }
    expect(body.meta).toEqual({ page: 2, limit: 5, total: 1 })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ offset: 5, limit: 5, tenantId: 'tenant-1' })
  })

  it('GET /:id unknown → 404', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
