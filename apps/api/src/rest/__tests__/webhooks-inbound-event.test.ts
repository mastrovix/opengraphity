/**
 * POST /api/webhooks/inbound/:hookId con entity_type = event: normalizzazione
 * per connettore, accodamento (202 + accepted), 400 su payload non valido /
 * connector_kind sconosciuto / oltre 500 allarmi, transform script PRIMA
 * della normalizzazione, nessun 202 se la coda fallisce; il 202 non azzera
 * `last_error` (revisione A4: lo fa il worker al primo job riuscito).
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
vi.mock('../../jobs/eventIngestWorker.js', () => ({ enqueueEvents: vi.fn() }))
vi.mock('@opengraphity/scripting', () => ({ runScript: vi.fn() }))
// Rate limit su Redis (lib/webhookRateLimit.ts): qui conta sempre 1, il limite non è in gioco.
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => ({ eval: vi.fn().mockResolvedValue(1) }) }))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createIncident } = await import('../../services/incidentService.js')
const { enqueueEvents } = await import('../../jobs/eventIngestWorker.js')
const { runScript } = await import('@opengraphity/scripting')
const { webhookInboundRouter } = await import('../webhooks-inbound.js')

const TOKEN = 'wh-secret-token'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

type HookProps = Record<string, unknown>
function hook(overrides: HookProps = {}): { props: HookProps } {
  return {
    props: {
      id: 'hook-ev', tenant_id: 'tenant-1', secret: sha(TOKEN), entity_type: 'event', connector_kind: 'alertmanager',
      field_mapping: '{}', default_values: null, transform_script: null,
      ...overrides,
    },
  }
}

const AM = {
  alerts: [
    { status: 'firing', fingerprint: 'f1', labels: { alertname: 'DiskFull', severity: 'critical', instance: 'db-01:9100' }, annotations: { summary: 'Disk full' } },
    { status: 'resolved', fingerprint: 'f2', labels: { alertname: 'HighLoad', severity: 'warning', instance: 'web-01' } },
  ],
}

let server: Server
let base: string
const session = { close: vi.fn().mockResolvedValue(undefined) }

beforeAll(async () => {
  const app = express()
  // Il parser JSON (2 MB) è sulla route del router: niente express.json a livello app (B4).
  app.use('/api', webhookInboundRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/inbound`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQuery).mockResolvedValue([])
  vi.mocked(runQueryOne).mockResolvedValue(hook())
  vi.mocked(enqueueEvents).mockImplementation(async (_t, _s, events) => events.length)
})

function post(body: unknown, hookId = 'hook-ev') {
  return fetch(`${base}/${hookId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  })
}
type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('entity_type = event', () => {
  it('alertmanager: 202 {id, entity_type: event, accepted: n}, eventi normalizzati accodati con receivedAt, statistiche aggiornate di n', async () => {
    const res = await post(AM)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: 'hook-ev', entity_type: 'event', accepted: 2 })
    expect(enqueueEvents).toHaveBeenCalledTimes(1)
    const [tenantId, sourceId, events, receivedAt] = vi.mocked(enqueueEvents).mock.calls[0]!
    expect(tenantId).toBe('tenant-1'); expect(sourceId).toBe('hook-ev')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ externalId: 'f1', status: 'firing', severity: 'critical', title: 'DiskFull', resource: 'db-01', resourceKind: 'hostname', description: 'Disk full' })
    expect(events[1]).toMatchObject({ externalId: 'f2', status: 'resolved', severity: 'warning', resource: 'web-01' })
    expect(Number.isNaN(Date.parse(receivedAt!))).toBe(false)
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SET w\.receive_count = coalesce\(w\.receive_count, 0\) \+ \$n/)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ hookId: 'hook-ev', tenantId: 'tenant-1', n: 2, now: receivedAt })
    expect(createIncident).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('connector_kind assente (webhook pre-esistente) → generic con field_mapping (campo → percorso puntato), default_values e value_mapping', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({
      connector_kind: undefined,
      field_mapping:  JSON.stringify({ title: 'alert.summary', resource: 'host.name', severity: 'alert.level', status: 'state' }),
      default_values: JSON.stringify({ resourceKind: 'hostname' }),
      value_mapping:  JSON.stringify({ severity: { P2: 'warning' }, status: { '1': 'firing' } }),
    }))
    const res = await post({ alert: { summary: 'CPU high', level: 'p2' }, host: { name: 'web-02:9100' }, state: '1' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: 1 })
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2][0]).toMatchObject({ title: 'CPU high', resource: 'web-02', severity: 'warning', status: 'firing', resourceKind: 'hostname' })
  })

  it.each(['grafana', 'zabbix', 'datadog', 'dynatrace'] as const)('connettore preset %s → 202 con il payload di esempio del connettore', async (kind) => {
    const { sampleInboundPayload } = await import('../../lib/eventSamples.js')
    vi.mocked(runQueryOne).mockResolvedValue(hook({ connector_kind: kind }))
    const res = await post(sampleInboundPayload(kind))
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ accepted: 1 })
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2][0]).toMatchObject({ status: 'firing', resourceKind: 'hostname' })
  })

  it('connector_kind sconosciuto → 400 con il motivo registrato sul webhook, niente in coda', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ connector_kind: 'nagios' }))
    const res = await post(AM)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/connector_kind must be one of: generic, alertmanager, grafana, zabbix, datadog, dynatrace/)
    expect(enqueueEvents).not.toHaveBeenCalled()
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SET w\.last_error = \$message/)
  })

  it('payload rifiutato (400) → last_error, last_error_at ed error_count+1 sul webhook, scoped per tenant; batch accettato (202) NON tocca last_error (lo azzera il worker al primo job riuscito)', async () => {
    const res = await post({ alerts: [{ status: 'firing', labels: { alertname: 'A', severity: 'info' } }] })
    expect(res.status).toBe(400)
    const rejection = vi.mocked(runQuery).mock.calls.find(([, c]) => /last_error/.test(c as string))!
    expect(rejection[1]).toContain('MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})')
    expect(rejection[1]).toMatch(/w\.error_count = coalesce\(w\.error_count, 0\) \+ 1/)
    expect(rejection[2]).toMatchObject({ hookId: 'hook-ev', tenantId: 'tenant-1', message: expect.stringMatching(/labels\.instance is missing/) })
    expect(Number.isNaN(Date.parse((rejection[2] as Record<string, string>)['now']!))).toBe(false)

    vi.mocked(runQuery).mockClear()
    const ok = await post(AM)
    expect(ok.status).toBe(202)
    const stats = vi.mocked(runQuery).mock.calls[0]!
    expect(stats[1]).toMatch(/w\.receive_count = coalesce\(w\.receive_count, 0\) \+ \$n/)
    // il 202 dice "accodato", non "riuscito": l'esito lo scrive jobs/eventIngestWorker.ts
    expect(stats[1]).not.toMatch(/last_error/)
    expect(stats[1]).not.toMatch(/error_count/)
  })

  it('400 prima dell\'autenticazione (token errato) non scrive last_error; scrittura del motivo fallita → resta il 400', async () => {
    const res = await fetch(`${base}/hook-ev`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '[]' })
    expect(res.status).toBe(401)
    expect(runQuery).not.toHaveBeenCalled()

    vi.mocked(runQuery).mockRejectedValueOnce(new Error('neo4j down'))
    const rejected = await post({ receiver: 'x' })
    expect(rejected.status).toBe(400)
    expect((await err(rejected)).message).toMatch(/no `alerts` array/)
  })

  it.each([
    ['senza alerts', { receiver: 'x' }, /no `alerts` array/],
    ['severity fuori enum', { alerts: [{ status: 'firing', labels: { alertname: 'A', severity: 'page', instance: 'h' } }] }, /labels\.severity must be one of/],
    ['senza instance', { alerts: [{ status: 'firing', labels: { alertname: 'A', severity: 'info' } }] }, /labels\.instance is missing/],
    ['lista vuota', { alerts: [] }, /contains no alerts/],
  ])('payload non valido (%s) → 400 con il motivo, niente in coda', async (_n, body, pattern) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(pattern)
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('generic senza title → 400 che cita field_mapping', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ connector_kind: 'generic' }))
    const res = await post({ severity: 'info', resource: 'h' })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/title .*field_mapping/)
  })

  it('più di 500 allarmi → 400; 500 esatti → 202', async () => {
    const alert = AM.alerts[0]!
    const tooMany = { alerts: Array.from({ length: 501 }, (_, i) => ({ ...alert, fingerprint: `f${i}` })) }
    const res = await post(tooMany)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Too many alerts in one request: 501 \(max 500\)/)
    expect(enqueueEvents).not.toHaveBeenCalled()

    const ok = await post({ alerts: tooMany.alerts.slice(0, 500) })
    expect(ok.status).toBe(202)
    expect(await ok.json()).toMatchObject({ accepted: 500 })
  })

  it('transform script gira PRIMA della normalizzazione sul payload grezzo', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ transform_script: 'return {alerts: [...]}' }))
    vi.mocked(runScript).mockResolvedValueOnce({ success: true, output: AM, logs: [], executionTimeMs: 1 } as never)
    const res = await post({ raw: 'anything' })
    expect(res.status).toBe(202)
    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({ code: 'return {alerts: [...]}' }), expect.objectContaining({ entity: { raw: 'anything' }, tenantId: 'tenant-1' }))
    expect(vi.mocked(enqueueEvents).mock.calls[0]![2]).toHaveLength(2)
  })

  it('transform script fallito → 400, niente in coda', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(hook({ transform_script: 'boom' }))
    vi.mocked(runScript).mockResolvedValueOnce({ success: false, error: 'boom', logs: [], executionTimeMs: 1 } as never)
    const res = await post(AM)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toBe('Transform script failed: boom')
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('coda non disponibile → 500 generico (mai un 202 che perde allarmi), statistiche non aggiornate', async () => {
    vi.mocked(enqueueEvents).mockRejectedValueOnce(new Error('redis down'))
    const res = await post(AM)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Processing error' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('token errato → 401 anche per i webhook evento', async () => {
    const res = await fetch(`${base}/hook-ev`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify(AM) })
    expect(res.status).toBe(401)
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('batch oltre i 2 MB (WEBHOOK_BODY_LIMIT) → 413 JSON dal restErrorHandler del router (B4), niente lookup né coda', async () => {
    const res = await fetch(`${base}/hook-ev`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: `{"alerts":[],"pad":"${'x'.repeat(2 * 1024 * 1024 + 64)}"}`,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_REQUEST', message: expect.stringMatching(/too large/i) } })
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('JSON malformato → 400 JSON { error: { code: BAD_REQUEST } } (B4)', async () => {
    const res = await fetch(`${base}/hook-ev`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: '{"alerts": [' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } })
    expect(enqueueEvents).not.toHaveBeenCalled()
  })
})
