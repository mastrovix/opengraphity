/**
 * LE MATRICI DI DOMINIO DALL'INTERFACCIA (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/domainMatrix.ts` stava all'1%: una istruzione su novantacinque.
 * È la pagina da cui un amministratore decide le regole del SUO dominio —
 * priorità = impatto × urgenza, criticità del servizio → impatto, severità
 * dell'allarme → severità dell'incident — e la sua intestazione dichiara due
 * scelte precise:
 *
 *  1. la query non ritorna «le celle salvate» ma TUTTE le combinazioni che i
 *     vocabolari del cliente rendono possibili, con `value: null` dove la
 *     matrice non arriva: è il solo modo di far vedere il buco, che altrimenti
 *     si scopre quando un incident fallisce in faccia a chi non l'ha
 *     configurata;
 *  2. la mutation rifiuta una matrice INCOMPLETA, non solo una sbagliata.
 *
 * Nessuna delle due era verificata. Qui lo sono, insieme ai due residui di una
 * rinomina — la chiave fuori vocabolario (`stale`) e il valore fuori
 * vocabolario (`invalid`), che è quello che dal vivo faceva sembrare a posto
 * una matrice le cui celle puntavano tutte a un impatto che il Dizionario non
 * aveva più.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const runQueryOne = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const matrixInputValues = vi.fn()
const matrixOutputValues = vi.fn()
const loadDomainMatrix = vi.fn()
const domainVocabulary = vi.fn()
vi.mock('../../../lib/domainMatrix.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/domainMatrix.js')>()),
  matrixInputValues: (...a: unknown[]) => matrixInputValues(...a),
  matrixOutputValues: (...a: unknown[]) => matrixOutputValues(...a),
  loadDomainMatrix: (...a: unknown[]) => loadDomainMatrix(...a),
  domainVocabulary: (...a: unknown[]) => domainVocabulary(...a),
}))

const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const invalidateSchema = vi.fn()
vi.mock('../../../lib/schemaInvalidator.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSchema: (...a: unknown[]) => invalidateSchema(...a),
}))

vi.mock('../../../services/serviceImpact/incident.js', () => ({
  criticalServiceCriticalities: vi.fn(async () => ['high', 'critical']),
}))
const setPreApprovedChangeTypes = vi.fn()
vi.mock('../../../lib/changePolicy.js', () => ({
  preApprovedChangeTypes: vi.fn(async () => ['standard']),
  setPreApprovedChangeTypes: (...a: unknown[]) => setPreApprovedChangeTypes(...a),
  changeTypeVocabulary: vi.fn(async () => ['standard', 'normal', 'emergency']),
}))
const setRiskBandThresholds = vi.fn()
vi.mock('../../../lib/riskBands.js', () => ({
  riskBandThresholds: vi.fn(async () => [{ band: 'low', upTo: 30 }]),
  setRiskBandThresholds: (...a: unknown[]) => setRiskBandThresholds(...a),
}))
const setChangeEnvironmentWeight = vi.fn()
vi.mock('../../../lib/changeEnvironmentWeight.js', () => ({
  changeEnvironmentWeight: vi.fn(async () => ({ weight: 1.5, isDefault: true })),
  setChangeEnvironmentWeight: (...a: unknown[]) => setChangeEnvironmentWeight(...a),
}))
const setImpactAnalysisWeights = vi.fn()
vi.mock('../../../lib/impactWeights.js', () => ({
  impactAnalysisWeights: vi.fn(async () => ({ direct: 3, indirect: 1, isDefault: true })),
  setImpactAnalysisWeights: (...a: unknown[]) => setImpactAnalysisWeights(...a),
}))
vi.mock('../../../lib/configurationIssues.js', () => ({
  configurationIssues: vi.fn(async () => [{ issue: 'no_team', params: { a: '1' }, gaps: [] }]),
}))

const { domainMatrixResolvers, cartesianKeys } = await import('../domainMatrix.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'admin', permissions: new Set() } as never

/** Impatto × urgenza, con i vocabolari del cliente. */
function vocabolariPriority(entries: Record<string, string>, over: Record<string, unknown> = {}) {
  matrixInputValues.mockResolvedValue([['low', 'high'], ['low', 'high']])
  matrixOutputValues.mockResolvedValue(['p3', 'p1'])
  loadDomainMatrix.mockResolvedValue({ entries, isDefault: false, updatedAt: 'ieri', ...over })
}

const COMPLETA = { 'low|low': 'p3', 'low|high': 'p3', 'high|low': 'p3', 'high|high': 'p1' }

async function esito(fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await fn(); return { code: 'NESSUN RIFIUTO', message: '' } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message }
  }
}

