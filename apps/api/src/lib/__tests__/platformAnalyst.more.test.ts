/**
 * The platform analyst's doors: when the model is called, what it is sent, and
 * what happens to its answer.
 *
 * `platformAnalystInjection.test.ts` pins the validation against a hostile
 * answer. This file pins the run around it. If these regress:
 *  - money is spent against the owner's will: the feature switch, the tenant,
 *    the monthly budget, the missing key and the minimum number of signatures
 *    must each stop the run BEFORE any model call;
 *  - the nightly job fails for a tenant that is merely configured off, or for
 *    a model outage, instead of producing no proposals;
 *  - the cost of a call whose answer is unusable is never recorded, and the
 *    monthly ledger reads less than what was paid;
 *  - the model receives more than the scrubbed projection (tenant, raw message).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FirmaAggregata } from '../serverLogEvents.js'

// The model id lives only in config.ts (static lint): the fake value must not look real.
const config = vi.hoisted(() => ({ anthropicApiKey: 'present' as string, anthropicModel: 'fake-model' }))
vi.mock('../config.js', () => ({ config }))
vi.mock('../logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const h = vi.hoisted(() => ({
  sessionRun: vi.fn(),
  sessionClose: vi.fn(async () => undefined),
  messagesCreate: vi.fn(),
  leggiJSONDalModello: vi.fn(),
  registraChiamataFallita: vi.fn(),
  registraDurata: vi.fn(),
  registraScarti: vi.fn(),
  aiFeatureEnabled: vi.fn(),
  registraCosto: vi.fn(),
  puoSpendere: vi.fn(),
  aggregatiPerFirma: vi.fn(),
}))

vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ run: h.sessionRun, close: h.sessionClose }) }))
vi.mock('../aiClient.js', () => ({
  getAnthropic: () => ({ messages: { create: h.messagesCreate } }),
  leggiJSONDalModello: h.leggiJSONDalModello,
  registraChiamataFallita: h.registraChiamataFallita,
  registraDurata: h.registraDurata,
  registraScarti: h.registraScarti,
}))
vi.mock('../aiSettings.js', () => ({ aiFeatureEnabled: h.aiFeatureEnabled }))
vi.mock('../aiCostLedger.js', () => ({ registraCosto: h.registraCosto }))
vi.mock('../aiBudget.js', () => ({ puoSpendere: h.puoSpendere }))
vi.mock('../systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'Italian') }))
vi.mock('../tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))
vi.mock('../glossarioModello.js', () => ({ rigaDelGlossario: () => 'glossary line' }))
vi.mock('../serverLogEvents.js', () => ({ TENANT_DI_PIATTAFORMA: 'opengrafo', aggregatiPerFirma: h.aggregatiPerFirma }))

const {
  analizzaPiattaforma, righePerIlModello, tagliaAllaParola, validaProposte, SOGLIE_ANALISTA, FUNZIONE,
} = await import('../platformAnalyst.js')

const firma = (i: number, extra: Partial<FirmaAggregata> = {}): FirmaAggregata => ({
  fingerprint: `f-${String(i)}`, service: 'opengrafo-api', module: 'bullmq', level: 'error',
  template: `[bullmq] error ${String(i)}`, stackHead: 'at secret (/app/dist/x.js)',
  occorrenzeOggi: 1, occorrenzeTotali: 10 + i, giorniDistinti: 2,
  ultimoGiorno: '2026-09-20', ultimoIstante: '2026-09-20T13:00:00.000Z',
  ...extra,
})
const cinqueFirme = () => Array.from({ length: SOGLIE_ANALISTA.firmeMinime }, (_, i) => firma(i))

beforeEach(() => {
  vi.clearAllMocks()
  config.anthropicApiKey = 'present'
  h.aiFeatureEnabled.mockResolvedValue(true)
  h.puoSpendere.mockResolvedValue({ consentito: true })
  h.aggregatiPerFirma.mockResolvedValue(cinqueFirme())
  h.sessionRun.mockResolvedValue({ records: [{ get: () => 'opengrafo-api' }] })
  h.messagesCreate.mockResolvedValue({ id: 'msg', content: [] })
  h.leggiJSONDalModello.mockReturnValue({ proposte: [] })
})

describe('analizzaPiattaforma — the doors before the model', () => {
  it('any tenant but the platform one: nothing, and nothing is read', async () => {
    expect(await analizzaPiattaforma('c-one')).toEqual([])
    expect(h.aiFeatureEnabled).not.toHaveBeenCalled()
    expect(h.messagesCreate).not.toHaveBeenCalled()
  })

  it('switched off: an empty list, not an error that fails the nightly run', async () => {
    h.aiFeatureEnabled.mockResolvedValue(false)
    await expect(analizzaPiattaforma('opengrafo')).resolves.toEqual([])
    expect(h.aiFeatureEnabled).toHaveBeenCalledWith('opengrafo', FUNZIONE)
    expect(h.messagesCreate).not.toHaveBeenCalled()
  })

  it('the monthly budget is checked BEFORE the call', async () => {
    h.puoSpendere.mockResolvedValue({ consentito: false, tetto: 'tenant', usati: 10, limite: 5 })
    expect(await analizzaPiattaforma('opengrafo')).toEqual([])
    expect(h.messagesCreate).not.toHaveBeenCalled()
  })

  it('no API key on the platform: nothing, silently', async () => {
    config.anthropicApiKey = ''
    expect(await analizzaPiattaforma('opengrafo')).toEqual([])
    expect(h.aggregatiPerFirma).not.toHaveBeenCalled()
  })

  it('too few signatures: the model is not called (it would invent)', async () => {
    h.aggregatiPerFirma.mockResolvedValue(cinqueFirme().slice(1))
    expect(await analizzaPiattaforma('opengrafo')).toEqual([])
    expect(h.messagesCreate).not.toHaveBeenCalled()
  })
})

describe('analizzaPiattaforma — the call and its answer', () => {
  it('turns a valid answer into proposals, in the tenant language, and records the cost first', async () => {
    h.leggiJSONDalModello.mockReturnValue({ proposte: [
      { kind: 'proposal.platformRecurringError', fingerprint: 'f-0', service: 'opengrafo-api', module: 'bullmq', rationale: 'Look at the queue.' },
      { kind: 'proposal.nope', fingerprint: 'f-1', service: 'opengrafo-api', module: 'bullmq', rationale: 'x' },
    ] })
    const out = await analizzaPiattaforma('opengrafo')

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ tenantId: 'opengrafo', area: 'platform', scope: 'f-0', action: null, rationaleLanguage: 'it' })
    const req = h.messagesCreate.mock.calls[0]![0] as { model: string; system: { text: string }[]; messages: { content: { text: string }[] }[] }
    expect(req.model).toBe('fake-model')
    // The rationale is asked in the tenant's language, and the glossary is always there.
    expect(req.system.map((b) => b.text)).toEqual(expect.arrayContaining(['Write the rationale in Italian.', 'glossary line']))
    // The data travels as a user message, fenced as untrusted: never among system blocks.
    const dati = req.messages[0]!.content.map((b) => b.text).join('\n')
    expect(dati).toContain('f-0')
    expect(dati, 'the stack head is not part of the projection').not.toContain('/app/dist')
    expect(h.registraCosto).toHaveBeenCalledWith('opengrafo', FUNZIONE, { id: 'msg', content: [] })
    expect(h.registraDurata).toHaveBeenCalledWith(FUNZIONE, expect.any(Number))
    expect(h.registraScarti).toHaveBeenCalledWith(FUNZIONE, 1)
    // The CI names are read from the platform tenant only.
    expect(h.sessionRun.mock.calls[0]![1]).toEqual({ tenantId: 'opengrafo' })
    expect(h.sessionClose).toHaveBeenCalled()
  })

  it('an answer with nothing to discard reports zero discards', async () => {
    expect(await analizzaPiattaforma('opengrafo')).toEqual([])
    expect(h.registraScarti).toHaveBeenCalledWith(FUNZIONE, 0)
    // The cost is recorded even when nothing comes out of it: the tokens were paid.
    expect(h.registraCosto).toHaveBeenCalledTimes(1)
  })

  it('a failed model call is counted and yields nothing, without throwing', async () => {
    h.messagesCreate.mockRejectedValue(new Error('overloaded'))
    await expect(analizzaPiattaforma('opengrafo')).resolves.toEqual([])
    expect(h.registraChiamataFallita).toHaveBeenCalledWith(FUNZIONE, expect.any(Error))
    expect(h.registraCosto).not.toHaveBeenCalled()
  })

  it('a non-Error rejection is handled the same way', async () => {
    h.messagesCreate.mockRejectedValue('boom')
    await expect(analizzaPiattaforma('opengrafo')).resolves.toEqual([])
    expect(h.registraChiamataFallita).toHaveBeenCalledWith(FUNZIONE, 'boom')
  })

  it('closes the CI read session even when it fails', async () => {
    h.sessionRun.mockRejectedValue(new Error('neo4j down'))
    await expect(analizzaPiattaforma('opengrafo')).rejects.toThrow('neo4j down')
    expect(h.sessionClose).toHaveBeenCalled()
  })
})

describe('righePerIlModello', () => {
  it('sends only the projection, and at most the configured number of signatures', () => {
    const molte = Array.from({ length: SOGLIE_ANALISTA.firmeMassime + 5 }, (_, i) => firma(i))
    const righe = righePerIlModello(molte)
    expect(righe).toHaveLength(SOGLIE_ANALISTA.firmeMassime)
    expect(righe[0]).toEqual({
      fingerprint: 'f-0', service: 'opengrafo-api', module: 'bullmq', template: '[bullmq] error 0',
      occurrences: 10, distinctDays: 2, lastDay: '2026-09-20',
    })
  })
})

describe('tagliaAllaParola', () => {
  it('leaves a short text alone', () => {
    expect(tagliaAllaParola('short', 10)).toBe('short')
  })

  it('a text without spaces near the end (a payload) is cut where it falls, still marked', () => {
    expect(tagliaAllaParola('a '.concat('x'.repeat(50)), 20)).toBe(`a ${'x'.repeat(18)}…`)
  })
})

describe('validaProposte — the remaining discard reasons', () => {
  const ctx = { tenantId: 'opengrafo', firme: [firma(0)], servizi: new Set(['opengrafo-api']), lingua: 'en' }
  const voce = (extra: Record<string, unknown>) => ({ proposte: [{
    kind: 'proposal.platformErrorSpike', fingerprint: 'f-0', service: 'opengrafo-api', module: 'bullmq', rationale: 'why', ...extra,
  }] })

  it.each([
    [{ fingerprint: 42 }, 'fingerprint missing'],
    [{ module: 'redis' }, 'module does not match the fingerprint'],
    [{ module: undefined }, 'module does not match the fingerprint'],
    [{ rationale: '   ' }, 'empty rationale'],
    [{ rationale: 7 }, 'empty rationale'],
  ])('discards %o with reason "%s"', (extra, motivo) => {
    const r = validaProposte(voce(extra), ctx)
    expect(r.proposte).toEqual([])
    expect(r.motivi).toEqual([motivo])
  })

  it('discards over the per-run cap even with distinct signatures', () => {
    const firme = Array.from({ length: SOGLIE_ANALISTA.proposteMassime + 1 }, (_, i) => firma(i))
    const grezzo = { proposte: firme.map((f) => ({
      kind: 'proposal.platformSharedFault', fingerprint: f.fingerprint, service: f.service, module: f.module, rationale: 'r',
    })) }
    const r = validaProposte(grezzo, { ...ctx, firme })
    expect(r.proposte).toHaveLength(SOGLIE_ANALISTA.proposteMassime)
    expect(r.motivi).toEqual(['over the per-run cap'])
  })
})
