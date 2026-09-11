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

vi.mock('../../lib/config.js', () => ({ config: h.cfg }))
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
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { draftResolutionNotes, draftKbContent, problemCandidates } = await import('../postIncidentService.js')
const { runQuery } = await import('@opengraphity/neo4j')
import { config } from '../../lib/config.js'

// ── Fixture ───────────────────────────────────────────────────────────────────

const TENANT = 'tenant-A'

type Ctx = { props: Record<string, unknown>; comments: Array<{ text: string | null; created_at: string }>; steps: Array<{ step: string | null; at: string | null; trigger: string | null }>; cis: string[] }

const CTX: Ctx = {
  props: { id: 'inc-1', title: 'DB down', description: 'timeout', severity: 'critical', category: 'database', status: 'resolved' },
  comments: [{ text: 'Riavviato il servizio', created_at: '2026-01-01T10:00:00Z' }, { text: null, created_at: '2026-01-01T10:01:00Z' }],
  steps: [{ step: 'new', at: '2026-01-01T09:00:00Z', trigger: 'system' }, { step: null, at: null, trigger: null }, { step: 'resolved', at: '2026-01-01T11:00:00Z', trigger: 'manual' }],
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
    expect(err.message).toBe('Incident non trovato')
    expect(h.create).not.toHaveBeenCalled()
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toEqual({ tenantId: TENANT, incidentId: 'inc-x' })
  })

  it('ANTHROPIC_API_KEY assente → FAILED_PRECONDITION senza istanziare l\'SDK', async () => {
    h.cfg.anthropicApiKey = undefined
    const err = await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'FAILED_PRECONDITION')
    expect(err.message).toBe('AI non configurata: ANTHROPIC_API_KEY mancante')
    expect(h.constructed).toHaveLength(0)
    expect(h.create).not.toHaveBeenCalled()
  })

  it('passa al modello solo l\'evidenza reale (commenti con testo, step con nome, CI) e ritorna il testo trimmato', async () => {
    h.create.mockResolvedValue(modelReply('  Causa: timeout DB. Intervento: riavvio.  '))
    await expect(draftResolutionNotes(TENANT, 'inc-1')).resolves.toBe('Causa: timeout DB. Intervento: riavvio.')
    expect(h.create.mock.calls[0]![0]).toMatchObject({ model: config.anthropicModel, max_tokens: 1500, output_config: { effort: 'low' } })
    expect(userContent()).toEqual({
      titolo: 'DB down', descrizione: 'timeout', severity: 'critical', categoria: 'database', ci_coinvolti: ['db-01'],
      commenti: [{ text: 'Riavviato il servizio', created_at: '2026-01-01T10:00:00Z' }],
      passaggi_workflow: [{ step: 'new', at: '2026-01-01T09:00:00Z', trigger: 'system' }, { step: 'resolved', at: '2026-01-01T11:00:00Z', trigger: 'manual' }],
    })
  })

  it('bozza vuota o assente → errore esplicito; refusal → INTERNAL_SERVER_ERROR', async () => {
    h.create.mockResolvedValue(modelReply('   '))
    await expect(draftResolutionNotes(TENANT, 'inc-1')).rejects.toThrow('[post-incident] bozza vuota dal modello')
    h.create.mockResolvedValue(modelReply(null))
    await expect(draftResolutionNotes(TENANT, 'inc-1')).rejects.toThrow('[post-incident] bozza vuota dal modello')
    h.create.mockResolvedValue(modelReply('x', 'refusal'))
    await graphqlFailure(draftResolutionNotes(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
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
    expect(err.message).toBe('La bozza KB si genera solo da incident risolti o chiusi')
    expect(h.create).not.toHaveBeenCalled()
  })

  it('chiave assente con incident risolto → FAILED_PRECONDITION', async () => {
    h.cfg.anthropicApiKey = undefined
    await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'FAILED_PRECONDITION')
    expect(h.create).not.toHaveBeenCalled()
  })

  it.each(['resolved', 'closed'])('status %s → schema json_schema con title/body/category/tags e bozza parsata', async (status) => {
    incident({ ...CTX, props: { ...CTX.props, status } })
    h.create.mockResolvedValue(modelReply(JSON.stringify(KB)))
    await expect(draftKbContent(TENANT, 'inc-1')).resolves.toEqual(KB)
    const params = h.create.mock.calls[0]![0]
    expect(params).toMatchObject({ max_tokens: 3000, output_config: { effort: 'low', format: { type: 'json_schema', schema: { required: ['title', 'body', 'category', 'tags'] } } } })
    expect(userContent()).toMatchObject({ titolo: 'DB down', categoria_incident: 'database', ci_coinvolti: ['db-01'] })
  })

  it('JSON non parsabile → errore esplicito; risposta senza testo → errore; refusal → INTERNAL_SERVER_ERROR', async () => {
    h.create.mockResolvedValue(modelReply('{"title": '))
    await expect(draftKbContent(TENANT, 'inc-1')).rejects.toThrow(SyntaxError)
    h.create.mockResolvedValue(modelReply(null))
    await expect(draftKbContent(TENANT, 'inc-1')).rejects.toThrow('[post-incident] risposta senza testo')
    h.create.mockResolvedValue(modelReply('{}', 'refusal'))
    await graphqlFailure(draftKbContent(TENANT, 'inc-1'), 'INTERNAL_SERVER_ERROR')
  })
})

