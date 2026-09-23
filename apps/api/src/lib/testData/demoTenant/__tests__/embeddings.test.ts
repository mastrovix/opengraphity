/**
 * THE EMBEDDINGS OF THE DEMO TENANT (tour of 23 Sep 2026, D15).
 *
 * Not one of the incidents had an embedding: «Similar incidents» waited for
 * ever, the AI triage found no history, «Problem candidates» found no
 * cluster. The owner chose to compute them with the local model, as the
 * embedding worker would have done seconds after each write. What is pinned:
 *
 *  - an organization that turned embeddings off gets none, and the provider
 *    is never called (the product would not send it the texts either);
 *  - the SAME provider, texts and write as the worker: `getEmbedder`,
 *    `incidentEmbeddingText` / `kbEmbeddingText`, `db.create.setNodeVectorProperty`,
 *    and the model recorded as `provider:model`;
 *  - only what THIS run wrote, in batches in id order, each resuming after
 *    the last id, with a progress line every twenty batches;
 *  - «computed seconds after it was written»: `embedded_at` is five seconds
 *    after the thing's creation, not the minute of the generation;
 *  - a thing with nothing to embed stops the run, naming it (no silent hole
 *    in «Similar incidents»).
 *
 * Neo4j, the AI settings and the vector indexes are fakes; the text functions
 * are the product's own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Session } from 'neo4j-driver'

/** A node as the query returns it: its id and its properties. */
type Row = { id: string; created_at: string; title?: unknown; category?: unknown; description?: unknown; tags?: unknown; body?: unknown }

const fake = vi.hoisted(() => ({
  enabled: true,
  asked: [] as Array<[string, string]>,
  store: { Incident: [] as Array<Record<string, unknown> & { id: string }>, KBArticle: [] as Array<Record<string, unknown> & { id: string }> },
  queries: [] as Array<{ text: string; params: Record<string, unknown> }>,
  embedded: [] as string[][],
  writes: [] as Array<{ text: string; params: Record<string, unknown> }>,
  /** What happened, in order: the indexes, the reads, the embeddings, the writes. */
  order: [] as string[],
}))

vi.mock('@opengraphity/neo4j', () => ({
  // The database's side of the query: this run's rows of the label, after `$after`, in id order, `$batch` at most.
  runQuery: async (_session: unknown, text: string, params: Record<string, unknown>) => {
    fake.queries.push({ text, params })
    const label = /MATCH \(n:(\w+) \{tenant_id: \$tenantId\}\)/.exec(text)![1] as 'Incident' | 'KBArticle'
    fake.order.push(`read ${label}`)
    return fake.store[label]
      .filter((r) => r.id > String(params['after']))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, Number(params['batch']))
      .map((r) => ({ id: r.id, props: { ...r } }))
  },
}))
vi.mock('../../../aiSettings.js', () => ({
  aiFeatureEnabled: async (tenantId: string, feature: string) => { fake.asked.push([tenantId, feature]); return fake.enabled },
}))
vi.mock('../../../../jobs/embeddingWorker.js', () => ({
  ensureVectorIndexes: async () => { fake.order.push('indexes') },
}))
vi.mock('../../../../services/embeddings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../services/embeddings.js')>()
  return {
    ...real,
    getEmbedder: () => ({
      provider: 'local', model: 'test-minilm', dimensions: 3,
      embed: async (texts: string[]) => {
        fake.embedded.push(texts)
        fake.order.push('embed')
        return texts.map((t, i) => [t.length, i, 1])
      },
    }),
  }
})

const { embedDemoTenant } = await import('../embeddings.js')
const { incidentEmbeddingText, kbEmbeddingText } = await import('../../../../services/embeddings.js')

