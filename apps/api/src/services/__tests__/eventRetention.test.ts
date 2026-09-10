/**
 * eventRetention.ts — purge degli eventi risolti oltre retention_days per
 * tenant: solo status resolved con resolved_at più vecchio del cutoff, in
 * batch (CALL … IN TRANSACTIONS OF 1000 ROWS) con il conteggio restituito
 * dalla STESSA query (revisione 2.3), retention 0 = mai, log e metrica per
 * tenant, un tenant senza policy fa fallire il job dopo gli altri.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
const logInfo = vi.fn()
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: logInfo, warn: vi.fn(), error: logError, debug: vi.fn() }) } }))
vi.mock('../../middleware/metrics.js', () => ({ eventsPurgedTotal: { inc: vi.fn() } }))
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn() }))

const { purgeResolvedEvents, purgeTenantResolvedEvents, retentionCutoff, PURGE_BATCH_SIZE } = await import('../eventRetention.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { getEventPolicy } = await import('../events/policy.js')
const { eventsPurgedTotal } = await import('../../middleware/metrics.js')
const { DEFAULT_EVENT_POLICY } = await import('../../lib/eventPolicy.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOW = new Date('2026-09-09T03:30:00.000Z')
const policy = (over: Partial<typeof DEFAULT_EVENT_POLICY> = {}) => ({ ...structuredClone(DEFAULT_EVENT_POLICY), ...over })

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    for (const [re, value] of [...rules].reverse()) if (re.test(cypher)) return typeof value === 'function' ? (value as (p: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callsMatching = (re: RegExp) => calls().filter((c) => re.test(c.cypher))

const Q = {
  tenants: /MATCH \(t:Tenant\)\s+WHERE t\.id IS NOT NULL/,
  purge:   /CALL \{ WITH e DETACH DELETE e \} IN TRANSACTIONS OF 1000 ROWS\s+RETURN count\(\*\) AS n/,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(getEventPolicy).mockResolvedValue(policy())
})

describe('retentionCutoff', () => {
  it('now − retention_days giorni; 0 o non intero → errore (0 è "mai", gestito a monte)', () => {
    expect(retentionCutoff(NOW.getTime(), 90)).toBe('2026-06-11T03:30:00.000Z')
    expect(retentionCutoff(NOW.getTime(), 1)).toBe('2026-09-08T03:30:00.000Z')
    expect(() => retentionCutoff(NOW.getTime(), 0)).toThrow(/retention_days must be an integer >= 1/)
    expect(() => retentionCutoff(NOW.getTime(), 1.5)).toThrow(/retention_days/)
    expect(PURGE_BATCH_SIZE).toBe(1000)
  })
})

describe('purgeTenantResolvedEvents', () => {
  it('UNA query: elimina in batch SOLO gli Event resolved del tenant con resolved_at < cutoff (mai firing/suppressed/flapping) e restituisce il conteggio della stessa query (2.3); nessuna riga → 0', async () => {
    onCypher([[Q.purge, { n: 12 }]])
    await expect(purgeTenantResolvedEvents('acme', 'CUTOFF')).resolves.toBe(12)
    expect(calls()).toHaveLength(1)
    const purge = callsMatching(Q.purge)[0]!
    expect(purge.cypher).toContain("MATCH (e:Event {tenant_id: $tenantId, status: 'resolved'})")
    expect(purge.cypher).toContain('WHERE e.resolved_at IS NOT NULL AND e.resolved_at < $cutoff')
    expect(purge.cypher).not.toMatch(/firing|suppressed|flapping/)
    expect(purge.params).toEqual({ tenantId: 'acme', cutoff: 'CUTOFF' })
    // CALL … IN TRANSACTIONS vuole una sessione auto-commit (runQuery → session.run, vedi eventRetentionAutocommit.test.ts)
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[Q.purge, null]])
    await expect(purgeTenantResolvedEvents('acme', 'CUTOFF')).resolves.toBe(0)
  })
})

describe('purgeResolvedEvents', () => {
  it('per ogni tenant: cutoff dalla SUA policy, cancellazione, log e metrica; retention 0 → saltato con log; riepilogo', async () => {
    vi.mocked(getEventPolicy).mockImplementation(async (t: string) => policy({ retention_days: t === 'acme' ? 90 : t === 'globex' ? 0 : 30 }))
    onCypher([
      [Q.tenants, [{ id: 'acme' }, { id: 'globex' }, { id: 'initech' }]],
      [Q.purge, (p: Record<string, unknown>) => ({ n: p['tenantId'] === 'acme' ? 12 : 0 })],
    ])
    const out = await purgeResolvedEvents(NOW)
    expect(out).toEqual({
      tenants: 3, purged: 12, failed: 0,
      perTenant: [
        { tenantId: 'acme', retentionDays: 90, cutoff: '2026-06-11T03:30:00.000Z', purged: 12 },
        { tenantId: 'globex', retentionDays: 0, cutoff: null, purged: 0 },
        { tenantId: 'initech', retentionDays: 30, cutoff: '2026-08-10T03:30:00.000Z', purged: 0 },
      ],
    })
    expect(callsMatching(Q.purge).map((c) => c.params)).toEqual([
      { tenantId: 'acme', cutoff: '2026-06-11T03:30:00.000Z' },
      { tenantId: 'initech', cutoff: '2026-08-10T03:30:00.000Z' },   // globex: mai interrogato
    ])
    expect(eventsPurgedTotal.inc).toHaveBeenCalledTimes(1)
    expect(eventsPurgedTotal.inc).toHaveBeenCalledWith({}, 12)
    expect(logInfo).toHaveBeenCalledWith({ tenantId: 'acme', retentionDays: 90, cutoff: '2026-06-11T03:30:00.000Z', purged: 12 }, 'Resolved events purged')
    expect(logInfo).toHaveBeenCalledWith({ tenantId: 'globex' }, expect.stringMatching(/retention_days = 0/))
  })

  it('tenant senza policy → errore loggato, gli altri tenant vengono comunque purgati, il job fallisce alla fine con i conteggi', async () => {
    vi.mocked(getEventPolicy).mockImplementation(async (t: string) => { if (t === 'broken') throw new Error('Tenant broken has no event_policy'); return policy() })
    onCypher([[Q.tenants, [{ id: 'broken' }, { id: 'acme' }]], [Q.purge, { n: 3 }]])
    await expect(purgeResolvedEvents(NOW)).rejects.toThrow(/1\/2 tenants failed \(see logs\); purged 3 events on the others/)
    expect(callsMatching(Q.purge)).toHaveLength(1)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'broken' }), 'Event purge failed for tenant')
  })

  it('nessun tenant → riepilogo vuoto', async () => {
    onCypher([[Q.tenants, []]])
    await expect(purgeResolvedEvents(NOW)).resolves.toEqual({ tenants: 0, purged: 0, failed: 0, perTenant: [] })
  })
})