// ── problemCandidates ─────────────────────────────────────────────────────────

describe('problemCandidates', () => {
  type Inc = { id: string; number: string; title: string; status: string; severity: string; embedding: number[] }
  const inc = (n: number, status = 'new'): Inc => ({ id: `i${n}`, number: `INC${n}`, title: `T${n}`, status, severity: 'high', embedding: [n] })

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

  it('nessun incident con embedding → [] senza chiamare il modello (anche senza chiave)', async () => {
    h.cfg.anthropicApiKey = undefined
    cluster([], {})
    await expect(problemCandidates(TENANT)).resolves.toEqual([])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('cluster sotto la dimensione minima (3) → [] senza chiamare il modello', async () => {
    cluster([inc(1), inc(2), inc(3)], { i1: ['i2'], i2: ['i1'] })
    await expect(problemCandidates(TENANT)).resolves.toEqual([])
    expect(h.create).not.toHaveBeenCalled()
  })

  it('la soglia di similarità e l\'esclusione dei chiusi sono applicate nella query tenant-scoped', async () => {
    cluster([inc(1)], {})
    await problemCandidates(TENANT)
    const calls = vi.mocked(runQuery).mock.calls
    const list = calls[0]!
    expect(list[1]).toContain("NOT i.status IN ['closed'] AND i.embedding IS NOT NULL")
    expect(list[2]).toEqual({ tenantId: TENANT })
    const peers = calls[1]!
    expect(peers[1]).toContain('score >= 0.72')
    expect(peers[1]).toContain('node.tenant_id = $tenantId AND node.id <> $selfId')
    expect(peers[2]).toMatchObject({ tenantId: TENANT, selfId: 'i1', embedding: [1], index: 'incident_embedding_test' })
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
    expect(result).toEqual([{
      title: 'Timeout DB ricorrente', motivation: 'Tre incident simili',
      incidents: [
        { id: 'i1', number: 'INC1', title: 'T1', status: 'new', severity: 'high' },
        { id: 'i2', number: 'INC2', title: 'T2', status: 'new', severity: 'high' },
        { id: 'i3', number: 'INC3', title: 'T3', status: 'new', severity: 'high' },
      ],
    }])
    // al modello arriva solo il cluster valido, con i dati reali (mai gli embedding)
    const content = userContent() as unknown as Array<{ cluster_index: number; incident: unknown[] }>
    expect(content).toEqual([{ cluster_index: 0, incident: [
      { numero: 'INC1', titolo: 'T1', severity: 'high', stato: 'new' },
      { numero: 'INC2', titolo: 'T2', severity: 'high', stato: 'new' },
      { numero: 'INC3', titolo: 'T3', severity: 'high', stato: 'new' },
    ] }])
  })

  it('con cluster validi ma chiave assente → FAILED_PRECONDITION; JSON non parsabile → errore', async () => {
    cluster([inc(1), inc(2), inc(3)], { i1: ['i2', 'i3'] })
    h.cfg.anthropicApiKey = undefined
    await graphqlFailure(problemCandidates(TENANT), 'FAILED_PRECONDITION')
    h.cfg.anthropicApiKey = 'sk-test'
    h.create.mockResolvedValue(modelReply('nope'))
    await expect(problemCandidates(TENANT)).rejects.toThrow(SyntaxError)
    h.create.mockResolvedValue(modelReply(null))
    await expect(problemCandidates(TENANT)).rejects.toThrow('[post-incident] risposta senza testo')
  })
})
