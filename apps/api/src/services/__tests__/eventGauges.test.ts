/**
 * services/events/gauges.ts — i gauge di salute riallineati dal job
 * periodico: eventi `delayed` con scadenza passata da più di 5 minuti e
 * eventi firing con correlazione none/pending da più di 15 minuti (conteggi
 * su tutti i tenant, solo lettura, tenant-ok marcato nel Cypher).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({ eventsOverdueDelayed: { set: vi.fn() }, eventsFiringUncorrelated: { set: vi.fn() } }))

const { refreshEventGauges, OVERDUE_DELAYED_GRACE_MINUTES, UNCORRELATED_AFTER_MINUTES, PENDING_CORRELATIONS, OVERDUE_DELAYED_WHERE, UNCORRELATED_WHERE, STUCK_FIRING_WHERE } = await import('../eventCorrelation.js')
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
    vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => (/correlation = 'delayed'/.test(cypher) ? { n: 3 } : { n: 7 })) as never)
    await expect(refreshEventGauges(NOW)).resolves.toEqual({ overdueDelayed: 3, firingUncorrelated: 7 })
    expect(metrics.eventsOverdueDelayed.set).toHaveBeenCalledWith({}, 3)
    expect(metrics.eventsFiringUncorrelated.set).toHaveBeenCalledWith({}, 7)
    const [overdue, uncorrelated] = vi.mocked(runQueryOne).mock.calls.map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
    // Revisione 2 · B2-01: i predicati sono quelli condivisi con la passata periodica (services/events/stuck.ts)
    expect(overdue!.cypher).toContain("MATCH (e:Event {status: 'firing'})")
    expect(overdue!.cypher).toContain(`WHERE ${OVERDUE_DELAYED_WHERE}`)
    expect(overdue!.params).toEqual({ delayedCutoff: minutesAgo(OVERDUE_DELAYED_GRACE_MINUTES) })
    expect(uncorrelated!.cypher).toContain("MATCH (e:Event {status: 'firing'})")
    expect(uncorrelated!.cypher).toContain(`WHERE ${UNCORRELATED_WHERE}`)
    expect(uncorrelated!.params).toEqual({ correlations: PENDING_CORRELATIONS, uncorrelatedCutoff: minutesAgo(UNCORRELATED_AFTER_MINUTES) })
    expect(OVERDUE_DELAYED_GRACE_MINUTES).toBe(5)
    expect(UNCORRELATED_AFTER_MINUTES).toBe(15)
    // il gauge misura ESATTAMENTE ciò che la passata ripara: i suoi due predicati sono due dei tre rami della passata
    expect(STUCK_FIRING_WHERE).toContain(UNCORRELATED_WHERE)
    expect(STUCK_FIRING_WHERE).toContain(OVERDUE_DELAYED_WHERE)
    expect(session.close).toHaveBeenCalled()
  })

  it('nessuna riga → 0; istante non ISO → errore', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(refreshEventGauges(NOW)).resolves.toEqual({ overdueDelayed: 0, firingUncorrelated: 0 })
    await expect(refreshEventGauges('ieri')).rejects.toThrow(/stuckEventParams: "ieri" is not an ISO date/)
  })
})
