/**
 * postIncidentService — draftResolutionNotes / draftKbContent /
 * problemCandidates con @anthropic-ai/sdk mockato (messages.create) e Neo4j
 * mockato. Pinna: incident non trovato nel tenant → NOT_FOUND; chiave assente
 * → FAILED_PRECONDITION senza chiamare l'SDK; bozza KB solo da resolved/closed;
 * JSON non parsabile / bozza vuota / refusal → errore esplicito; clustering
 * dei candidati Problem (soglia e dimensione minima) e mapping dei cluster.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const h = vi.hoisted(() => {
  const cfg = { anthropicApiKey: undefined as string | undefined }
  const create = vi.fn<(p: Record<string, unknown>) => Promise<unknown>>()
  const constructed: unknown[] = []
  const session = { close: vi.fn().mockResolvedValue(undefined) }
  return { cfg, create, constructed, session }
})

// La lingua in cui il modello scrive si legge dal cliente (lib/systemText.ts).
// Ondata 6 di «Nulla cablato»: le funzioni AI sono dell'organizzazione; qui tutte accese.
vi.mock('../../lib/aiSettings.js', () => import('../../lib/__tests__/aiSettingsFake.js'))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('../../lib/config.js', () => ({ config: h.cfg }))
// D14: the drafts receive every instant as wall-clock time in the organization's zone.
vi.mock('../../lib/tenantTimezone.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/tenantTimezone.js')>(),
  tenantTimezone: vi.fn(async () => 'Europe/Rome'),
}))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: h.create }
    constructor(opts?: unknown) { h.constructed.push(opts ?? null) }
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => h.session),
  runQuery:   vi.fn(),
}))
vi.mock('../embeddings.js', () => ({
  vectorIndexName: vi.fn((label: string) => `${label.toLowerCase()}_embedding_test`),
}))
// D15: open incidents without an embedding get it queued by the analysis.
vi.mock('../../jobs/embeddingWorker.js', () => ({ requestEmbedding: vi.fn(async () => ({ state: 'queued' })) }))
// ── Ondata 8 (B-22): chiuso e risolto vengono dai passi del workflow ─────────
// I nomi sono del CLIENTE (`archiviato`, `sistemato`): il servizio non deve
// conoscere `closed`/`resolved`. Mockato per non aprire una seconda sessione
// Neo4j (la derivazione dai metadata è provata in workflowHelpers).
vi.mock('../../lib/statusStepNames.js', () => ({
  statusNamesForClasses: vi.fn(async () => ['archiviato']),
  concludedStatusNames:  vi.fn(async () => ['sistemato', 'archiviato']),
}))
// F5: la categoria della bozza KB è uno dei valori del vocabolario `kb_category` del cliente.
vi.mock('../../lib/domainMatrix.js', () => ({ domainVocabulary: vi.fn(async () => ['database', 'network', 'faq']) }))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { draftResolutionNotes, draftKbContent, problemCandidates } = await import('../postIncidentService.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { tenantTimezone } = await import('../../lib/tenantTimezone.js')
const { requestEmbedding } = await import('../../jobs/embeddingWorker.js')
import { config } from '../../lib/config.js'

// ── Fixture ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-A'

type Ctx = { props: Record<string, unknown>; comments: Array<{ text: string | null; created_at: string }>; steps: Array<{ step: string | null; at: string | null; trigger: string | null }>; cis: string[] }

const CTX: Ctx = {
  props: { id: 'inc-1', title: 'DB down', description: 'timeout', severity: 'critical', category: 'database', status: 'sistemato', created_at: '2026-01-01T08:55:00Z', resolved_at: '2026-01-01T11:00:00Z' },
  comments: [{ text: 'Riavviato il servizio', created_at: '2026-01-01T10:00:00Z' }, { text: null, created_at: '2026-01-01T10:01:00Z' }],
  steps: [{ step: 'new', at: '2026-01-01T09:00:00Z', trigger: 'system' }, { step: null, at: null, trigger: null }, { step: 'sistemato', at: '2026-01-01T11:00:00Z', trigger: 'manual' }],
  cis: ['db-01'],
}

/** Incident (o null = non trovato) restituito da loadIncidentContext. */
function incident(ctx: Ctx | null) {
  vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) => {
    if (cypher.includes('MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})')) return ctx ? [ctx] : []
    throw new Error(`query inattesa: ${cypher.slice(0, 60)}`)
  })
}

