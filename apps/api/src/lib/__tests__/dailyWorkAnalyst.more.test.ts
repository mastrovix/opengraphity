/**
 * The daily-work analyst's door: when the model is called, with what, and
 * what happens to its answer (lib/dailyWorkAnalyst.ts, `analizzaLavoroQuotidiano`).
 *
 * `dailyWorkAnalyst.test.ts` pins the pure parts (candidates, validation).
 * This file pins the run around them. If these regress, a customer sees:
 *  - money spent against their will: the feature switch, the monthly budget
 *    and a missing API key must stop the run BEFORE any model call or query;
 *  - a model called on too little data (fewer than two candidates);
 *  - ticket text reaching the model: only aggregate rows and action counts
 *    may be sent, and action counts only as context (capped at 25);
 *  - a failed model call crashing the nightly job instead of producing no
 *    proposals and a counted failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The model id lives only in config.ts (static lint): the fake value must not look real.
const config = { anthropicApiKey: 'present' as string | undefined, anthropicModel: 'fake-model' }
vi.mock('../config.js', () => ({ config }))
vi.mock('../logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))

const messagesCreate = vi.fn()
const leggiJSONDalModello = vi.fn()
const registraChiamataFallita = vi.fn()
const registraDurata = vi.fn()
const registraScarti = vi.fn()
vi.mock('../aiClient.js', () => ({
  getAnthropic: () => ({ messages: { create: (...a: unknown[]) => messagesCreate(...a) } }),
  leggiJSONDalModello: (...a: unknown[]) => leggiJSONDalModello(...a),
  registraChiamataFallita: (...a: unknown[]) => registraChiamataFallita(...a),
  registraDurata: (...a: unknown[]) => registraDurata(...a),
  registraScarti: (...a: unknown[]) => registraScarti(...a),
}))
const aiFeatureEnabled = vi.fn()
vi.mock('../aiSettings.js', () => ({ aiFeatureEnabled: (...a: unknown[]) => aiFeatureEnabled(...a) }))
const registraCosto = vi.fn()
vi.mock('../aiCostLedger.js', () => ({ registraCosto: (...a: unknown[]) => registraCosto(...a) }))
const puoSpendere = vi.fn()
vi.mock('../aiBudget.js', () => ({ puoSpendere: (...a: unknown[]) => puoSpendere(...a) }))
vi.mock('../systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'Italian') }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))
vi.mock('../glossarioModello.js', () => ({ rigaDelGlossario: () => 'glossary' }))
vi.mock('../platformAnalyst.js', () => ({ tagliaAllaParola: (t: string, n: number) => t.slice(0, n) }))

const coppieRipetute = vi.fn()
const tempiNeiPassi = vi.fn()
const azioniUmane = vi.fn()
vi.mock('../dailyWorkAggregates.js', async (importOriginal) => {
  // SOGLIE stays real: the analyst's step filter must use the same thresholds as the queries.
  const real = await importOriginal<typeof import('../dailyWorkAggregates.js')>()
  return { ...real, coppieRipetute, tempiNeiPassi, azioniUmane }
})

const { analizzaLavoroQuotidiano, candidatiDa, validaProposte, FUNZIONE } = await import('../dailyWorkAnalyst.js')

const PAIR = { prima: 'incident.assigned', poi: 'incident.commented', n: 22, oggettiDistinti: 6, autoriDistinti: 3 }
const PAIR2 = { prima: 'change.created', poi: 'change.assessed', n: 14, oggettiDistinti: 5, autoriDistinti: 2 }
const MODEL_REPLY = { stop_reason: 'end_turn', content: [], usage: {} }

beforeEach(() => {
  vi.clearAllMocks()
  config.anthropicApiKey = 'present'
  aiFeatureEnabled.mockResolvedValue(true)
  puoSpendere.mockResolvedValue({ consentito: true })
  coppieRipetute.mockResolvedValue([PAIR, PAIR2])
  tempiNeiPassi.mockResolvedValue([])
  azioniUmane.mockResolvedValue([])
  messagesCreate.mockResolvedValue(MODEL_REPLY)
  leggiJSONDalModello.mockReturnValue({ proposte: [] })
})

describe('the gates before any model call', () => {
  it('a switched-off feature reads nothing and calls nothing', async () => {
    aiFeatureEnabled.mockResolvedValue(false)
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    expect(aiFeatureEnabled).toHaveBeenCalledWith('t1', FUNZIONE)
    expect(puoSpendere).not.toHaveBeenCalled()
    expect(coppieRipetute).not.toHaveBeenCalled()
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('a reached monthly budget stops the run before the model', async () => {
    puoSpendere.mockResolvedValue({ consentito: false, tetto: 10, usati: 10, limite: 10 })
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('no API key on the platform: no analysis, no error', async () => {
    config.anthropicApiKey = undefined
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    expect(coppieRipetute).not.toHaveBeenCalled()
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('fewer than two candidates: the model is not called', async () => {
    coppieRipetute.mockResolvedValue([PAIR])
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    // The aggregates are read over a 30-day window for this tenant.
    expect(coppieRipetute).toHaveBeenCalledWith('t1', 30)
    expect(tempiNeiPassi).toHaveBeenCalledWith('t1', 30)
    expect(azioniUmane).toHaveBeenCalledWith('t1', 30)
    expect(messagesCreate).not.toHaveBeenCalled()
  })
})

describe('the model call', () => {
  it('sends only aggregate rows and at most 25 action counts, in the tenant language', async () => {
    azioniUmane.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ action: `a${String(i)}`, n: 40 - i })))
    await analizzaLavoroQuotidiano('t1')
    const req = messagesCreate.mock.calls[0]![0] as { model: string; system: { text: string }[]; messages: { content: unknown }[] }
    expect(req.model).toBe('fake-model')
    expect(req.system.map((s) => s.text)).toContain('Write the rationale in Italian.')
    const payload = JSON.stringify(req.messages)
    expect(payload).toContain('coppia:incident.assigned>incident.commented')
    expect(payload).toContain('coppia:change.created>change.assessed')
    expect(payload).toContain('a24')
    // Context only, capped: the 26th row never reaches the model.
    expect(payload).not.toContain('a25')
  })

  it('a failed call is counted and yields no proposals instead of crashing the job', async () => {
    const boom = new Error('overloaded')
    messagesCreate.mockRejectedValue(boom)
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    expect(registraChiamataFallita).toHaveBeenCalledWith(FUNZIONE, boom)
    expect(registraCosto).not.toHaveBeenCalled()
  })

  it('a non-Error rejection is handled the same way', async () => {
    messagesCreate.mockRejectedValue('socket hang up')
    expect(await analizzaLavoroQuotidiano('t1')).toEqual([])
    expect(registraChiamataFallita).toHaveBeenCalledWith(FUNZIONE, 'socket hang up')
  })

  it('records duration and cost, then turns the valid answers into proposals in the tenant language', async () => {
    leggiJSONDalModello.mockReturnValue({ proposte: [
      { kind: 'proposal.dailyWorkPairToAutomation', riferimento: 'coppia:incident.assigned>incident.commented', rationale: 'Sempre insieme.' },
      { kind: 'proposal.dailyWorkPairToAutomation', riferimento: 'coppia:made>up', rationale: 'x' },
    ] })
    const out = await analizzaLavoroQuotidiano('t1')
    expect(registraDurata).toHaveBeenCalledWith(FUNZIONE, expect.any(Number))
    expect(registraCosto).toHaveBeenCalledWith('t1', FUNZIONE, MODEL_REPLY)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ tenantId: 't1', rationaleLanguage: 'it', params: { count: '22' } })
    // The invented reference is dropped and counted, not silently ignored.
    expect(registraScarti).toHaveBeenCalledWith(FUNZIONE, 1)
  })

  it('a clean answer records zero discards', async () => {
    await analizzaLavoroQuotidiano('t1')
    expect(registraScarti).toHaveBeenCalledWith(FUNZIONE, 0)
  })
})

describe('edge cases of the pure parts', () => {
  const step = (stepName: string, medianaOre: number) => ({ stepName, n: 40, medianaOre, p90Ore: medianaOre * 2, oltre48h: 0, zeriScartati: 0 })

  it('a median of medians at zero proposes nothing (no ratio can be computed)', () => {
    expect(candidatiDa([], [step('a', 0), step('b', 0), step('c', 5)], 30)).toEqual([])
  })

  it('a step close to the others is neither slow nor instant', () => {
    expect(candidatiDa([], [step('a', 10), step('b', 12), step('c', 14)], 30)).toEqual([])
  })

  it('an entry without a string reference is dropped with its own reason', () => {
    const candidati = candidatiDa([PAIR], [], 30)
    const { proposte, motivi } = validaProposte({ proposte: [{ kind: 'proposal.dailyWorkPairToAutomation', riferimento: 7, rationale: 'x' }] },
      { tenantId: 't1', candidati, lingua: 'en' })
    expect(proposte).toEqual([])
    expect(motivi).toEqual(['reference missing'])
  })

  it('a non-string rationale counts as empty', () => {
    const candidati = candidatiDa([PAIR], [], 30)
    const { motivi } = validaProposte({ proposte: [{ kind: candidati[0]!.genere, riferimento: candidati[0]!.id, rationale: 42 }] },
      { tenantId: 't1', candidati, lingua: 'en' })
    expect(motivi).toEqual(['empty rationale'])
  })
})
