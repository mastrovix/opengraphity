/**
 * The `dailyWorkAggregates` query: the page that shows how the team works.
 *
 * Why it matters: these are team-wide measures, so they must be gated by
 * `analysis.read` and computed for the caller's tenant only. The window is
 * clamped so a hostile or mistyped `windowDays` cannot ask Neo4j for years of
 * data, and steps with too few runs are dropped because a median over three
 * runs would mislead whoever reads the page. The schema speaks English while
 * the engine speaks Italian: the field mapping is the public contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => Number(v) }))

const copertura = vi.fn()
const azioniUmane = vi.fn()
const tempiNeiPassi = vi.fn()
const coppieRipetute = vi.fn()
const adozioneFunzioniAI = vi.fn()
vi.mock('../../../lib/dailyWorkAggregates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/dailyWorkAggregates.js')>()),
  copertura: (...a: unknown[]) => copertura(...a),
  azioniUmane: (...a: unknown[]) => azioniUmane(...a),
  tempiNeiPassi: (...a: unknown[]) => tempiNeiPassi(...a),
  coppieRipetute: (...a: unknown[]) => coppieRipetute(...a),
  adozioneFunzioniAI: (...a: unknown[]) => adozioneFunzioniAI(...a),
}))

const { dailyWorkResolvers } = await import('../dailyWork.js')
const { SOGLIE } = await import('../../../lib/dailyWorkAggregates.js')
const query = dailyWorkResolvers.Query.dailyWorkAggregates

const ctx = (perms: string[] = ['analysis.read']) =>
  ({ tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'analyst', permissions: new Set(perms) }) as unknown as GraphQLContext

const allAggregates = [copertura, azioniUmane, tempiNeiPassi, coppieRipetute, adozioneFunzioniAI]

beforeEach(() => {
  vi.clearAllMocks()
  copertura.mockResolvedValue({
    ticket: 40, conVoceDiCreazione: 38, vociTotali: 900, vociUmane: 700, vociGeneriche: 12, azioniNonLette: 3, finestraGiorni: 30,
  })
  azioniUmane.mockResolvedValue([{ object: 'incident', verb: 'assigned', n: 55, autoriDistinti: 4, oggettiDistinti: 30 }])
  tempiNeiPassi.mockResolvedValue([
    { stepName: 'in_progress', n: SOGLIE.esecuzioniMinimePerPasso, medianaOre: 5, p90Ore: 30, oltre48h: 2, zeriScartati: 1 },
    { stepName: 'rare_step',   n: SOGLIE.esecuzioniMinimePerPasso - 1, medianaOre: 1, p90Ore: 2, oltre48h: 0, zeriScartati: 0 },
  ])
  coppieRipetute.mockResolvedValue([{ prima: 'incident.assigned', poi: 'incident.commented', n: 12, oggettiDistinti: 5, autoriDistinti: 3 }])
  adozioneFunzioniAI.mockResolvedValue([{ feature: 'triage', n: 9, autoriDistinti: 2 }])
})

describe('dailyWorkAggregates', () => {
  it('without analysis.read nobody sees the team measures, and nothing is queried', async () => {
    await expect(query(undefined, {}, ctx(['incident.read']))).rejects.toThrow(/not authorized.*analysis\.read/)
    for (const fn of allAggregates) expect(fn).not.toHaveBeenCalled()
  })

  it('computes every aggregate for the caller tenant with the default 30-day window', async () => {
    await query(undefined, {}, ctx())
    for (const fn of allAggregates) expect(fn).toHaveBeenCalledWith('t1', 30)
  })

  it.each([
    [0, 1],       // a zero or negative window would be an empty photo
    [-5, 1],
    [90, 90],
    [10_000, 365], // clamped: never years of history in one request
  ])('windowDays %s is clamped to %s', async (asked, used) => {
    await query(undefined, { windowDays: asked }, ctx())
    expect(copertura).toHaveBeenCalledWith('t1', used)
  })

  it('maps the engine fields to the English schema and drops steps with too few runs', async () => {
    const r = await query(undefined, {}, ctx())
    expect(r).toEqual({
      coverage: { tickets: 40, withCreationEntry: 38, entries: 900, humanEntries: 700, genericEntries: 12, unreadableActions: 3, windowDays: 30 },
      actions: [{ object: 'incident', verb: 'assigned', n: 55, distinctActors: 4, distinctObjects: 30 }],
      // the step one run short of the threshold is not shown: its median is not credible
      stepTimes: [{ stepName: 'in_progress', n: SOGLIE.esecuzioniMinimePerPasso, medianHours: 5, p90Hours: 30, over48h: 2, discardedZeros: 1 }],
      pairs: [{ first: 'incident.assigned', then: 'incident.commented', n: 12, distinctObjects: 5, distinctActors: 3 }],
      aiUsage: [{ feature: 'triage', n: 9, distinctActors: 2 }],
      thresholds: {
        minWindowDays: SOGLIE.finestraMinimaGiorni,
        minOccurrences: SOGLIE.occorrenzeMinime,
        minRunsPerStep: SOGLIE.esecuzioniMinimePerPasso,
        pairMinOccurrences: SOGLIE.coppia.occorrenze,
        pairMinDistinctObjects: SOGLIE.coppia.oggettiDistinti,
        pairMinDistinctActors: SOGLIE.coppia.autoriDistinti,
        pairMaxMinutes: SOGLIE.coppia.minutiMassimi,
      },
    })
  })
})
