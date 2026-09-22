/**
 * The configuration analyst: the nightly pass that asks the model to write
 * the MISSING display labels of a customer's dictionaries.
 *
 * `configurationAssist.test.ts` pins the pure filters (`validaProposte`,
 * `soloIBuchi`). This file pins the door around them, where the cost and the
 * trust decisions live. If these regress, a customer sees:
 *  - money spent against their will: the feature switch, the monthly budget
 *    and the missing API key must stop the run BEFORE any model call;
 *  - the model rewriting words a person wrote: only the HOLES are sent to the
 *    model, never the labels that already exist;
 *  - labels proposed for the product's own vocabularies, or for dictionaries
 *    that by design carry no labels (workflow statuses), or for a corrupt
 *    document that has to be repaired by hand;
 *  - a failed model call that crashes the nightly job instead of producing
 *    no proposals and a counted failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The model id lives only in config.ts (static lint): the fake value must not look real.
const config = { anthropicApiKey: 'present', anthropicModel: 'fake-model' as string }
vi.mock('../config.js', () => ({ config }))
vi.mock('../logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const sessionRun = vi.fn()
const sessionClose = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ run: (...a: unknown[]) => sessionRun(...a), close: sessionClose }),
}))

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
vi.mock('../systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'English') }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))
vi.mock('../glossarioModello.js', () => ({ rigaDelGlossario: () => 'glossary' }))
vi.mock('../platformAnalyst.js', () => ({ tagliaAllaParola: (t: string, n: number) => t.slice(0, n) }))

const { candidati, analizzaConfigurazioneConIlModello, validaProposte, SOGLIE_ANALISTA, FUNZIONE } = await import('../configurationAnalyst.js')

/** A Neo4j result shaped like the one `candidati` reads. */
function records(rows: { name: string; values: string[] | null; raw: unknown }[]) {
  return {
    records: rows.map((r) => ({ get: (k: string) => (k === 'name' ? r.name : k === 'values' ? r.values : r.raw) })),
  }
}

const ACCESSO = { name: 'tipo_accesso', values: ['lettura', 'scrittura'], raw: JSON.stringify({ lettura: { it: 'Lettura', en: 'Read' } }) }

beforeEach(() => {
  vi.clearAllMocks()
  config.anthropicApiKey = 'present'
  aiFeatureEnabled.mockResolvedValue(true)
  puoSpendere.mockResolvedValue({ consentito: true })
})

describe('candidati — which dictionaries are worth asking about', () => {
  it('keeps only the tenant dictionaries that carry labels and still have holes', async () => {
    sessionRun.mockResolvedValueOnce(records([
      // Workflow statuses carry no labels by design: proposing some would be noise.
      { name: 'status_incident', values: ['new'], raw: null },
      { name: 'empty_one', values: null, raw: null },
      // A corrupt document is repaired by hand, never "completed" by the model.
      { name: 'corrupt', values: ['a'], raw: '{broken' },
      { name: 'complete', values: ['a'], raw: JSON.stringify({ a: { it: 'A', en: 'A' } }) },
      ACCESSO,
    ]))
    const out = await candidati('t1')
    expect(sessionRun.mock.calls[0]![1]).toEqual({ tenantId: 't1' })
    expect(out).toEqual([{ vocabulary: 'tipo_accesso', values: ['lettura', 'scrittura'], mancanti: { scrittura: ['en', 'it'] } }])
    expect(sessionClose).toHaveBeenCalled()
  })

  it('sends at most the per-run number of dictionaries, and closes the session even on failure', async () => {
    sessionRun.mockResolvedValueOnce(records(Array.from({ length: 12 }, (_, i) => ({ name: `v${String(i)}`, values: ['x'], raw: null }))))
    expect(await candidati('t1')).toHaveLength(SOGLIE_ANALISTA.vocabolariMassimi)

    sessionRun.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(candidati('t1')).rejects.toThrow('neo4j down')
    expect(sessionClose).toHaveBeenCalledTimes(2)
  })
})

