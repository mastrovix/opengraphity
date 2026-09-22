/**
 * lib/provisioningGauge.ts — `tenant_provisioning_gaps{tenant}` for /health
 * and /metrics.
 *
 * Why these behaviours matter: an incomplete tenant only shows its symptom
 * at the first ticket, so operators rely on this gauge. It must
 *  - report every customer tenant (never the shared `system` tenant, which
 *    has no dashboard or workflow by construction and would always alarm);
 *  - not cost one query per tenant on every health probe (5-minute cache,
 *    and concurrent probes share one computation);
 *  - never turn a database hiccup into a failing health probe: it keeps the
 *    last known result instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../provisionTenantData.js', () => ({
  tenantProvisioningGaps: vi.fn(),
  formatGap: (g: { kind: string }) => `gap:${g.kind}`,
}))
vi.mock('../../middleware/metrics.js', () => ({ tenantProvisioningGapsGauge: { set: vi.fn() } }))
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { child: () => child }, __child: child }
})

const { getSession } = await import('@opengraphity/neo4j')
const { tenantProvisioningGaps } = await import('../provisionTenantData.js')
const { tenantProvisioningGapsGauge } = await import('../../middleware/metrics.js')
const loggerModule = await import('../logger.js') as unknown as { __child: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } }
const log = loggerModule.__child

const T0 = new Date('2026-09-22T10:00:00.000Z').getTime()

function session(tenantIds: string[] | Error) {
  return {
    run: vi.fn(async () => {
      if (tenantIds instanceof Error) throw tenantIds
      return { records: tenantIds.map((id) => ({ get: (k: string) => (k === 'id' ? id : undefined) })) }
    }),
    close: vi.fn(async () => undefined),
  }
}

/** A fresh module per test: the cache lives in module state. */
async function load() {
  vi.resetModules()
  return (await import('../provisioningGauge.js')).provisioningGaps
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => { vi.useRealTimers() })

describe('provisioningGaps', () => {
  it('computes gaps per customer tenant, skips the shared system tenant, sets the gauge and warns about incomplete ones', async () => {
    const s = session(['c-one', 'system', 'c-two'])
    vi.mocked(getSession).mockReturnValue(s as never)
    vi.mocked(tenantProvisioningGaps).mockImplementation((async (_s: unknown, t: string) =>
      (t === 'c-two' ? [{ kind: 'no_workflows' }, { kind: 'no_teams' }] : [])) as never)

    const provisioningGaps = await load()
    const out = await provisioningGaps()

    expect(out).toEqual({ 'c-one': [], 'c-two': ['gap:no_workflows', 'gap:no_teams'] })
    expect(vi.mocked(tenantProvisioningGaps).mock.calls.map((c) => c[1])).toEqual(['c-one', 'c-two'])
    expect(tenantProvisioningGapsGauge.set).toHaveBeenCalledWith({ tenant: 'c-one' }, 0)
    expect(tenantProvisioningGapsGauge.set).toHaveBeenCalledWith({ tenant: 'c-two' }, 2)
    expect(tenantProvisioningGapsGauge.set).not.toHaveBeenCalledWith({ tenant: 'system' }, expect.anything())
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(s.close).toHaveBeenCalledTimes(1)
  })

  it('all tenants complete → no warning', async () => {
    vi.mocked(getSession).mockReturnValue(session(['c-one']) as never)
    vi.mocked(tenantProvisioningGaps).mockResolvedValue([] as never)
    const provisioningGaps = await load()
    expect(await provisioningGaps()).toEqual({ 'c-one': [] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('within five minutes the cached result is returned without querying; after, it is recomputed', async () => {
    vi.mocked(getSession).mockImplementation(() => session(['c-one']) as never)
    vi.mocked(tenantProvisioningGaps).mockResolvedValue([] as never)
    const provisioningGaps = await load()

    await provisioningGaps()
    vi.setSystemTime(T0 + 4 * 60_000)
    await provisioningGaps()
    expect(getSession).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T0 + 5 * 60_000 + 1)
    await provisioningGaps()
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers share one computation', async () => {
    vi.mocked(getSession).mockImplementation(() => session(['c-one']) as never)
    vi.mocked(tenantProvisioningGaps).mockResolvedValue([] as never)
    const provisioningGaps = await load()
    const [a, b] = await Promise.all([provisioningGaps(), provisioningGaps()])
    expect(a).toEqual(b)
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('a database error keeps the last known result, logs it, closes the session and retries on the next call', async () => {
    vi.mocked(tenantProvisioningGaps).mockResolvedValue([{ kind: 'no_teams' }] as never)
    vi.mocked(getSession).mockReturnValueOnce(session(['c-one']) as never)
    const provisioningGaps = await load()
    const first = await provisioningGaps()

    vi.setSystemTime(T0 + 10 * 60_000)
    const broken = session(new Error('neo4j unavailable'))
    vi.mocked(getSession).mockReturnValueOnce(broken as never)
    await expect(provisioningGaps()).resolves.toEqual(first)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(broken.close).toHaveBeenCalledTimes(1)

    // The failure did not refresh the cache timestamp: the next probe retries.
    vi.mocked(getSession).mockReturnValueOnce(session(['c-one', 'c-three']) as never)
    expect(Object.keys(await provisioningGaps())).toEqual(['c-one', 'c-three'])
  })

  it('an error before any success yields an empty map, never a rejection', async () => {
    vi.mocked(getSession).mockReturnValue(session(new Error('down')) as never)
    const provisioningGaps = await load()
    await expect(provisioningGaps()).resolves.toEqual({})
  })
})
