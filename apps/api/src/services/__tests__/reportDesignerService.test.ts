/**
 * «DESCRIVIMI IL REPORT E TE LO DISEGNO» (22 set 2026).
 *
 * ## Perché non c'erano
 * `services/reportDesignerService.ts` stava al 7,7%. Il filtro della proposta
 * (`lib/reportDesignProposal.ts`) ha i suoi test; questo file — che è la
 * PORTA, e decide cosa arriva al modello e cosa torna indietro — no.
 *
 * ## Le quattro regole che sono costate qualcosa
 *  1. **la chiave PRIMA del lavoro**: leggere tutto il metamodello per poi
 *     dire «AI non configurata» è il contrario del fail-fast;
 *  2. **quando non resta niente, si dice PERCHÉ**: prima si alzava un errore
 *     buttando gli scarti, cioè proprio l'informazione che il filtro esiste per
 *     produrre. Ora torna una proposta vuota con gli scarti, e chi guarda
 *     capisce se riscrivere la frase o creare quel tipo di CI;
 *  3. **l'ultima parola è della validazione vera**: se una proposta già
 *     filtrata non passa `validateReportSection` è un difetto NOSTRO, e si dice
 *     — non si passa al costruttore una sezione impossibile da salvare;
 *  4. **la proposta non scrive niente**: atterra nel wizard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

// L'id del modello NON si scrive qui: `aiModel.test.ts` e' un lint statico che
// pretende che viva solo in `config.ts`, e ha segnalato la prima versione di
// questo mock. Il valore finto non deve somigliare a un id vero.
vi.mock('../../lib/config.js', () => ({ config: { anthropicModel: 'modello-finto' } }))
vi.mock('../../lib/logger.js', () => {
  const noop = vi.fn()
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l }
  return { logger: l }
})

const assertAIFeature = vi.fn()
vi.mock('../../lib/aiSettings.js', () => ({ assertAIFeature: (...a: unknown[]) => assertAIFeature(...a) }))

const getAnthropic = vi.fn()
const leggiJSONDalModello = vi.fn()
const registraChiamataFallita = vi.fn()
const registraDurata = vi.fn()
const registraScarti = vi.fn()
vi.mock('../../lib/aiClient.js', () => ({
  getAnthropic: (...a: unknown[]) => getAnthropic(...a),
  leggiJSONDalModello: (...a: unknown[]) => leggiJSONDalModello(...a),
  bloccoDiContesto: vi.fn((c: unknown) => ({ type: 'text', text: JSON.stringify(c) })),
  registraChiamataFallita: (...a: unknown[]) => registraChiamataFallita(...a),
  registraDurata: (...a: unknown[]) => registraDurata(...a),
  registraScarti: (...a: unknown[]) => registraScarti(...a),
}))

const getNavigableEntities = vi.fn()
vi.mock('../../lib/navigableGraph.js', () => ({ getNavigableEntities: (...a: unknown[]) => getNavigableEntities(...a) }))

const getReportWhitelist = vi.fn()
vi.mock('../../lib/reportWhitelist.js', () => ({ getReportWhitelist: (...a: unknown[]) => getReportWhitelist(...a) }))

const validateReportSection = vi.fn()
vi.mock('../../lib/reportQueryBuilder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reportQueryBuilder.js')>()),
  validateReportSection: (...a: unknown[]) => validateReportSection(...a),
}))

const validaPropostaReport = vi.fn()
vi.mock('../../lib/reportDesignProposal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reportDesignProposal.js')>()),
  validaPropostaReport: (...a: unknown[]) => validaPropostaReport(...a),
  sezioneDaProposta: vi.fn((p: unknown) => ({ sezione: p })),
}))

vi.mock('../../lib/systemText.js', () => ({ modelLanguageFor: vi.fn(async () => 'Italian') }))

const { proponiSezioneDiReport, MAX_PROMPT_CHARS } = await import('../reportDesignerService.js')

const messagesCreate = vi.fn()

const ENTITA = [{
  entityType: 'incident', neo4jLabel: 'Incident', label: 'Incident', group: 'itsm',
  fields: [{ name: 'severity', label: 'Severità', fieldType: 'enum', enumValues: Array.from({ length: 30 }, (_, i) => `v${i}`) }],
  relations: [{ relationshipType: 'AFFECTS', targetEntityType: 'ci', label: 'tocca' }],
}]

const PROPOSTA = {
  title: 'Incident per team', chartType: 'bar', metric: 'count', metricField: null,
  groupByNodeId: 'n1', groupByField: 'team', groupByGranularity: null, limit: 20, sortDir: 'DESC',
  nodes: [{ id: 'n1' }], edges: [], why: 'perché', scartati: [], note: [],
}

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  assertAIFeature.mockResolvedValue(undefined)
  getAnthropic.mockReturnValue({ messages: { create: messagesCreate } })
  messagesCreate.mockResolvedValue({ content: [] })
  getNavigableEntities.mockResolvedValue(ENTITA)
  leggiJSONDalModello.mockReturnValue({ entita: 'incident' })
  validaPropostaReport.mockReturnValue(PROPOSTA)
  getReportWhitelist.mockResolvedValue({})
  validateReportSection.mockReturnValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════════
describe('le porte, nell\'ordine giusto', () => {
  it('l\'interruttore dell\'organizzazione viene per PRIMO', async () => {
    assertAIFeature.mockRejectedValue(new GraphQLError('spento'))
    expect((await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' }))).message).toBe('spento')
    expect(getNavigableEntities).not.toHaveBeenCalled()
  })

  it('una descrizione vuota, o lunga come un capitolato, si rifiuta', async () => {
    expect((await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: '   ' }))).message)
      .toContain('Empty description')
    expect((await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }))).message)
      .toContain('too long')
    expect(getNavigableEntities).not.toHaveBeenCalled()
  })

  it('la CHIAVE prima del lavoro: leggere il metamodello per poi dire «non configurata» è il contrario del fail-fast', async () => {
    getAnthropic.mockImplementation(() => { throw new GraphQLError('nessuna chiave') })
    expect((await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'gli incident per team' }))).message)
      .toBe('nessuna chiave')
    expect(getNavigableEntities).not.toHaveBeenCalled()
  })

  it('un\'organizzazione senza niente di raccontabile lo dice, invece di chiedere al modello', async () => {
    getNavigableEntities.mockResolvedValue([])
    const r = await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' }))
    expect(r.code).toBe('FAILED_PRECONDITION')
    expect(messagesCreate).not.toHaveBeenCalled()
  })
})

describe('quello che il modello vede', () => {
  it('le entità del CLIENTE, coi campi e le relazioni, e i vocabolari TRONCATI', async () => {
    await proponiSezioneDiReport({ tenantId: 't1', prompt: 'gli incident per team' })
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }>; messages: Array<{ content: string }> }
    const contesto = JSON.parse(arg.system.at(-1)!.text) as { entita: Array<{ campi: Array<{ valori?: string[] }> }> }
    // Una tendina con 200 valori non aiuta a scegliere un filtro; i valori
    // troncati restano validabili dal filtro, che li conosce tutti.
    expect(contesto.entita[0]!.campi[0]!.valori).toHaveLength(12)
    // La descrizione di chi chiede sta nel MESSAGGIO, non nel contesto in cache.
    expect(arg.messages[0]!.content).toBe('gli incident per team')
  })

  it('e la lingua in cui scrivere i testi la decide il tenant', async () => {
    await proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' })
    const arg = messagesCreate.mock.calls[0]![0] as { system: Array<{ text: string }> }
    expect(arg.system[1]!.text).toContain('Italian')
  })
})

describe('quando non resta niente, si dice PERCHÉ', () => {
  it('una proposta interamente scartata torna VUOTA con gli scarti, non come errore', async () => {
    validaPropostaReport.mockReturnValue(null)
    leggiJSONDalModello.mockReturnValue({ nodi: [{ entita: 'Fatture' }, { entita: 'Contratti' }] })
    const out = await proponiSezioneDiReport({ tenantId: 't1', prompt: 'le fatture per cliente' })
    expect(out.nodes).toEqual([])
    expect(out.title).toBe('')
    // Chi guarda capisce se riscrivere la frase o creare quel tipo.
    expect(out.scartati.map((s) => s.what)).toEqual(['Fatture', 'Contratti'])
    expect(out.scartati[0]!.key).toBe('reportProposal.discard.entityUnknown')
    expect(registraScarti).toHaveBeenCalledWith('reportDesigner', 2)
  })

  it('un\'entità nominata e ESISTENTE non finisce fra gli scarti', async () => {
    validaPropostaReport.mockReturnValue(null)
    leggiJSONDalModello.mockReturnValue({ nodi: [{ entita: 'incident' }, { entita: 'Fatture' }] })
    const out = await proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' })
    expect(out.scartati.map((s) => s.what)).toEqual(['Fatture'])
  })

  it('e la stessa entità nominata due volte si conta una volta sola', async () => {
    validaPropostaReport.mockReturnValue(null)
    leggiJSONDalModello.mockReturnValue({ nodi: [{ entita: 'Fatture' }, { entita: 'Fatture' }] })
    expect((await proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' })).scartati).toHaveLength(1)
  })
})

describe('l\'ultima parola è della validazione vera', () => {
  it('una proposta già filtrata che non passa è un difetto NOSTRO, e si dice', async () => {
    validateReportSection.mockImplementation(() => { throw new Error('groupByField non nella whitelist') })
    const r = await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' }))
    expect(r.code).toBe('INTERNAL_SERVER_ERROR')
    expect(r.message).toContain('would not be saveable')
    // I params ci vogliono: senza, i18next stampa «{{message}}» alla lettera.
    expect(r.message).toContain('groupByField non nella whitelist')
  })

  it('passata: la proposta esce col prompt di chi l\'ha chiesta, e non si è scritto niente', async () => {
    const out = await proponiSezioneDiReport({ tenantId: 't1', prompt: 'gli incident per team' })
    expect(out).toMatchObject({ ...PROPOSTA, prompt: 'gli incident per team' })
    expect(registraDurata).toHaveBeenCalledWith('reportDesigner', expect.any(Number))
  })
})

describe('la chiamata al modello che fallisce', () => {
  it('si conta e si rilancia: non si finge una proposta vuota', async () => {
    messagesCreate.mockRejectedValue(new Error('429 rate limited'))
    expect((await esito(() => proponiSezioneDiReport({ tenantId: 't1', prompt: 'x' }))).message)
      .toContain('429 rate limited')
    expect(registraChiamataFallita).toHaveBeenCalledWith('reportDesigner', expect.any(Error))
    expect(registraDurata).not.toHaveBeenCalled()
  })
})
