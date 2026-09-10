/**
 * services/events/gauges.ts — i gauge di salute riallineati dal job
 * periodico: eventi `delayed` con scadenza passata da più di 5 minuti e
 * eventi firing con correlazione none/pending da più di 15 minuti (conteggi
 * su tutti i tenant, solo lettura, tenant-ok marcato nel Cypher).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({ eventsOverdueDelayed: { set: vi.fn() }, eventsFiringUncorrelated: { set: vi.fn() } }))

const { refreshEventGauges, OVERDUE_DELAYED_GRACE_MINUTES, UNCORRELATED_AFTER_MINUTES, PENDING_CORRELATIONS } = await import('../eventCorrelation.js')
const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const metrics = await import('../../middleware/metrics.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOW = '2026-09-09T10:00:00.000Z'
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('refreshEventGauges', () => {
  it('due conteggi (delayed scaduti da > 5 min; firing none/pending da > 15 min) → gauge riallineati e restituiti', async () => {
    vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => (/correlation: 'delayed'/.test(cypher) ? { n: 3 } : { n: 7 })) as never)
    await expect(refreshEventGauges(NOW)).resolves.toEqual({ overdueDelayed: 3, firingUncorrelated: 7 })
    expect(metrics.eventsOverdueDelayed.set).toHaveBeenCalledWith({}, 3)
    expect(metrics.eventsFiringUncorrelated.set).toHaveBeenCalledWith({}, 7)
    const [overdue, uncorrelated] = vi.mocked(runQueryOne).mock.calls.map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
    expect(overdue!.cypher).toContain("MATCH (e:Event {status: 'firing', correlation: 'delayed'})")
    expect(overdue!.cypher).toContain('WHERE e.correlation_due_at IS NOT NULL AND e.correlation_due_at < $cutoff')
    expect(overdue!.params).toEqual({ cutoff: minutesAgo(OVERDUE_DELAYED_GRACE_MINUTES) })
    expect(uncorrelated!.cypher).toContain("MATCH (e:Event {status: 'firing'})")
    expect(uncorrelated!.cypher).toContain('WHERE e.correlation IN $correlations AND coalesce(e.correlation_at, e.first_seen_at) < $cutoff')
    expect(uncorrelated!.params).toEqual({ correlations: PENDING_CORRELATIONS, cutoff: minutesAgo(UNCORRELATED_AFTER_MINUTES) })
    expect(OVERDUE_DELAYED_GRACE_MINUTES).toBe(5)
    expect(UNCORRELATED_AFTER_MINUTES).toBe(15)
    expect(session.close).toHaveBeenCalled()
  })

  it('nessuna riga → 0; istante non ISO → errore', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(refreshEventGauges(NOW)).resolves.toEqual({ overdueDelayed: 0, firingUncorrelated: 0 })
    await expect(refreshEventGauges('ieri')).rejects.toThrow(/not an ISO date/)
  })
})
