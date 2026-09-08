/**
 * Embedding worker processor (jobs/embeddingWorker.ts): text built per entity
 * type, provider `embed` called, vector written with tenant scoping; provider
 * or Neo4j failures fail the job (no fallback). `embeddingJobId` is covered in
 * schedulerHelpers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const createWorker = vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => { processors.set(name, processor); return { name, opts } })
const queueAdd = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: (...a: unknown[]) => createWorker(...(a as [string, AnyProcessor, unknown])),
  getQueue: vi.fn(() => ({ add: queueAdd })),
}))

interface Rec { get(k: string): unknown }
type Tx = { run: (q: string, p?: Record<string, unknown>) => Promise<{ records: Rec[] }> }
type Work = (tx: Tx) => Promise<unknown>

const writes: Array<{ q: string; p?: Record<string, unknown> }> = []
let writeError: Error | null = null
const close = vi.fn().mockResolvedValue(undefined)
const getSession = vi.fn((_db?: string, mode?: string) => ({
  mode,
  executeWrite: async (work: Work) => work({
    run: async (q, p) => { writes.push({ q, p }); if (writeError) throw writeError; return { records: [] } },
  }),
  close,
}))
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...(a as [string | undefined, string | undefined])),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const embed = vi.fn()
const embedder = { provider: 'local', model: 'MiniLM-L12', dimensions: 3, embed: (texts: string[]) => embed(texts) }
const incidentEmbeddingText = vi.fn((p: Record<string, unknown>) => `${String(p['title'] ?? '')} ${String(p['description'] ?? '')}`.trim())
const kbEmbeddingText = vi.fn((p: Record<string, unknown>) => `${String(p['title'] ?? '')} ${String(p['body'] ?? '')}`.trim())
vi.mock('../../services/embeddings.js', () => ({
  getEmbedder: () => embedder,
  vectorIndexName: (label: string) => `${label.toLowerCase()}_embedding_idx`,
  incidentEmbeddingText: (p: Record<string, unknown>) => incidentEmbeddingText(p),
  kbEmbeddingText: (p: Record<string, unknown>) => kbEmbeddingText(p),
}))

const logWarn = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { startEmbeddingWorker, enqueueEmbedding, ensureVectorIndexes, EMBEDDINGS_QUEUE } = await import('../embeddingWorker.js')

const job = (data: Record<string, unknown>): Job => ({ name: 'embed', data, id: 'j-1' } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  writeError = null
  embed.mockResolvedValue([[0.1, 0.2, 0.3]])
})

describe('startEmbeddingWorker / ensureVectorIndexes', () => {
  it('crea gli indici vettoriali (Incident, KBArticle) con le dimensioni del provider PRIMA di avviare il worker', async () => {
    await startEmbeddingWorker()

    expect(writes).toHaveLength(2)
    expect(writes[0]!.q).toContain('CREATE VECTOR INDEX incident_embedding_idx IF NOT EXISTS')
    expect(writes[0]!.q).toContain('FOR (n:Incident) ON n.embedding')
    expect(writes[0]!.q).toContain('`vector.dimensions`: 3')
    expect(writes[1]!.q).toContain('FOR (n:KBArticle) ON n.embedding')
    expect(createWorker).toHaveBeenCalledWith(EMBEDDINGS_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 1 }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('creazione indici fallita → startup rigetta, nessun worker avviato', async () => {
    writeError = new Error('vector indexes unsupported')
    await expect(startEmbeddingWorker()).rejects.toThrow('vector indexes unsupported')
    expect(createWorker).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('ensureVectorIndexes chiude la sessione anche in caso di errore', async () => {
    writeError = new Error('x')
    await ensureVectorIndexes().catch(() => undefined)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('processEmbedding', () => {
  let processor: AnyProcessor
  beforeEach(async () => {
    await startEmbeddingWorker()
    processor = processors.get(EMBEDDINGS_QUEUE)!
    writes.length = 0
    close.mockClear()
  })

  it('incident: legge il nodo scopato per tenant, costruisce il testo, chiama embed e scrive il vettore con tenant_id', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'inc-1', title: 'DB down', description: 'primary unreachable' } })

    await expect(processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }))).resolves.toBeUndefined()

    const [session, readQ, readP] = runQueryOne.mock.calls[0] as [{ mode: string }, string, Record<string, unknown>]
    expect(session.mode).toBe('WRITE')
    expect(readQ).toContain('MATCH (n:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(readP).toEqual({ entityId: 'inc-1', tenantId: 't1' })

    expect(incidentEmbeddingText).toHaveBeenCalledWith(expect.objectContaining({ title: 'DB down' }))
    expect(kbEmbeddingText).not.toHaveBeenCalled()
    expect(embed).toHaveBeenCalledWith(['DB down primary unreachable'])

    expect(writes).toHaveLength(1)
    expect(writes[0]!.q).toContain('MATCH (n:Incident {id: $entityId, tenant_id: $tenantId})')
    expect(writes[0]!.q).toContain("CALL db.create.setNodeVectorProperty(n, 'embedding', $vector)")
    expect(writes[0]!.p).toEqual({
      entityId: 'inc-1', tenantId: 't1', vector: [0.1, 0.2, 0.3], model: 'local:MiniLM-L12',
      now: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('kb_article: label KBArticle e testo da kbEmbeddingText', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'kb-1', title: 'Reset VPN', body: 'steps' } })

    await processor(job({ entityType: 'kb_article', entityId: 'kb-1', tenantId: 't1' }))

    expect((runQueryOne.mock.calls[0] as [unknown, string])[1]).toContain('MATCH (n:KBArticle {id: $entityId, tenant_id: $tenantId})')
    expect(kbEmbeddingText).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reset VPN' }))
    expect(embed).toHaveBeenCalledWith(['Reset VPN steps'])
    expect(writes[0]!.q).toContain('MATCH (n:KBArticle {id: $entityId, tenant_id: $tenantId})')
  })

  it('entità non trovata (cancellata tra enqueue e processing) → no-op documentato: warn, nessun embed, nessuna scrittura', async () => {
    runQueryOne.mockResolvedValue(null)
    await expect(processor(job({ entityType: 'incident', entityId: 'gone', tenantId: 't1' }))).resolves.toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'incident', entityId: 'gone' }), expect.stringContaining('no longer exists'))
    expect(embed).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it('entità di un altro tenant → la MATCH scopata non la trova (stesso no-op, mai un embed cross-tenant)', async () => {
    runQueryOne.mockImplementation(async (_s: unknown, _q: string, p: { tenantId: string }) =>
      p.tenantId === 't-owner' ? { props: { id: 'inc-1', title: 'x' } } : null)
    await processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't-other' }))
    expect(embed).not.toHaveBeenCalled()
  })

  it('testo vuoto → errore esplicito, nessun embed', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'inc-1', title: '', description: '' } })
    await expect(processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }))).rejects.toThrow('[embeddings] Incident inc-1 has no embeddable text')
    expect(embed).not.toHaveBeenCalled()
  })

  it('provider che fallisce → il job rigetta, nessuna scrittura, sessione chiusa', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'inc-1', title: 'x' } })
    embed.mockRejectedValue(new Error('voyage 503'))
    await expect(processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }))).rejects.toThrow('voyage 503')
    expect(writes).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
  })

  it('scrittura Neo4j che fallisce → il job rigetta', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 'inc-1', title: 'x' } })
    writeError = new Error('write timeout')
    await expect(processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }))).rejects.toThrow('write timeout')
    expect(close).toHaveBeenCalledOnce()
  })

  it('lettura Neo4j che fallisce → il job rigetta', async () => {
    runQueryOne.mockRejectedValue(new Error('read timeout'))
    await expect(processor(job({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }))).rejects.toThrow('read timeout')
  })
})

describe('enqueueEmbedding', () => {
  it('accoda con jobId versionato per updated_at, 3 tentativi con backoff esponenziale', async () => {
    await enqueueEmbedding({ entityType: 'incident', entityId: 'inc-1', tenantId: 't1', updatedAt: '2026-09-08T10:00:00.000Z' })
    expect(queueAdd).toHaveBeenCalledWith(
      'embed',
      { entityType: 'incident', entityId: 'inc-1', tenantId: 't1', updatedAt: '2026-09-08T10:00:00.000Z' },
      {
        jobId: `embed:incident:inc-1:${Date.parse('2026-09-08T10:00:00.000Z')}`,
        removeOnComplete: true, removeOnFail: 50, attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
      },
    )
  })

  it('enqueue che fallisce → propagato al chiamante', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis down'))
    await expect(enqueueEmbedding({ entityType: 'kb_article', entityId: 'k', tenantId: 't' })).rejects.toThrow('redis down')
  })
})