const aggiorna = (kind: string, entries: Array<{ key: string; value: string }>) =>
  domainMatrixResolvers.Mutation.updateDomainMatrix(null, { kind, entries }, ctx)

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  runQueryOne.mockResolvedValue({ kind: 'priority' })
  vocabolariPriority(COMPLETA)
  setPreApprovedChangeTypes.mockResolvedValue(['standard', 'normal'])
  setRiskBandThresholds.mockResolvedValue([{ band: 'low', upTo: 40 }])
  setChangeEnvironmentWeight.mockResolvedValue({ weight: 2, isDefault: false })
  setImpactAnalysisWeights.mockResolvedValue({ direct: 5, indirect: 2, isDefault: false })
  domainVocabulary.mockResolvedValue(['low', 'high'])
})

// ══════════════════════════════════════════════════════════════════════════════
describe('cartesianKeys', () => {
  it('tutte le combinazioni, nell\'ordine degli ingressi', () => {
    expect(cartesianKeys([['a', 'b'], ['x', 'y']])).toEqual([['a', 'x'], ['a', 'y'], ['b', 'x'], ['b', 'y']])
  })

  it('un solo ingresso, e nessun ingresso', () => {
    expect(cartesianKeys([['a', 'b']])).toEqual([['a'], ['b']])
    expect(cartesianKeys([])).toEqual([[]])
  })

  it('un vocabolario vuoto azzera tutto: non ci sono combinazioni possibili', () => {
    expect(cartesianKeys([['a'], []])).toEqual([])
  })
})

describe('la lettura fa vedere il BUCO', () => {
  it('escono tutte le combinazioni possibili, non solo quelle salvate', async () => {
    vocabolariPriority({ 'low|low': 'p3' })
    const out = await domainMatrixResolvers.Query.domainMatrices(null, null, ctx) as Array<Record<string, unknown>>
    const priority = out.find((m) => m['kind'] === 'priority')!
    expect((priority['cells'] as unknown[]).length).toBe(4)
    expect(priority['missing']).toEqual(['low|high', 'high|low', 'high|high'])
  })

  it('una chiave rimasta fuori vocabolario si MOSTRA: è il residuo di una rinomina', async () => {
    vocabolariPriority({ ...COMPLETA, 'medio|low': 'p3' })
    const out = await domainMatrixResolvers.Query.domainMatrices(null, null, ctx) as Array<Record<string, unknown>>
    const priority = out.find((m) => m['kind'] === 'priority')!
    expect(priority['stale']).toEqual(['medio|low'])
    // e la cella c'è comunque, col suo valore: vederla è come si capisce cosa è successo
    expect((priority['cells'] as Array<Record<string, unknown>>).find((c) => c['key'] === 'medio|low'))
      .toMatchObject({ value: 'p3', inputs: ['medio', 'low'] })
  })

  it('l\'ALTRA metà della rinomina: chiave buona, VALORE non più nel vocabolario', async () => {
    vocabolariPriority({ ...COMPLETA, 'high|high': 'priorita-che-non-esiste-piu' })
    const out = await domainMatrixResolvers.Query.domainMatrices(null, null, ctx) as Array<Record<string, unknown>>
    const priority = out.find((m) => m['kind'] === 'priority')!
    expect(priority['invalid']).toEqual(['high|high'])
    // La matrice SEMBRAVA a posto: nessun buco, nessuna chiave stale.
    expect(priority['missing']).toEqual([])
    expect(priority['stale']).toEqual([])
  })

  it('«di fabbrica» si dice: il cliente sa se quella matrice l\'ha decisa lui', async () => {
    vocabolariPriority(COMPLETA, { isDefault: true, updatedAt: null })
    const out = await domainMatrixResolvers.Query.domainMatrices(null, null, ctx) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ isDefault: true, updatedAt: null })
  })
})

