/**
 * INCIDENT SIMILI E KB SUGGERITA (22 set 2026).
 *
 * ## Perché non c'erano
 * `resolvers/similarity.ts` stava al 4,5%. Il suo contratto sta scritto in
 * testa al file — «Truth-telling contract: `ready: false` quando l'embedding
 * non è ancora stato calcolato (pipeline asincrona), MAI confuso con "nessun
 * risultato"» — e a quel contratto se n'è aggiunto un terzo caso: gli
 * embedding SPENTI dall'organizzazione, che non sono «non ancora pronto».
 *
 * Tre stati diversi che escono tutti come una lista vuota, e che per chi
 * guarda vogliono dire tre cose opposte:
 *
 *   ready: false, disabled: true   → l'organizzazione li ha spenti
 *   ready: false, disabled: false  → non ancora calcolato, riprova fra poco
 *   ready: true,  items: []        → calcolato, e davvero non somiglia a niente
 *
 * Erano prosa. Qui sono tre test.
 *
 * D15 (tour of 23 Sep 2026): «not computed yet» was true only if someone had
 * queued the computation. On imported or old incidents nobody had, and the
 * panel waited for ever. Now the question queues it, and a computation that
 * failed is a fourth state: `failure` with the reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const runQueryOne = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))

const vectorSearchForTenant = vi.fn()
vi.mock('../../../lib/vectorSearch.js', () => ({
  vectorSearchForTenant: (...a: unknown[]) => vectorSearchForTenant(...a),
}))

const aiFeatureEnabled = vi.fn()
vi.mock('../../../lib/aiSettings.js', () => ({ aiFeatureEnabled: (...a: unknown[]) => aiFeatureEnabled(...a) }))

vi.mock('../../../services/embeddings.js', () => ({ vectorIndexName: (l: string) => `idx-${l}` }))
const requestEmbedding = vi.fn()
vi.mock('../../../jobs/embeddingWorker.js', () => ({ requestEmbedding: (...a: unknown[]) => requestEmbedding(...a) }))
vi.mock('../../../lib/kbPublished.js', () => ({ kbArticlePublishedCypher: (a: string) => `${a}.published = true` }))

const suggestTriage = vi.fn()
vi.mock('../../../services/triageService.js', () => ({ suggestTriage: (...a: unknown[]) => suggestTriage(...a) }))

const draftResolutionNotes = vi.fn()
const problemCandidatesSvc = vi.fn()
const draftKbContent = vi.fn()
vi.mock('../../../services/postIncidentService.js', () => ({
  draftResolutionNotes: (...a: unknown[]) => draftResolutionNotes(...a),
  problemCandidates: (...a: unknown[]) => problemCandidatesSvc(...a),
  draftKbContent: (...a: unknown[]) => draftKbContent(...a),
}))

const createKBArticle = vi.fn()
vi.mock('../knowledgeBase.js', () => ({ createKBArticle: (...a: unknown[]) => createKBArticle(...a) }))

const collegaArticoloAIncident = vi.fn()
vi.mock('../../../lib/kbCoverage.js', () => ({
  collegaArticoloAIncident: (...a: unknown[]) => collegaArticoloAIncident(...a),
}))

const auditCalls: unknown[][] = []
vi.mock('../../../lib/audit.js', () => ({ audit: async (...a: unknown[]) => { auditCalls.push(a) } }))

const logWarn = vi.fn()
vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: (...a: unknown[]) => logWarn(...a), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { similarityResolvers: R } = await import('../similarity.js')

const ctx = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: new Set() } as never

async function codice(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'NESSUN RIFIUTO' } catch (e) {
    return String((e as GraphQLError).extensions?.['code'] ?? 'THROWN')
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  aiFeatureEnabled.mockResolvedValue(true)
  runQueryOne.mockResolvedValue({ embedding: [0.1, 0.2], version: '2026-09-23T04:20:00.000Z' })
  requestEmbedding.mockResolvedValue({ state: 'queued' })
  vectorSearchForTenant.mockResolvedValue([])
  createKBArticle.mockResolvedValue({ id: 'kb1' })
  collegaArticoloAIncident.mockResolvedValue(true)
  draftKbContent.mockResolvedValue({ title: 'T', body: 'B', category: 'C', tags: [] })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('i tre stati che sembrano tutti «lista vuota»', () => {
  for (const [nome, chiama] of [
    ['similarIncidents', () => R.Query.similarIncidents(null, { incidentId: 'i1' }, ctx)],
    ['suggestedArticles', () => R.Query.suggestedArticles(null, { incidentId: 'i1' }, ctx)],
  ] as const) {
    describe(nome, () => {
      it('spenti dall\'organizzazione: `disabled: true` — non «non ancora pronto»', async () => {
        aiFeatureEnabled.mockResolvedValue(false)
        expect(await chiama()).toEqual({ ready: false, disabled: true, failure: null, items: [] })
        // Non si legge nemmeno l'incident: la domanda non si fa proprio.
        expect(runQueryOne).not.toHaveBeenCalled()
      })

      it('embedding non ancora calcolato: `ready: false`, ma NON disabilitato', async () => {
        runQueryOne.mockResolvedValue({ embedding: null, version: '2026-09-23T04:20:00.000Z' })
        expect(await chiama()).toEqual({ ready: false, disabled: false, failure: null, items: [] })
        expect(vectorSearchForTenant).not.toHaveBeenCalled()
      })

      it('D15: the question itself queues the computation, for this version of the incident', async () => {
        runQueryOne.mockResolvedValue({ embedding: null, version: '2026-09-23T04:20:00.000Z' })
        await chiama()
        expect(requestEmbedding).toHaveBeenCalledWith({ entityType: 'incident', entityId: 'i1', tenantId: 't1', updatedAt: '2026-09-23T04:20:00.000Z' })
      })

      it('D15: a computation that used up its attempts is said, with its reason — not «under way» for ever', async () => {
        runQueryOne.mockResolvedValue({ embedding: null, version: '2026-09-23T04:20:00.000Z' })
        requestEmbedding.mockResolvedValue({ state: 'failed', reason: 'model not loaded' })
        expect(await chiama()).toEqual({ ready: false, disabled: false, failure: 'model not loaded', items: [] })
      })

      it('D15: an incident without any timestamp cannot be versioned, and says so', async () => {
        runQueryOne.mockResolvedValue({ embedding: null, version: null })
        await expect(chiama()).rejects.toThrow('has neither updated_at nor created_at')
        expect(requestEmbedding).not.toHaveBeenCalled()
      })

      it('an incident that already has its embedding asks for nothing', async () => {
        await chiama()
        expect(requestEmbedding).not.toHaveBeenCalled()
      })

      it('calcolato e davvero senza vicini: `ready: true` con lista vuota', async () => {
        expect(await chiama()).toEqual({ ready: true, disabled: false, failure: null, items: [] })
      })

      it('un incident che non esiste è NOT_FOUND, non una lista vuota', async () => {
        runQueryOne.mockResolvedValue(null)
        expect(await codice(chiama)).toBe('NOT_FOUND')
      })
    })
  }
})

describe('similarIncidents — la ricerca vettoriale', () => {
  it('l\'incident di partenza si esclude: l\'indice è cross-tenant e contiene anche lui', async () => {
    await R.Query.similarIncidents(null, { incidentId: 'i1' }, ctx)
    const opts = vectorSearchForTenant.mock.calls[0]![1] as Record<string, unknown>
    expect(opts['where']).toBe('node.id <> $incidentId')
    expect(opts['params']).toEqual({ incidentId: 'i1' })
    expect(opts['tenantId']).toBe('t1')
    expect(opts['index']).toBe('idx-Incident')
  })

  it('il tetto lo decide il server: fra 1 e 20', async () => {
    for (const [chiesto, atteso] of [[1000, 20], [0, 1], [-4, 1], [undefined, 5]] as const) {
      vectorSearchForTenant.mockClear()
      await R.Query.similarIncidents(null, { incidentId: 'i1', ...(chiesto === undefined ? {} : { limit: chiesto }) }, ctx)
      expect((vectorSearchForTenant.mock.calls[0]![1] as Record<string, unknown>)['limit']).toBe(atteso)
    }
  })

  it('il punteggio arriva come Integer di Neo4j e diventa un numero', async () => {
    vectorSearchForTenant.mockResolvedValue([{ id: 'i2', title: 'X', score: { toNumber: () => 0 } }])
    const out = await R.Query.similarIncidents(null, { incidentId: 'i1' }, ctx) as { items: Array<Record<string, unknown>> }
    expect(typeof out.items[0]!['score']).toBe('number')
  })
})

describe('suggestedArticles — solo gli articoli PUBBLICATI', () => {
  it('il filtro del pubblicato entra nella WHERE, e il tetto è 1..10', async () => {
    await R.Query.suggestedArticles(null, { incidentId: 'i1', limit: 500 }, ctx)
    const opts = vectorSearchForTenant.mock.calls[0]![1] as Record<string, unknown>
    expect(opts['where']).toBe('node.published = true')
    expect(opts['limit']).toBe(10)
    expect(opts['index']).toBe('idx-KBArticle')
  })
})

describe('le letture che delegano ai servizi', () => {
  it('il triage riceve quello che ha chi apre, coi vuoti normalizzati', async () => {
    suggestTriage.mockResolvedValue({ severity: 'high' })
    await R.Query.triageSuggestion(null, { title: 'Stampante rotta' }, ctx)
    expect(suggestTriage.mock.calls[0]![0]).toEqual({
      tenantId: 't1', title: 'Stampante rotta', description: null, ciIds: [],
    })
  })

  it('la bozza di risoluzione esce dentro `draft`, come la vuole lo schema', async () => {
    draftResolutionNotes.mockResolvedValue('testo')
    expect(await R.Query.resolutionDraft(null, { incidentId: 'i1' }, ctx)).toEqual({ draft: 'testo' })
  })

  it('i candidati a problem li decide il servizio', async () => {
    problemCandidatesSvc.mockResolvedValue([{ id: 'p1' }])
    expect(await R.Query.problemCandidates(null, null, ctx)).toEqual([{ id: 'p1' }])
  })
})

describe('createKbDraftFromIncident — da dove viene questo articolo', () => {
  it('passa dalla creazione STANDARD: slug, passo iniziale, registro', async () => {
    await R.Mutation.createKbDraftFromIncident(null, { incidentId: 'i1' }, ctx)
    expect(createKBArticle.mock.calls[0]![1]).toEqual({ title: 'T', body: 'B', category: 'C', tags: [] })
  })

  it('e si collega all\'incident: senza, «questa categoria ricorre e non ha un articolo» non è una domanda rispondibile', async () => {
    await R.Mutation.createKbDraftFromIncident(null, { incidentId: 'i1' }, ctx)
    expect(collegaArticoloAIncident).toHaveBeenCalledWith('t1', 'kb1', 'i1')
  })

  it('un collegamento mancato NON toglie all\'utente l\'articolo che aveva chiesto: si logga', async () => {
    collegaArticoloAIncident.mockResolvedValue(false)
    const out = await R.Mutation.createKbDraftFromIncident(null, { incidentId: 'i1' }, ctx) as Record<string, unknown>
    expect(out['id']).toBe('kb1')
    expect(String(logWarn.mock.calls[0]![1])).toContain('not linked to its incident')
  })

  it('un articolo senza id non fa tentare il collegamento', async () => {
    createKBArticle.mockResolvedValue({})
    await R.Mutation.createKbDraftFromIncident(null, { incidentId: 'i1' }, ctx)
    expect(collegaArticoloAIncident).not.toHaveBeenCalled()
  })

  it('says in the Audit Log that the text came from the model (tour of 23 Sep 2026)', async () => {
    auditCalls.length = 0
    await R.Mutation.createKbDraftFromIncident(null, { incidentId: 'i1' }, ctx)
    expect(auditCalls).toEqual([[ctx, 'kb_article.drafted_by_ai', 'KBArticle', 'kb1', { incidentId: 'i1' }]])
  })
})