const modelReply = (text: string | null, stop_reason = 'end_turn') => ({
  stop_reason,
  content: text === null ? [{ type: 'thinking', thinking: '…' }] : [{ type: 'thinking', thinking: '…' }, { type: 'text', text }],
})

const userContent = (): Record<string, unknown> =>
  JSON.parse((h.create.mock.calls[0]![0]['messages'] as Array<{ content: string }>)[0]!.content) as Record<string, unknown>

async function graphqlFailure(promise: Promise<unknown>, code: string): Promise<GraphQLError> {
  const err = await promise.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  return err as GraphQLError
}

beforeEach(() => {
  vi.clearAllMocks()
  h.constructed.length = 0
  h.cfg.anthropicApiKey = 'sk-test'
  incident(CTX)
})

// ── draftResolutionNotes ──────────────────────────────────────────────────────

describe('draftResolutionNotes', () => {
  it('incident inesistente nel tenant → NOT_FOUND, nessuna chiamata al modello (anche con chiave presente)', async () => {
    incident(null)
    const err = await graphqlFailure(draftResolutionNotes(TENANT, 'inc-x'), 'NOT_FOUND')
    expect(err.message).toBe('Incident not found')
    expect(h.create).not.toHaveBeenCalled()
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toEqual({ tenantId: TENANT, incidentId: 'inc-x' })
  })

  it('ANTHROPIC_API_KEY assente → FAILED_PRECONDITION senza istanziare l\'SDK', async () => {
    h.cfg.anthropicApiKey = undefined
    const err = await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'FAILED_PRECONDITION')
    // Ondata 8: un solo controllo della chiave per tutte le funzioni AI.
    expect(err.message).toBe('AI is not configured on this platform: ANTHROPIC_API_KEY missing')
    expect(h.constructed).toHaveLength(0)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('passa al modello solo l\'evidenza reale (commenti con testo, step con nome, CI) e ritorna il testo trimmato', async () => {
    h.create.mockResolvedValue(modelReply('  Causa: timeout DB. Intervento: riavvio.  '))
    await expect(draftResolutionNotes(TENANT, 'inc-1')).resolves.toBe('Causa: timeout DB. Intervento: riavvio.')
    expect(h.create.mock.calls[0]![0]).toMatchObject({ model: config.anthropicModel, max_tokens: 1500, output_config: { effort: 'low' } })
    // D14: every instant as wall-clock time in Europe/Rome (UTC+1 in January), never raw UTC.
    expect(userContent()).toEqual({
      title: 'DB down', description: 'timeout', severity: 'critical', category: 'database',
      opened_at: '2026-01-01 09:55', resolved_at: '2026-01-01 12:00', affected_cis: ['db-01'],
      comments: [{ at: '2026-01-01 11:00', text: 'Riavviato il servizio' }],
      workflow_steps: [{ step: 'new', at: '2026-01-01 10:00', trigger: 'system' }, { step: 'sistemato', at: '2026-01-01 12:00', trigger: 'manual' }],
    })
    const system = (h.create.mock.calls[0]![0]['system'] as Array<{ text: string }>)[0]!.text
    expect(system).toContain("local time in the organization's time zone, Europe/Rome")
    expect(system).toContain('never convert them')
    expect(system).toContain('Write the text in English')
  })

  it('the history is reached from the incident, never by scanning every workflow instance or step execution', async () => {
    h.create.mockResolvedValue(modelReply('ok'))
    await draftResolutionNotes(TENANT, 'inc-1')
    const [, cypher] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('(i)-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:STEP_HISTORY]->(se:WorkflowStepExecution)')
    expect(cypher).not.toContain('entity_id: $incidentId')
    expect(cypher).not.toContain('instance_id: wi.id')
  })

  it('an organization without a time zone gets an error that says where to set it, and the model is not called', async () => {
    vi.mocked(tenantTimezone).mockResolvedValueOnce(null)
    const err = await draftResolutionNotes(TENANT, 'inc-1').catch((e: unknown) => e) as GraphQLError
    expect(err.extensions['code']).toBe('BAD_USER_INPUT')
    expect(err.extensions['i18n']).toEqual({ key: 'errors.ai.needsTimezone' })
    expect(err.message).toContain('Settings → Organization')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('bozza vuota o assente → errore con la chiave, refusal → INTERNAL_SERVER_ERROR, troncata → si dice troncata', async () => {
    h.create.mockResolvedValue(modelReply('   '))
    await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
    h.create.mockResolvedValue(modelReply(null))
    await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
    h.create.mockResolvedValue(modelReply('x', 'refusal'))
    await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
    /*
     * IL TRONCAMENTO NON C'ERA (ondata 8). Una nota di risoluzione tagliata a
     * metà usciva come bozza buona e l'operatore la firmava credendola finita:
     * qui si pretende che il servizio lo dica.
     */
    h.create.mockResolvedValue(modelReply('La causa è stata', 'max_tokens'))
    const troncata = await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
    expect(troncata.extensions['i18n']).toEqual({ key: 'errors.ai.truncated' })
  })
})

// ── draftKbContent ────────────────────────────────────────────────────────────

describe('draftKbContent', () => {
  const KB = { title: 'DB timeout', body: '## Sintomo\n…', category: 'database', tags: ['db', 'timeout'] }

  it('incident inesistente → NOT_FOUND; incident non risolto → BAD_USER_INPUT senza chiamare il modello', async () => {
    incident(null)
    await graphqlFailure(draftKbContent(TENANT, 'inc-x'), 'NOT_FOUND')
    incident({ ...CTX, props: { ...CTX.props, status: 'in_progress' } })
    const err = await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'BAD_USER_INPUT')
    // Il rifiuto nomina il passo e i passi conclusivi del workflow del cliente:
    // prima diceva solo «risolti o chiusi», che con passi rinominati non
    // aiutava a capire perché il bottone non funzionava.
    expect(err.message).toContain('The KB draft is generated only from resolved or closed incidents')
    expect(err.message).toContain('sistemato, archiviato')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('chiave assente con incident risolto → FAILED_PRECONDITION', async () => {
    h.cfg.anthropicApiKey = undefined
    await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'FAILED_PRECONDITION')
    expect(h.create).not.toHaveBeenCalled()
  })

  // I due passi CONCLUSIVI del workflow di questo cliente, con i suoi nomi:
  // prima erano i letterali `resolved`/`closed` e un passo di risoluzione
  // rinominato rendeva la bozza KB irraggiungibile.
  it.each(['sistemato', 'archiviato'])('status %s → schema json_schema con title/body/category/tags e bozza parsata', async (status) => {
    incident({ ...CTX, props: { ...CTX.props, status } })
    h.create.mockResolvedValue(modelReply(JSON.stringify(KB)))
    await expect(draftKbContent(TENANT, 'inc-1')).resolves.toEqual(KB)
    const params = h.create.mock.calls[0]![0]
    expect(params).toMatchObject({ max_tokens: 3000, output_config: { effort: 'low', format: { type: 'json_schema', schema: { required: ['title', 'body', 'category', 'tags'] } } } })
    // Revisione del 14 set 2026 · F5: il modello sceglie fra le categorie KB del cliente, non inventa una parola.
    expect(params).toMatchObject({ output_config: { format: { schema: { properties: { category: { type: 'string', enum: ['database', 'network', 'faq'] } } } } } })
    expect(userContent()).toMatchObject({ title: 'DB down', category: 'database', affected_cis: ['db-01'], opened_at: '2026-01-01 09:55' })
    expect((params['system'] as Array<{ text: string }>)[0]!.text).toContain("local time in the organization's time zone, Europe/Rome")
  })

  it('JSON non parsabile → errore esplicito; risposta senza testo → errore; refusal → INTERNAL_SERVER_ERROR', async () => {
    // Il `SyntaxError` crudo di `JSON.parse` non arriva più all'utente: dal
    // client condiviso esce un errore con la sua chiave (ondata 8).
    h.create.mockResolvedValue(modelReply('{"title": '))
    expect((await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')).extensions['i18n'])
      .toEqual({ key: 'errors.ai.badAnswer' })
    h.create.mockResolvedValue(modelReply(null))
    await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
    h.create.mockResolvedValue(modelReply('{}', 'refusal'))
    await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
  })
})

// ── problemCandidates ─────────────────────────────────────────────────────────

describe('problemCandidates', () => {
  type Inc = { id: string; number: string; title: string; status: string; severity: string; embedding: number[] | null; version: string | null }
  const inc = (n: number, status = 'new'): Inc => ({ id: `i${n}`, number: `INC${n}`, title: `T${n}`, status, severity: 'high', embedding: [n], version: `2026-09-0${n % 9 + 1}T00:00:00Z` })
  const none = { examined: 0, notAnalysed: 0, analysisFailures: 0, capped: false }

  /** incidents del tenant + mappa id → vicini (sopra soglia, già filtrati "lato DB"). */
  function cluster(incidents: Inc[], peers: Record<string, string[]>) {
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('db.index.vector.queryNodes')) {
        return (peers[params?.['selfId'] as string] ?? []).map(id => ({ id, score: 0.9 }))
      }
      if (cypher.includes('MATCH (i:Incident {tenant_id: $tenantId})')) return incidents
      throw new Error(`query inattesa: ${cypher.slice(0, 60)}`)
    })
  }

  it('nessun incident aperto → nessun candidato, e si dice che non c\'era niente da esaminare (anche senza chiave)', async () => {
    h.cfg.anthropicApiKey = undefined
    cluster([], {})
    await expect(problemCandidates(TENANT)).resolves.toEqual({ candidates: [], ...none })
    expect(h.create).not.toHaveBeenCalled()
  })

  it('cluster sotto la dimensione minima (3) → nessun candidato senza chiamare il modello', async () => {
    cluster([inc(1), inc(2), inc(3)], { i1: ['i2'], i2: ['i1'] })
    await expect(problemCandidates(TENANT)).resolves.toEqual({ candidates: [], ...none, examined: 3 })
    expect(h.create).not.toHaveBeenCalled()
  })

  /*
   * D15 (tour of 23 Sep 2026): on a tenant where no incident had an embedding
   * the page said «No cluster of recurring similar incidents found». Now the
   * open incidents without one are counted, their computation is queued, and
   * the ones whose computation failed are counted apart.
   */
  it('D15: open incidents without an embedding are counted and queued, not silently left out', async () => {
    const failed = { ...inc(4), embedding: null }
    cluster([inc(1), { ...inc(2), embedding: null }, { ...inc(3), embedding: null }, failed], {})
    vi.mocked(requestEmbedding).mockImplementation(async (d) => (d.entityId === 'i4' ? { state: 'failed', reason: 'boom' } : { state: 'queued' }))
    await expect(problemCandidates(TENANT)).resolves.toEqual({ candidates: [], examined: 1, notAnalysed: 3, analysisFailures: 1, capped: false })
    expect(vi.mocked(requestEmbedding).mock.calls.map(([d]) => d)).toEqual([
      { entityType: 'incident', entityId: 'i2', tenantId: TENANT, updatedAt: inc(2).version },
      { entityType: 'incident', entityId: 'i3', tenantId: TENANT, updatedAt: inc(3).version },
      { entityType: 'incident', entityId: 'i4', tenantId: TENANT, updatedAt: inc(4).version },
    ])
    // only the analysed incident goes to the vector index (K may grow, B-12: several calls, one incident)
    const selves = vi.mocked(runQuery).mock.calls
      .filter(([, q]) => String(q).includes('db.index.vector.queryNodes'))
      .map(([, , p]) => (p as Record<string, unknown>)['selfId'])
    expect(new Set(selves)).toEqual(new Set(['i1']))
  })

  it('D15: more open incidents than the cap → capped, and only the most recent 300 are examined', async () => {
    cluster(Array.from({ length: 301 }, (_, k) => ({ ...inc(k + 1), embedding: null })), {})
    const out = await problemCandidates(TENANT)
    expect(out).toMatchObject({ capped: true, notAnalysed: 300, examined: 0 })
    expect(requestEmbedding).toHaveBeenCalledTimes(300)
  })

  it('la soglia di similarità e l\'esclusione dei chiusi sono applicate nella query tenant-scoped', async () => {
    cluster([inc(1)], {})
    await problemCandidates(TENANT)
    const calls = vi.mocked(runQuery).mock.calls
    const list = calls[0]!
    // I passi della classe «chiuso» del workflow del cliente, non il letterale.
    expect(list[1]).toContain('NOT i.status IN $closedSteps')
    // CONTRATTO RINEGOZIATO (revisione totale · D-22): la lettura ha un TETTO
    // di incident (una query vettoriale per incident dentro una richiesta
    // dell'interfaccia: su migliaia di incident aperti la pagina andava in
    // timeout). Si guardano i più recenti, e quando il tetto è pieno lo si dice:
    // one row more than the cap tells whether it cut (D15).
    expect(list[1]).toContain('LIMIT toInteger($limit)')
    expect(list[2]).toEqual({ tenantId: TENANT, closedSteps: ['archiviato'], limit: 301 })
    const peers = calls[1]!
    // Ondata 6 di «Nulla cablato»: la soglia è dell'organizzazione e arriva come parametro.
    expect(peers[1]).toContain('score >= $minSimilarity')
    expect(peers[2]).toMatchObject({ minSimilarity: 0.72 })
    expect(peers[1]).toContain('node.tenant_id = $tenantId AND node.id <> $selfId')
    expect(peers[1]).toContain('NOT node.status IN $closedSteps')
    expect(peers[2]).toMatchObject({ tenantId: TENANT, selfId: 'i1', embedding: [1], index: 'incident_embedding_test', closedSteps: ['archiviato'] })
  })

  it('union-find: cluster ≥ 3 → il modello nomina i cluster; candidati con cluster_index inesistente scartati; vicini estranei ignorati', async () => {
    cluster([inc(1), inc(2), inc(3), inc(4), inc(5)], {
      i1: ['i2', 'ghost'], i2: ['i3'], i3: [], i4: ['i5'], i5: ['i4'],
    })
    h.create.mockResolvedValue(modelReply(JSON.stringify({ candidates: [
      { cluster_index: 0, title: 'Timeout DB ricorrente', motivation: 'Tre incident simili' },
      { cluster_index: 7, title: 'inesistente', motivation: '…' },
    ] })))
    const result = await problemCandidates(TENANT)
    expect(result).toEqual({ ...none, examined: 5, candidates: [{
      title: 'Timeout DB ricorrente', motivation: 'Tre incident simili',
      incidents: [
        { id: 'i1', number: 'INC1', title: 'T1', status: 'new', severity: 'high' },
        { id: 'i2', number: 'INC2', title: 'T2', status: 'new', severity: 'high' },
        { id: 'i3', number: 'INC3', title: 'T3', status: 'new', severity: 'high' },
      ],
    }] })
    // al modello arriva solo il cluster valido, con i dati reali (mai gli embedding)
    const content = userContent() as unknown as Array<{ cluster_index: number; incidents: unknown[] }>
    expect(content).toEqual([{ cluster_index: 0, incidents: [
      { number: 'INC1', title: 'T1', severity: 'high', status: 'new' },
      { number: 'INC2', title: 'T2', severity: 'high', status: 'new' },
      { number: 'INC3', title: 'T3', severity: 'high', status: 'new' },
    ] }])
  })

  it('con cluster validi ma chiave assente → FAILED_PRECONDITION; JSON non parsabile → errore', async () => {
    cluster([inc(1), inc(2), inc(3)], { i1: ['i2', 'i3'] })
    h.cfg.anthropicApiKey = undefined
    await graphqlFailure(problemCandidates(TENANT), 'FAILED_PRECONDITION')
    h.cfg.anthropicApiKey = 'sk-test'
    h.create.mockResolvedValue(modelReply('nope'))
    expect((await graphqlFailure(problemCandidates(TENANT), 'INTERNAL_SERVER_ERROR')).extensions['i18n'])
      .toEqual({ key: 'errors.ai.badAnswer' })
    h.create.mockResolvedValue(modelReply(null))
    await graphqlFailure(problemCandidates(TENANT), 'INTERNAL_SERVER_ERROR')
  })
})
