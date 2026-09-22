/**
 * The server-log connector pass: reading the archive and enqueueing events.
 *
 * serverLogEvents.test.ts pins the pure decision (acute / chronic / quiet).
 * This file pins the three gates around it, each of which protects someone:
 *  - on a customer installation there is no platform tenant: the pass must do
 *    nothing (and not fail), or every customer would see a failing job;
 *  - an owner who turns `platformSelfAnalysis` off expects the product to STOP
 *    opening incidents about itself, not to keep doing so for ninety days from
 *    what the archive already holds;
 *  - events go to the platform tenant and to the log source the migration
 *    created, never anywhere else.
 * And the read side: the aggregation window and "today" are computed in UTC
 * from the clock the caller passes, so the acute rule counts the right day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ run, close }),
  toNumber: (v: unknown) => (typeof v === 'number' ? v : Number(v)),
}))
const enqueueEvents = vi.fn()
vi.mock('../../jobs/eventIngestWorker.js', () => ({ enqueueEvents: (...a: unknown[]) => enqueueEvents(...a) }))
const aiFeatureEnabled = vi.fn()
vi.mock('../aiSettings.js', () => ({ aiFeatureEnabled: (...a: unknown[]) => aiFeatureEnabled(...a) }))
vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const { aggregatiPerFirma, immettiEventiDaiLog, AGGREGATI_CYPHER, SOGLIE, TENANT_DI_PIATTAFORMA, SORGENTE_DEI_LOG } =
  await import('../serverLogEvents.js')

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

/** A Neo4j-like record over a plain object. */
const rec = (o: Record<string, unknown>) => ({ get: (k: string) => o[k] })
const row = (extra: Record<string, unknown> = {}) => rec({
  fingerprint: 'fp-1', service: 'opengrafo-api', module: 'graphql', level: 'error',
  template: 'Boom <n>', stackHead: null, occorrenzeOggi: 0, occorrenzeTotali: 0,
  giorniDistinti: 1, ultimoGiorno: '2026-09-20', ultimoIstante: '2026-09-20T11:30:00.000Z',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  aiFeatureEnabled.mockResolvedValue(true)
  enqueueEvents.mockImplementation((_t: string, _s: string, evs: unknown[]) => Promise.resolve(evs.length))
})

describe('aggregatiPerFirma', () => {
  it('asks for the window and today in UTC from the given clock, and maps the rows', async () => {
    run.mockResolvedValueOnce({ records: [row({ occorrenzeOggi: 3, occorrenzeTotali: 9, giorniDistinti: 2, stackHead: 'at x' })] })
    const out = await aggregatiPerFirma(NOW)

    expect(run).toHaveBeenCalledWith(AGGREGATI_CYPHER, {
      dalGiorno: '2026-09-13', // NOW minus the 7-day window
      oggi:      '2026-09-20',
    })
    expect(out).toEqual([{
      fingerprint: 'fp-1', service: 'opengrafo-api', module: 'graphql', level: 'error',
      template: 'Boom <n>', stackHead: 'at x', occorrenzeOggi: 3, occorrenzeTotali: 9,
      giorniDistinti: 2, ultimoGiorno: '2026-09-20', ultimoIstante: '2026-09-20T11:30:00.000Z',
    }])
    expect(close).toHaveBeenCalledOnce()
  })

  it('missing optional columns become null, not undefined', async () => {
    run.mockResolvedValueOnce({ records: [row({ stackHead: undefined, ultimoIstante: undefined })] })
    const [f] = await aggregatiPerFirma(NOW)
    expect(f!.stackHead).toBeNull()
    expect(f!.ultimoIstante).toBeNull()
  })

  it('closes the session even when the query fails', async () => {
    run.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(aggregatiPerFirma(NOW)).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('immettiEventiDaiLog', () => {
  it('without a platform tenant (a customer installation) it does nothing and does not fail', async () => {
    run.mockResolvedValueOnce({ records: [rec({ n: 0 })] })
    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 0, esaminate: 0 })
    expect(run.mock.calls[0]![1]).toEqual({ tenant: TENANT_DI_PIATTAFORMA })
    // Neither the switch nor the archive is read: there is nowhere to write.
    expect(aiFeatureEnabled).not.toHaveBeenCalled()
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('an empty tenant lookup result counts as "no tenant"', async () => {
    run.mockResolvedValueOnce({ records: [] })
    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 0, esaminate: 0 })
  })

  it('with self-analysis switched off, the existing archive does not open incidents', async () => {
    run.mockResolvedValueOnce({ records: [rec({ n: 1 })] })
    aiFeatureEnabled.mockResolvedValueOnce(false)
    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 0, esaminate: 0 })
    expect(aiFeatureEnabled).toHaveBeenCalledWith(TENANT_DI_PIATTAFORMA, 'platformSelfAnalysis')
    // The archive is not even read: switching off must stop the pass.
    expect(run).toHaveBeenCalledTimes(1)
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('signatures under every threshold enqueue nothing but are counted as examined', async () => {
    run
      .mockResolvedValueOnce({ records: [rec({ n: 1 })] })
      .mockResolvedValueOnce({ records: [row({ occorrenzeOggi: 1, occorrenzeTotali: 1 }), row({ fingerprint: 'fp-2' })] })
    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 0, esaminate: 2 })
    expect(enqueueEvents).not.toHaveBeenCalled()
  })

  it('enqueues one event per signature with a verdict, on the platform tenant and the log source', async () => {
    const quiet = new Date(NOW - (SOGLIE.oreDiQuiete + 1) * 3_600_000).toISOString()
    run
      .mockResolvedValueOnce({ records: [rec({ n: 1 })] })
      .mockResolvedValueOnce({ records: [
        row({ fingerprint: 'acute', occorrenzeOggi: SOGLIE.acutoOccorrenze, occorrenzeTotali: 40 }),
        row({ fingerprint: 'noise', occorrenzeOggi: 1, occorrenzeTotali: 1 }),
        row({ fingerprint: 'gone', ultimoIstante: quiet, occorrenzeTotali: 5 }),
      ] })

    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 2, esaminate: 3 })

    expect(enqueueEvents).toHaveBeenCalledOnce()
    const [tenant, source, events, receivedAt] = enqueueEvents.mock.calls[0] as [string, string, Array<{ externalId: string; status: string; severity: string }>, string]
    expect(tenant).toBe(TENANT_DI_PIATTAFORMA)
    expect(source).toBe(SORGENTE_DEI_LOG)
    // The noisy signature produced no event; the quiet one closes its incident.
    expect(events.map((e) => [e.externalId, e.status, e.severity])).toEqual([
      ['acute', 'firing', 'critical'],
      ['gone', 'resolved', 'info'],
    ])
    expect(receivedAt).toBe('2026-09-20T12:00:00.000Z')
  })

  it('reports what the ingest queue actually accepted, not what was offered', async () => {
    run
      .mockResolvedValueOnce({ records: [rec({ n: 1 })] })
      .mockResolvedValueOnce({ records: [row({ occorrenzeOggi: 50 }), row({ fingerprint: 'fp-2', occorrenzeOggi: 50 })] })
    enqueueEvents.mockResolvedValueOnce(1)
    await expect(immettiEventiDaiLog(NOW)).resolves.toEqual({ immessi: 1, esaminate: 2 })
  })

  it('closes the tenant-lookup session even when that query fails', async () => {
    run.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(immettiEventiDaiLog(NOW)).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledOnce()
  })
})
