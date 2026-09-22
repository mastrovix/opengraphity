/**
 * aiCostLedger — the per-tenant, per-month AI token ledger.
 *
 * Why it matters: this ledger is the only place where "how much does this
 * customer cost us in AI" can be answered. If the month key drifts, the tenant
 * is not stamped on the row, or a missing `usage` block throws, a month's cost
 * is silently lost or charged to the wrong customer. And the ledger must NEVER
 * make the measured AI feature fail: a write error is logged, not thrown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const getSession = vi.fn(() => ({ run, close }))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...(a as [])),
  // Neo4j integers come back as objects; the ledger must turn them into numbers.
  toNumber: (v: unknown) => (typeof v === 'object' && v !== null && 'low' in v ? (v as { low: number }).low : Number(v)),
}))
const warn = vi.fn()
vi.mock('../logger.js', () => ({ logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))

const { meseDi, gettoniDi, registraCosto, consumoDi, SOMMA_CYPHER } = await import('../aiCostLedger.js')

const response = (usage: unknown) => ({ usage }) as never

beforeEach(() => { vi.clearAllMocks() })

describe('meseDi', () => {
  it('keys the ledger by UTC calendar month', () => {
    // 23:30 UTC on 31 Jan is still January, whatever the server time zone.
    expect(meseDi(new Date('2026-01-31T23:30:00Z'))).toBe('2026-01')
    expect(meseDi(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12')
  })
  it('defaults to now', () => {
    expect(meseDi()).toMatch(/^\d{4}-\d{2}$/)
  })
})

describe('gettoniDi', () => {
  it('reads all four token counters', () => {
    expect(gettoniDi(response({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 })))
      .toEqual({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 })
  })
  it('a response without usage counts as zero instead of throwing', () => {
    // A test double or a new provider shape must not crash the feature being measured.
    expect(gettoniDi(response(undefined))).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(gettoniDi(response({ input_tokens: 7, cache_read_input_tokens: null }))).toEqual({ input: 7, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('registraCosto', () => {
  it('adds the call to the (tenant, month, feature) row on a WRITE session', async () => {
    run.mockResolvedValue({ records: [] })
    const when = new Date('2026-03-15T10:00:00Z')
    await registraCosto('tenant-a', 'triage' as never, response({ input_tokens: 100, output_tokens: 20 }), when)
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(run).toHaveBeenCalledWith(SOMMA_CYPHER, {
      tenantId: 'tenant-a', month: '2026-03', feature: 'triage', now: when.toISOString(),
      input: 100, output: 20, cacheRead: 0, cacheWrite: 0,
    })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('the Cypher accumulates instead of overwriting, so concurrent writers add up', () => {
    expect(SOMMA_CYPHER).toMatch(/MERGE \(u:AIUsage \{tenant_id: \$tenantId, month: \$month, feature: \$feature\}\)/)
    expect(SOMMA_CYPHER).toMatch(/u\.input\s+= u\.input\s+\+ \$input/)
    expect(SOMMA_CYPHER).toMatch(/u\.calls\s+= u\.calls\s+\+ 1/)
  })

  it('a failed write is logged and swallowed, and the session is still closed', async () => {
    run.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(registraCosto('tenant-a', 'triage' as never, response({ input_tokens: 1, output_tokens: 1 }))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a', feature: 'triage', err: 'neo4j down' }), expect.any(String))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('a non-Error rejection is logged as its string', async () => {
    run.mockRejectedValueOnce('boom')
    await registraCosto('tenant-a', 'triage' as never, response({}))
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'boom' }), expect.any(String))
  })
})

describe('consumoDi', () => {
  const rec = (row: Record<string, unknown>) => ({ get: (k: string) => row[k] })

  it('reads only the tenant rows and converts Neo4j integers', async () => {
    run.mockResolvedValue({ records: [rec({ month: '2026-03', feature: 'triage', input: { low: 5, high: 0 }, output: 2, cacheRead: 0, cacheWrite: 1, calls: { low: 3, high: 0 } })] })
    const rows = await consumoDi('tenant-a', 2)
    expect(run.mock.calls[0]![0]).toMatch(/MATCH \(u:AIUsage \{tenant_id: \$tenantId\}\)/)
    // 12 features per month at most: the row limit scales with the months asked.
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-a', limite: 24 })
    expect(rows).toEqual([{ tenantId: 'tenant-a', month: '2026-03', feature: 'triage', input: 5, output: 2, cacheRead: 0, cacheWrite: 1, calls: 3 }])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('defaults to twelve months and closes the session on error', async () => {
    run.mockRejectedValueOnce(new Error('x'))
    await expect(consumoDi('tenant-a')).rejects.toThrow('x')
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-a', limite: 144 })
    expect(close).toHaveBeenCalledTimes(1)
  })
})