const session = {
  executeWrite: async (work: (tx: { run: (text: string, params: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
    work({ run: async (text, params) => { fake.writes.push({ text, params }); fake.order.push('write'); return { records: [] } } }),
} as unknown as Session

const TENANT = 'demo'
const RUN = 'seed@2026-09-23T10:00:00.000Z'

function run(): { logs: string[]; result: Promise<{ incidents: number; articles: number } | null> } {
  const logs: string[] = []
  return { logs, result: embedDemoTenant(session, TENANT, RUN, (m) => logs.push(m)) }
}

beforeEach(() => {
  fake.enabled = true
  fake.asked = []
  fake.store = { Incident: [], KBArticle: [] }
  fake.queries = []
  fake.embedded = []
  fake.writes = []
  fake.order = []
})

const INC_1: Row = { id: 'inc-1', title: 'Disk almost full on SRV_MIL_001', category: 'hardware', description: 'The data volume is at 97%.', created_at: '2026-09-01T10:00:00.000Z' }
const INC_2: Row = { id: 'inc-2', title: 'VPN does not connect', category: 'network', description: '', created_at: '2026-09-02T08:30:00.000Z' }
const KB_1: Row = {
  id: 'kb-1', title: 'Reset your password from the portal', category: 'how-to', tags: JSON.stringify(['password', 'account']),
  body: '1. Open the portal and choose «Forgot password».', created_at: '2026-06-10T09:00:00.000Z',
}

describe('D15: an organization that turned the embeddings off', () => {
  it('gets none: nothing is read, no index is made and the provider is never called', async () => {
    fake.enabled = false
    fake.store.Incident = [INC_1]
    const { logs, result } = run()
    expect(await result).toBeNull()
    expect(fake.asked).toEqual([[TENANT, 'embeddings']])
    expect(logs).toEqual(['embeddings: turned off for this organization, none computed'])
    expect(fake.order).toEqual([])
  })
})

describe('D15: what the run wrote is embedded as the worker does it', () => {
  it('with the worker\'s provider and texts, incidents first and then the articles', async () => {
    fake.store.Incident = [INC_2, INC_1]
    fake.store.KBArticle = [KB_1]
    const { logs, result } = run()
    expect(await result).toEqual({ incidents: 2, articles: 1 })
    expect(logs[0]).toBe('embeddings: local:test-minilm (3 dimensions)')
    // The canonical texts of the worker: title, category and description; for an article its tags and body too.
    expect(fake.embedded).toEqual([
      ['Disk almost full on SRV_MIL_001\nhardware\nThe data volume is at 97%.', 'VPN does not connect\nnetwork'],
      ['Reset your password from the portal\nhow-to\npassword account\n1. Open the portal and choose «Forgot password».'],
    ])
    expect(fake.embedded[0]).toEqual([incidentEmbeddingText(INC_1), incidentEmbeddingText(INC_2)])
    expect(fake.embedded[1]).toEqual([kbEmbeddingText(KB_1)])
  })

  it('the vector indexes exist before the first vector is written', async () => {
    fake.store.Incident = [INC_1]
    fake.store.KBArticle = [KB_1]
    await run().result
    expect(fake.order[0]).toBe('indexes')
    expect(fake.order).toEqual(['indexes', 'read Incident', 'embed', 'write', 'read Incident', 'read KBArticle', 'embed', 'write', 'read KBArticle'])
  })

  it('reads only this run\'s things of this tenant', async () => {
    fake.store.Incident = [INC_1]
    await run().result
    for (const q of fake.queries) {
      expect(q.text).toContain('{tenant_id: $tenantId}')
      expect(q.text).toContain('n.demo_run_id = $runId')
      expect(q.params).toMatchObject({ tenantId: TENANT, runId: RUN })
    }
    expect(fake.queries.map((q) => /MATCH \(n:(\w+)/.exec(q.text)![1])).toEqual(['Incident', 'Incident', 'KBArticle'])
  })

  it('writes the vector with the worker\'s procedure, the model as provider:model, and dates it seconds after the thing was written', async () => {
    fake.store.Incident = [INC_1, INC_2]
    fake.store.KBArticle = [KB_1]
    await run().result
    expect(fake.writes).toHaveLength(2)
    const [incidents, articles] = fake.writes
    for (const [w, label] of [[incidents!, 'Incident'], [articles!, 'KBArticle']] as const) {
      expect(w.text).toContain(`MATCH (n:${label} {id: row.id, tenant_id: $tenantId})`)
      expect(w.text).toContain('CALL db.create.setNodeVectorProperty(n, \'embedding\', row.vector)')
      expect(w.text).toContain('SET n.embedding_model = $model, n.embedded_at = row.at')
      expect(w.params).toMatchObject({ tenantId: TENANT, model: 'local:test-minilm' })
    }
    expect(incidents!.params['rows']).toEqual([
      { id: 'inc-1', vector: [incidentEmbeddingText(INC_1).length, 0, 1], at: '2026-09-01T10:00:05.000Z' },
      { id: 'inc-2', vector: [incidentEmbeddingText(INC_2).length, 1, 1], at: '2026-09-02T08:30:05.000Z' },
    ])
    expect(articles!.params['rows']).toEqual([{ id: 'kb-1', vector: [kbEmbeddingText(KB_1).length, 0, 1], at: '2026-06-10T09:00:05.000Z' }])
  })

  it('goes in batches of 256 in id order, each resuming after the last id, and says where it is every twenty batches', async () => {
    const n = 20 * 256 + 5
    fake.store.Incident = Array.from({ length: n }, (_, i) => ({
      id: `inc-${String(i).padStart(5, '0')}`, title: `Trouble ${String(i)}`, category: 'software', description: 'It broke.', created_at: '2026-09-01T10:00:00.000Z',
    }))
    const { logs, result } = run()
    expect(await result).toEqual({ incidents: n, articles: 0 })
    expect(fake.embedded.map((b) => b.length)).toEqual([...Array.from({ length: 20 }, () => 256), 5])
    const reads = fake.queries.filter((q) => q.text.includes('MATCH (n:Incident'))
    expect(reads.every((q) => q.params['batch'] === 256)).toBe(true)
    expect(reads.map((q) => q.params['after'])).toEqual(['', ...Array.from({ length: 21 }, (_, b) => `inc-${String(Math.min((b + 1) * 256, n) - 1).padStart(5, '0')}`)])
    // Every incident once, none twice.
    const written = fake.writes.flatMap((w) => (w.params['rows'] as Array<{ id: string }>).map((r) => r.id))
    expect(new Set(written).size).toBe(n)
    expect(written).toHaveLength(n)
    expect(logs.filter((l) => l.startsWith('embeddings: Incident'))).toEqual(['embeddings: Incident 5120'])
    // No articles: one read, nothing embedded for them.
    expect(fake.queries.filter((q) => q.text.includes('MATCH (n:KBArticle'))).toHaveLength(1)
  })
})

describe('D15: no silent hole in «Similar incidents»', () => {
  it('an incident with no text to embed stops the run, naming it, before its batch is written', async () => {
    fake.store.Incident = [INC_1, { id: 'inc-9', title: '', category: null, description: '', created_at: '2026-09-03T10:00:00.000Z' }]
    await expect(run().result).rejects.toThrow('Incident inc-9 has no embeddable text')
    expect(fake.embedded).toEqual([])
    expect(fake.writes).toEqual([])
  })

  it('so does an article', async () => {
    fake.store.KBArticle = [{ id: 'kb-7', title: '', category: '', tags: '[]', body: null, created_at: '2026-09-03T10:00:00.000Z' }]
    await expect(run().result).rejects.toThrow('KBArticle kb-7 has no embeddable text')
    expect(fake.writes).toEqual([])
  })
})
