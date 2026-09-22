/**
 * The server log sink, wired for real: the writer that `accendiSinkDeiLog`
 * builds, the periodic flush, the rate-limited complaint on stderr, and the
 * shutdown path.
 *
 * Why these behaviours matter:
 *  - The writer is what turns an error of the SLA engine at 3 a.m. into a row
 *    an administrator can read the next morning. It must write the platform
 *    batch and the customer batch on a WRITE session, count what it wrote,
 *    and close the session even when Neo4j fails (a leaked session per flush
 *    would exhaust the pool within the hour).
 *  - The consent that gates the cross-tenant archive is the platform tenant's
 *    `platformSelfAnalysis` switch. Asking any other tenant, or any other
 *    feature, would build the archive without anybody having said yes.
 *  - Without the periodic flush, rows accumulate until the cap and are lost.
 *  - When Neo4j is down the sink complains on stderr at most once a minute: a
 *    complaint per flush would flood the very logs the operator is reading.
 *  - Shutting down detaches the logger first and then writes what is left:
 *    the last rows before a restart are the interesting ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const session = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
const getSession = vi.hoisted(() => vi.fn(() => session))
vi.mock('@opengraphity/neo4j', () => ({ getSession, toNumber: (v: unknown) => Number(v) }))
const collegaSinkDeiLog = vi.hoisted(() => vi.fn())
vi.mock('../logger.js', () => ({ collegaSinkDeiLog }))
const aiFeatureEnabled = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../aiSettings.js', () => ({ aiFeatureEnabled }))
vi.mock('../serverLogEvents.js', () => ({ TENANT_DI_PIATTAFORMA: 'opengrafo' }))

const sink = await import('../serverLogSink.js')
const {
  accendiSinkDeiLog, spegniSinkDeiLog, avviaSink, fermaSink, svuota, statoDelSink, azzeraSink,
  registraRigaDelServer, rigaDelCliente, LOTTO_CYPHER, LOTTO_CLIENTE_CYPHER, INTERVALLO_MS,
} = sink

const NOW = Date.parse('2026-09-20T11:34:23.632Z')
const line = (extra: Record<string, unknown> = {}) => ({ time: NOW, service: 'opengrafo-api', module: 'graphql', msg: 'boom', ...extra })
const records = (n: number) => ({ records: [{ get: (k: string) => (k === 'n' ? n : undefined) }] })

beforeEach(() => {
  azzeraSink()
  vi.clearAllMocks()
  aiFeatureEnabled.mockResolvedValue(true)
})
afterEach(async () => {
  vi.useRealTimers()
  await fermaSink()
  azzeraSink()
})

describe('accendiSinkDeiLog — the real writer', () => {
  it('connects the logger to the sink', async () => {
    await accendiSinkDeiLog()
    expect(collegaSinkDeiLog).toHaveBeenCalledWith(registraRigaDelServer)
  })

  it('writes the platform batch and the customer batch in order, on a WRITE session, and sums the counts', async () => {
    session.run.mockResolvedValueOnce(records(1)).mockResolvedValueOnce(records(1))
    await accendiSinkDeiLog()
    registraRigaDelServer(line(), 'error', 'c-test')
    await svuota()

    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    // Two runs, one after the other, on the same session: the driver refuses concurrent runs.
    expect(session.run.mock.calls.map((c) => c[0])).toEqual([LOTTO_CYPHER, LOTTO_CLIENTE_CYPHER])
    expect((session.run.mock.calls[1]![1] as { righe: Array<{ tenantId: string }> }).righe[0]!.tenantId).toBe('c-test')
    expect(statoDelSink().scritte).toBe(2)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('asks consent of the PLATFORM tenant, for platformSelfAnalysis', async () => {
    session.run.mockResolvedValue(records(1))
    await accendiSinkDeiLog()
    registraRigaDelServer(line(), 'error')
    await svuota()
    expect(aiFeatureEnabled).toHaveBeenCalledWith('opengrafo', 'platformSelfAnalysis')
  })

  it('with consent off only the customer batch is written', async () => {
    aiFeatureEnabled.mockResolvedValue(false)
    session.run.mockResolvedValue(records(1))
    await accendiSinkDeiLog()
    registraRigaDelServer(line(), 'error', 'c-test')
    await svuota()
    expect(session.run.mock.calls.map((c) => c[0])).toEqual([LOTTO_CLIENTE_CYPHER])
    expect(statoDelSink()).toMatchObject({ scritte: 1, senzaConsenso: 1 })
  })

  it('an empty RETURN counts as zero, not NaN', async () => {
    session.run.mockResolvedValue({ records: [] })
    await accendiSinkDeiLog()
    registraRigaDelServer(line(), 'error', 'c-test')
    await svuota()
    expect(statoDelSink().scritte).toBe(0)
  })

  it('closes the session when Neo4j fails, and counts the lost rows', async () => {
    session.run.mockRejectedValue(new Error('Neo4j unreachable'))
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await accendiSinkDeiLog()
    registraRigaDelServer(line(), 'error')
    await svuota()
    expect(session.close).toHaveBeenCalledOnce()
    expect(statoDelSink()).toMatchObject({ fallimenti: 1, scartate: 1 })
    stderr.mockRestore()
  })
})

describe('the periodic flush', () => {
  it('writes the queue every INTERVALLO_MS without anybody calling svuota', async () => {
    vi.useFakeTimers()
    const writer = vi.fn(async (r: unknown[]) => r.length)
    avviaSink(writer, async () => true)
    registraRigaDelServer(line(), 'error')
    await vi.advanceTimersByTimeAsync(INTERVALLO_MS)
    expect(writer).toHaveBeenCalledOnce()
    expect(statoDelSink().scritte).toBe(1)
  })

  it('starting twice keeps one timer: rows are not written twice', async () => {
    vi.useFakeTimers()
    const first = vi.fn(async (r: unknown[]) => r.length)
    const second = vi.fn(async (r: unknown[]) => r.length)
    avviaSink(first, async () => true)
    avviaSink(second, async () => true)
    registraRigaDelServer(line(), 'error')
    await vi.advanceTimersByTimeAsync(INTERVALLO_MS)
    // The second call replaces the writer, it does not add a second interval.
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
})

describe('the complaint on stderr', () => {
  it('is written at most once a minute, but the last error is always recorded', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const writer = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce('second')
      .mockRejectedValueOnce(new Error('third'))
    avviaSink(writer, async () => true)

    registraRigaDelServer(line(), 'error'); await svuota()
    registraRigaDelServer(line(), 'error'); await svuota()
    expect(stderr).toHaveBeenCalledTimes(1)
    // A non-Error rejection is still readable in the state.
    expect(statoDelSink().ultimoErrore).toContain('second')

    vi.setSystemTime(NOW + 61_000)
    registraRigaDelServer(line(), 'error'); await svuota()
    expect(stderr).toHaveBeenCalledTimes(2)
    expect(String(stderr.mock.calls[1]![0])).toContain('third')
    stderr.mockRestore()
  })
})

describe('shutdown', () => {
  it('detaches the logger, then writes what is left', async () => {
    const writer = vi.fn(async (r: unknown[], c: unknown[]) => r.length + c.length)
    avviaSink(writer, async () => true)
    registraRigaDelServer(line(), 'error', 'c-test')
    await spegniSinkDeiLog()
    expect(collegaSinkDeiLog).toHaveBeenCalledWith(null)
    expect(writer).toHaveBeenCalledOnce()
    expect(statoDelSink().inAttesa).toBe(0)
  })

  it('stopping a sink that never started is harmless', async () => {
    await expect(fermaSink()).resolves.toBeUndefined()
  })
})

describe('rigaDelCliente — defaults for a sparse line', () => {
  it('fills module, time and message, and has no data when there is nothing extra', () => {
    const r = rigaDelCliente({ msg: 42 }, 'error', 'c-test')!
    expect(r.module).toBe('api')
    expect(r.message).toBe('')
    expect(r.data).toBeNull()
    expect(Number.isNaN(Date.parse(r.timestamp))).toBe(false)
  })
})