describe('analizzaConfigurazioneConIlModello — the gates before spending', () => {
  it('a tenant that switched the feature off gets nothing and nothing is read', async () => {
    aiFeatureEnabled.mockResolvedValueOnce(false)
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(aiFeatureEnabled).toHaveBeenCalledWith('t1', FUNZIONE)
    expect(sessionRun).not.toHaveBeenCalled()
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('a spent monthly budget stops the run before the model is called', async () => {
    puoSpendere.mockResolvedValueOnce({ consentito: false, tetto: 10, usati: 10, limite: 'monthly' })
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(messagesCreate).not.toHaveBeenCalled()
  })

  it('without an API key on the platform nothing is attempted', async () => {
    config.anthropicApiKey = ''
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('when every dictionary is complete the model is not called at all', async () => {
    sessionRun.mockResolvedValueOnce(records([{ name: 'complete', values: ['a'], raw: JSON.stringify({ a: { it: 'A', en: 'A' } }) }]))
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(messagesCreate).not.toHaveBeenCalled()
  })
})

describe('analizzaConfigurazioneConIlModello — the call and its outcome', () => {
  it('sends only the holes, never the labels a person wrote, and turns the answer into a proposal', async () => {
    sessionRun.mockResolvedValueOnce(records([ACCESSO]))
    const risposta = { content: [], usage: {} }
    messagesCreate.mockResolvedValueOnce(risposta)
    leggiJSONDalModello.mockReturnValueOnce({
      vocabolari: [
        { vocabulary: 'tipo_accesso', rationale: 'Access levels.', labels: [{ value: 'scrittura', en: 'Write', it: 'Scrittura' }] },
        // Not a candidate: dropped and counted.
        { vocabulary: 'invented', rationale: 'x', labels: [] },
      ],
    })

    const proposte = await analizzaConfigurazioneConIlModello('t1')

    const params = messagesCreate.mock.calls[0]![0] as { model: string; messages: unknown[]; system: { text: string }[] }
    expect(params.model).toBe('fake-model')
    expect(params.system.map((s) => s.text).join('\n')).toContain('Write the rationale in English')
    const sent = JSON.stringify(params.messages)
    expect(sent).toContain('scrittura')
    // "Lettura"/"Read" were written by a person: the model must not even see them.
    expect(sent).not.toContain('Lettura')
    expect(sent).not.toContain('"Read"')

    expect(registraCosto).toHaveBeenCalledWith('t1', FUNZIONE, risposta)
    expect(registraDurata).toHaveBeenCalledWith(FUNZIONE, expect.any(Number))
    expect(registraScarti).toHaveBeenCalledWith(FUNZIONE, 1)
    expect(proposte).toHaveLength(1)
    expect(proposte[0]).toMatchObject({
      tenantId: 't1',
      kind: 'proposal.configMissingLabels',
      scope: 'labels:tipo_accesso',
      rationaleLanguage: 'en',
      action: { type: 'enum_value_labels.fill', params: { vocabulary: 'tipo_accesso', labels: { scrittura: { en: 'Write', it: 'Scrittura' } } } },
    })
  })

  it('a clean answer records zero discards', async () => {
    sessionRun.mockResolvedValueOnce(records([ACCESSO]))
    messagesCreate.mockResolvedValueOnce({ content: [] })
    leggiJSONDalModello.mockReturnValueOnce({ vocabolari: [] })
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(registraScarti).toHaveBeenCalledWith(FUNZIONE, 0)
  })

  it('a failed model call yields no proposals, is counted, and does not charge the tenant', async () => {
    sessionRun.mockResolvedValue(records([ACCESSO]))
    const err = new Error('overloaded')
    messagesCreate.mockRejectedValueOnce(err)
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(registraChiamataFallita).toHaveBeenCalledWith(FUNZIONE, err)
    expect(registraCosto).not.toHaveBeenCalled()

    // A non-Error rejection takes the same path.
    messagesCreate.mockRejectedValueOnce('timeout')
    expect(await analizzaConfigurazioneConIlModello('t1')).toEqual([])
    expect(registraChiamataFallita).toHaveBeenLastCalledWith(FUNZIONE, 'timeout')
  })
})

describe('validaProposte — malformed model output is dropped and counted, never repaired', () => {

  const cand = (vocabulary: string) => ({ vocabulary, values: ['a'], mancanti: { a: ['en' as const] } })
  const ctx = { tenantId: 't1', lingua: 'en', candidati: [cand('v1'), cand('v2'), cand('v3')] }
  const ok = (vocabulary: string) => ({ vocabulary, rationale: 'Why.', labels: [{ value: 'a', en: 'Alpha' }] })

  it('drops entries without a dictionary name, repeated dictionaries and anything over the per-run cap', () => {
    const { proposte, scartate, motivi } = validaProposte({
      vocabolari: [{ labels: [] }, ok('v1'), ok('v1'), ok('v2'), ok('v3')],
    }, ctx)
    expect(proposte.map((p) => p.params['vocabulary'])).toEqual(['v1', 'v2'])
    expect(scartate).toBe(3)
    expect(motivi).toEqual(['dictionary missing', 'dictionary already used in this run', 'over the per-run cap'])
  })

  it('ignores label rows without a value or without any language, and a dictionary left with nothing is dropped', () => {
    const { proposte, motivi } = validaProposte({
      vocabolari: [
        { vocabulary: 'v1', rationale: 'Why.', labels: [{ en: 'No value' }, { value: 'a' }] },
        { vocabulary: 'v2', rationale: 'Why.', labels: 'not a list' },
      ],
    }, ctx)
    expect(proposte).toEqual([])
    expect(motivi).toEqual(['v1: nothing left to fill', 'v2: nothing left to fill'])
  })

  it('a proposal without a rationale is dropped: the reviewer must be told why', () => {
    const { proposte, motivi } = validaProposte({
      vocabolari: [{ ...ok('v1'), rationale: '   ' }, { ...ok('v2'), rationale: 42 }],
    }, ctx)
    expect(proposte).toEqual([])
    expect(motivi).toEqual(['empty rationale', 'empty rationale'])
  })

  it('a null or shapeless answer yields nothing rather than throwing', () => {
    expect(validaProposte(null, ctx).proposte).toEqual([])
    expect(validaProposte({ vocabolari: 'x' }, ctx).scartate).toBe(0)
  })
})