describe('la scrittura rifiuta una matrice INCOMPLETA, non solo una sbagliata', () => {
  it('una matrice che non esiste', async () => {
    const r = await esito(() => aggiorna('inventata', []))
    expect(r.message).toContain('does not exist')
    expect(r.message).toContain('priority')
  })

  it('una chiave con il numero sbagliato di dimensioni', async () => {
    expect((await esito(() => aggiorna('priority', [{ key: 'low', value: 'p3' }]))).message)
      .toContain('has 1 dimensions, 2 expected')
  })

  it('un valore d\'ingresso fuori dal Dizionario DI QUESTO cliente', async () => {
    const r = await esito(() => aggiorna('priority', [{ key: 'medio|low', value: 'p3' }]))
    expect(r.message).toContain('"medio" is not in the "impact" dictionary')
    expect(r.message).toContain('Allowed: low, high')
  })

  it('un valore d\'uscita fuori dal Dizionario', async () => {
    expect((await esito(() => aggiorna('priority', [{ key: 'low|low', value: 'p9' }]))).message)
      .toContain('"p9" is not in this tenant\'s "priority" dictionary')
  })

  it('una cella ripetuta', async () => {
    const doppia = [{ key: 'low|low', value: 'p3' }, { key: 'low|low', value: 'p1' }]
    expect((await esito(() => aggiorna('priority', doppia))).message).toContain('is repeated')
  })

  it('un BUCO: si rifiuta, si dice quanti e quali, e non si scrive niente', async () => {
    const r = await esito(() => aggiorna('priority', [{ key: 'low|low', value: 'p3' }]))
    expect(r.message).toContain('is incomplete: 3 combination(s) with no value')
    expect(r.message).toContain('low|high')
    expect(r.message).toContain('becomes an error when it is needed')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('completa: si scrive, si tira la leva della cache e si registra', async () => {
    const complete = Object.entries(COMPLETA).map(([key, value]) => ({ key, value }))
    await aggiorna('priority', complete)
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('MERGE (m:DomainMatrix {tenant_id: $tenantId, kind: $kind})')
    expect(JSON.parse(String(params['entries']))).toEqual(COMPLETA)
    expect(params['userId']).toBe('u1')
    // `seeded = false`: da qui in poi la matrice è del cliente, non di fabbrica.
    expect(cypher).toContain('m.seeded = false')
    // La leva UNICA, non quella del solo processo: senza, una matrice corretta
    // dalla pagina restava vecchia nell'events-worker per sempre.
    expect(invalidateSchema).toHaveBeenCalledWith('t1')
    expect(audit.mock.calls[0]![1]).toBe('domain_matrix_updated')
  })

  it('se la scrittura non tocca nessun nodo è un errore forte, non un successo', async () => {
    runQueryOne.mockResolvedValue(null)
    const complete = Object.entries(COMPLETA).map(([key, value]) => ({ key, value }))
    expect((await esito(() => aggiorna('priority', complete))).message).toContain('the write touched no node')
    expect(invalidateSchema).not.toHaveBeenCalled()
  })
})

describe('le regole che stanno sulla stessa pagina ma non sono matrici', () => {
  it('i tipi pre-approvati escono col loro vocabolario, per sapere fra cosa si sceglie', async () => {
    const out = await domainMatrixResolvers.Query.preApprovedChangeTypes(null, null, ctx) as Record<string, unknown>
    expect(out).toEqual({ types: ['standard'], vocabulary: ['standard', 'normal', 'emergency'] })
  })

  it('salvandoli, la leva la tira la libreria (la chiamano anche le migrazioni) e qui si registra', async () => {
    const out = await domainMatrixResolvers.Mutation.updatePreApprovedChangeTypes(
      null, { types: ['standard', 'normal'] }, ctx) as Record<string, unknown>
    expect(setPreApprovedChangeTypes).toHaveBeenCalledWith('t1', ['standard', 'normal'])
    expect(out['types']).toEqual(['standard', 'normal'])
    expect(audit.mock.calls[0]![1]).toBe('change.pre_approved_types.updated')
  })

  it('le soglie di rischio dicono se il cliente le ha DICHIARATE o sta usando quelle di fabbrica', async () => {
    runQueryOne.mockResolvedValue({ declared: false })
    expect(((await domainMatrixResolvers.Query.riskBandThresholds(null, null, ctx)) as Record<string, unknown>)['isDefault']).toBe(true)
    runQueryOne.mockResolvedValue({ declared: true })
    expect(((await domainMatrixResolvers.Query.riskBandThresholds(null, null, ctx)) as Record<string, unknown>)['isDefault']).toBe(false)
  })

  it('salvate, non sono più di fabbrica', async () => {
    const out = await domainMatrixResolvers.Mutation.updateRiskBandThresholds(
      null, { entries: [{ band: 'low', upTo: 40 }] }, ctx) as Record<string, unknown>
    expect(out['isDefault']).toBe(false)
    expect(audit.mock.calls[0]![1]).toBe('change.risk_band_thresholds.updated')
  })

  it('il peso dell\'ambiente e quelli dell\'analisi d\'impatto registrano il PRIMA e il DOPO', async () => {
    await domainMatrixResolvers.Mutation.updateChangeEnvironmentWeight(null, { weight: 2 }, ctx)
    expect(audit.mock.calls[0]![4]).toEqual({ from: 1.5, to: 2 })

    audit.mockClear()
    await domainMatrixResolvers.Mutation.updateImpactAnalysisWeights(null, { input: { direct: 5, indirect: 2 } }, ctx)
    // `isDefault` non è un peso: fuori dal registro.
    expect(audit.mock.calls[0]![4]).toEqual({ from: { direct: 3, indirect: 1 }, to: { direct: 5, indirect: 2 } })
  })

  it('i problemi di configurazione escono come DATO: la frase non si compone qui', async () => {
    const out = await domainMatrixResolvers.Query.configurationIssues(null, null, ctx) as Array<Record<string, unknown>>
    expect(out[0]!['params']).toEqual([{ name: 'a', value: '1' }])
    expect(out[0]!['gaps']).toEqual([])
  })
})
